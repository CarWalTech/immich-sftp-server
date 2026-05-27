import { VirtualFile } from "../../filesystem/virtual-file";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { ImmichFileSystem } from "../immich-file-system";
import { getAssetMtime } from "../utils/immich-api-utils";
import { ImmichAsset } from "../utils/immich-api-utils";
import { deleteAssetFromContainer } from "../utils/immich-fs-utils";

export class ImmichVirtualAssetFile extends VirtualFile
{
    private asset: ImmichAsset
    private file_system: ImmichFileSystem
    private parent_directory: VirtualDirectory

    constructor(asset: ImmichAsset, fsName: string, parent: VirtualDirectory, file_system: ImmichFileSystem)
    {
        super(fsName, getAssetMtime(asset), parent)
        this.parent_directory = parent
        this.file_system = file_system
        this.asset = asset
    }

    get asset_data()
    {
        return this.asset
    }

    get asset_id()
    {
        return this.asset.id
    }

    get fs()
    {
        return this.file_system
    }

    async event_delete(): Promise<boolean>
    {
        return await deleteAssetFromContainer(this, this.file_system.getApi(), this.parent_directory)
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        const api = this.file_system.getApi();
        const settings = api.getUserSettings();
        let size: number;

        if (settings.assetDownloadSource === 'preview')
        {
            // In preview mode the download endpoint is /preview, not /original.
            // fileSizeInByte reflects the original source file and does NOT match
            // the actual transcoded preview bytes served.  Always resolve the real
            // preview byte-count (result is cached in assetFileSizeCache after the
            // first HEAD request, so warm-path calls are just a Map lookup).
            size = await api.SERVER_GetAssetFileSize(this.asset);
        }
        else
        {
            size = this.asset.fileSizeInByte > 0
                ? this.asset.fileSizeInByte
                : await api.SERVER_GetAssetFileSize(this.asset);
        }

        return VirtualMetadata.file_ro(this.name, size, getAssetMtime(this.asset));
    }

    async event_readfile(): Promise<VirtualContentBuffer>
    {
        return await this.file_system.getApi().SERVER_ReadAsset(this.asset)
    }
}

