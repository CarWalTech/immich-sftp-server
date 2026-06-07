import { VirtualContentBuffer, VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { logger } from "../../logger";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichVirtualFile } from "../immich-virtual-file";
import { getAssetMtime, ImmichAsset } from "../utils/immich-api-utils";
import { deleteAssetFromContainer } from "../utils/immich-fs-utils";
import { saveAssetMetadataFileContent } from "../utils/immich-metadata-utils";

export class ImmichAssetFile extends ImmichVirtualFile
{
    private asset: ImmichAsset
    private parent_directory: VirtualDirectory

    constructor(asset: ImmichAsset, fsName: string, parent: VirtualDirectory, file_system: ImmichFileSystem)
    {
        super(file_system, fsName, getAssetMtime(asset), parent)
        this.parent_directory = parent
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

export class ImmichAssetSidecarFile extends ImmichVirtualFile
{

    private asset: ImmichAsset;
    private parent_directory: VirtualDirectory;

    constructor(asset: ImmichAsset, fsName: string, parent: VirtualDirectory, file_system: ImmichFileSystem)
    {
        super(file_system, fsName, getAssetMtime(asset), parent);
        this.parent_directory = parent;
        this.asset = asset;

    }
    async event_setattr(attr: VirtualMetadata): Promise<boolean>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        return true;
    }
    async event_rename(new_name: string): Promise<boolean>
    {
        logger.error('ImmichVirtualAssetSidecar', 'Rename', 'Renaming sidecar files is not allowed');
        return false;
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        const meta = await this.file_system.getApi().FETCH_AssetXMP(this.asset.id);
        return VirtualMetadata.file_rw(this.name, Buffer.byteLength(meta, 'utf8'), getAssetMtime(this.asset));
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        const meta = await this.file_system.getApi().FETCH_AssetXMP(this.asset.id);
        return VirtualContentBufferUtils.bufferFromString(meta);
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        const content = contents.contents();
        const actual_asset = await this.file_system.getApi().FETCH_Asset(this.asset.id);
        await saveAssetMetadataFileContent(actual_asset, content, this.file_system.getApi());
        this.parent_directory.refresh();
        return true;
    }
    async event_delete(): Promise<boolean>
    {
        return true;
    }
}

export type ImmichAssetFileType = ImmichAssetFile | ImmichAssetSidecarFile;

