import { VirtualMetadata } from "../../filesystem/virtual-metadata";
import { VirtualNode } from "../../filesystem/virtual-node";
import { Timestamp } from "../../utils/date-utils";
import { ImmichAssetFile } from "../files/immich-asset-file";
import { ImmichWebLinkFile } from "../files/immich-web-link-file";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichVirtualDirectory } from "../immich-virtual-directory";
import { DIRNAME_TRASH, canRecieveFileFrom, canSendFileTo } from "../utils/immich-fs-utils";
import { generateTrashBrowserLink } from "../utils/immich-metadata-utils";
import { ImmichRootDirectory } from "./immich-root-directory";

export class ImmichRootTrashDirectory extends ImmichVirtualDirectory
{
    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super(file_system, DIRNAME_TRASH, undefined, root, { sendFn: canSendFileTo, recieveFn: canRecieveFileFrom, refreshOnMove: true, refreshOnReadDir: true });
    }
    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        var metadata_files = new Map<string, VirtualNode>([]);

        if (this.file_system.getUserSettings().enableTrashLink)
        {
            const metadata = new ImmichTrashLinkFile(this, this.file_system);
            metadata_files.set(metadata.name, metadata as VirtualNode)
        }

        var assets = await this.file_system.getApi().FETCH_AssetsForTrash(this, new Set());
        var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualNode])));
        return new Map([
            ...Array.from(metadata_files.entries()),
            ...Array.from(asset_files.entries())
        ]);
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(this.name, this.mtime);
    }
    async event_mkdir(filename: string): Promise<boolean>
    {
        return false;
    }
    async event_sendnode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichAssetFile)
        {
            const asset = (item as ImmichAssetFile);
            await this.file_system.getApi().SERVER_RestoreAsset(asset.asset_id);
            return true;
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
            const asset = (item as ImmichAssetFile);
            await this.file_system.getApi().SERVER_DeleteAsset(asset.asset_data);
            return true;
        }

        else
        {
            return false;
        }
    }
}
export class ImmichTrashLinkFile extends ImmichWebLinkFile
{
    constructor(parent: ImmichRootTrashDirectory, file_system: ImmichFileSystem)
    {
        super(parent, file_system);
    }

    async event_buildlink()
    {
        return generateTrashBrowserLink(this.file_system.getUrl());
    }

    async event_getmodtime()
    {
        return Timestamp.now();
    }

    async event_readlink()
    {
        return generateTrashBrowserLink(this.file_system.getUrl());
    }
}

