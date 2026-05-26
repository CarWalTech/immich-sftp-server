import { VirtualFile } from "../../filesystem/virtual-file";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { getAssetMtime, ImmichAlbumBase } from "../utils/immich-api-utils";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../utils/immich-metadata-utils";
import { ImmichAsset } from "../utils/immich-api-utils";
import { deleteAssetFromContainer } from "../utils/immich-fs-utils";
import { ImmichSessionCache } from "../cache/immich-session-cache";

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
        let size: number;

        if (api.getUserSettings().assetDownloadSource === 'preview')
        {
            // In preview mode report the preview image size so clients (e.g. Dolphin)
            // don't skip thumbnail generation due to a large original file size.
            size = await api.SERVER_GetAssetPreviewSize(this.asset);
            if (size === 0) size = this.asset.fileSizeInByte; // fallback if HEAD fails
        }
        else
        {
            // fileSizeInByte is 0 when Immich has no exifInfo for the asset.
            // Fall back to the download/info endpoint which asks Immich for the actual size.
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

