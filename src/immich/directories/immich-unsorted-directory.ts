
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { VirtualNode } from "../../filesystem/virtual-node";
import { ImmichAssetFile } from "../files/immich-asset-file";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichVirtualDirectory } from "../immich-virtual-directory";
import { canRecieveFileFrom, canSendFileTo, DIRNAME_UNSORTED } from "../utils/immich-fs-utils";
import { ImmichRootDirectory } from "./immich-root-directory";

export class ImmichRootUnsortedDirectory extends ImmichVirtualDirectory
{
    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super(file_system, DIRNAME_UNSORTED, undefined, root, { sendFn: canSendFileTo, recieveFn: canRecieveFileFrom, refreshOnMove: true, refreshOnReadDir: true })
    }
    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        var assets = await this.file_system.getApi().FETCH_AssetsForNonAlbums(this, new Set());
        var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualNode])))
        return asset_files;
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(this.name, this.mtime)
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
        if (item instanceof ImmichAssetFile)
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
        if (item instanceof ImmichAssetFile)
        {
            const asset = (item as ImmichAssetFile)
            await this.file_system.getApi().SERVER_AddAssetToUnsorted(asset.asset_id)
            return true
        }
        else
        {
            return false;
        }
    }
}

