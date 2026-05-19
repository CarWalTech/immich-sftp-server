
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichRootDirectory } from "./immich-root-directory";
import { ImmichVirtualAssetFile } from "./immich-virtual-asset-file";
import { canRecieveFileFrom, canSendFileTo } from "../utils/immich-fs-utils";
import { ImmichVirtualDirectory } from "./immich-virtual-directory";
import { DateUtils } from "../../utils/date-utils";

export class ImmichRootUnsortedDirectory extends ImmichVirtualDirectory
{
    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super(file_system, "unsorted", undefined, root, { sendFn: canSendFileTo, recieveFn: canRecieveFileFrom, refreshOnMove: true, refreshOnReadDir: true })
    }
    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        var assets = await this.file_system.getApi().FETCH_AssetsForNonAlbums(this, new Set());
        var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualNode])))
        return asset_files;
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(this.name, DateUtils.getTimestampNow())
    }
    async event_mkdir(filename: string): Promise<boolean>
    {
        return false
    }
    async event_createfile(name: string, contents: VirtualContentBuffer): Promise<boolean>
    {
        await this.file_system.memory.push(name, this.fullpath, contents)
        return true;
    }
    async event_sendnode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichVirtualAssetFile)
        {
            //No need to do anything special to the item before it's move
            return true
        }
        else
        {
            return false;
        }
    }
    async event_recievenode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichVirtualAssetFile)
        {
            const asset = (item as ImmichVirtualAssetFile)
            await this.file_system.getApi().SERVER_AddAssetToUnsorted(asset.asset_id)
            return true
        }
        else
        {
            return false;
        }
    }
}

export class ImmichRootTrashDirectory extends ImmichVirtualDirectory
{
    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super(file_system, "trash", undefined, root, { sendFn: canSendFileTo, recieveFn: canRecieveFileFrom, refreshOnMove: true, refreshOnReadDir: true })
    }
    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        var assets = await this.file_system.getApi().FETCH_AssetsForTrash(this, new Set());
        var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualNode])))
        return asset_files;
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(this.name)
    }
    async event_mkdir(filename: string): Promise<boolean>
    {
        return false
    }
    async event_sendnode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichVirtualAssetFile)
        {
            const asset = (item as ImmichVirtualAssetFile)
            await this.file_system.getApi().SERVER_RestoreAsset(asset.asset_id)
            return true
        }
        else
        {
            return false;
        }
    }
    async event_recievenode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichVirtualAssetFile)
        {
            const asset = (item as ImmichVirtualAssetFile)
            await this.file_system.getApi().SERVER_DeleteAsset(asset.asset_data)
            return true
        }
        else
        {
            return false;
        }
    }
}