import path from "path";
import { VirtualContentBuffer, VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { logger } from "../../logger";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichVirtualFile } from "../immich-virtual-file";
import { getAssetMtime, ImmichAsset } from "../utils/immich-api-utils";
import { deleteAssetFromContainer } from "../utils/immich-fs-utils";
import { applyEmbeddedAssetMetadataWrite, EmbeddedMetadataWriteResult, embedXmpIntoImage, saveAssetMetadataFileContent } from "../utils/immich-metadata-utils";

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

        // Content bytes are always immutable; only the mode bits move when in-place
        // metadata edits are allowed, so clients don't refuse to open the file for saving.
        const meta = settings.assetAllowFileMetadataWrites
            ? VirtualMetadata.file_rw(this.name, size, getAssetMtime(this.asset))
            : VirtualMetadata.file_ro(this.name, size, getAssetMtime(this.asset));
        return meta;
    }

    async event_readfile(signal?: AbortSignal): Promise<VirtualContentBuffer>
    {
        const raw = await this.file_system.getApi().SERVER_ReadAsset(this.asset, signal);
        const settings = this.file_system.getApi().getUserSettings();
        if (!settings.assetEmbedMetadata) return raw;
        try
        {
            const xmp = await this.file_system.getApi().FETCH_AssetXMP(this.asset.id);
            return await embedXmpIntoImage(raw, xmp, path.extname(this.asset.originalFileName));
        }
        catch (err)
        {
            logger.warn('ImmichAssetFile', 'event_readfile', `XMP embed failed for ${this.asset.id}: ${err}`);
            return raw;
        }
    }

    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        const api = this.file_system.getApi();
        const settings = api.getUserSettings();
        if (!settings.assetAllowFileMetadataWrites)
        {
            logger.warn('ImmichAssetFile', 'event_writefile', `Blocked write to ${this.asset.id}: asset content is read-only. Edit the .xmp sidecar, or enable assetAllowFileMetadataWrites, to change metadata.`);
            return false;
        }

        const raw = await api.SERVER_ReadAsset(this.asset);
        // FETCH_AssetWithTags ensures current tags are correct even when the cache
        // entry was populated from a search result that omitted the tags field.
        const actual_asset = await api.FETCH_AssetWithTags(this.asset.id);

        let result: EmbeddedMetadataWriteResult;
        try
        {
            result = await applyEmbeddedAssetMetadataWrite(actual_asset, raw, contents, api);
        }
        catch (err)
        {
            if ((err as any)?.response?.status === 404)
            {
                // 404 typically means the asset is in a shared album owned by another
                // user — the current API key cannot update it.  Return success so rclone
                // does not mark the file dirty and retry in an infinite loop.
                logger.warn('ImmichAssetFile', 'event_writefile',
                    `Metadata write for asset ${actual_asset.id} returned 404 — asset may be owned by another user; update skipped`);
                return true;
            }
            throw err;
        }

        switch (result)
        {
            case 'content-changed':
                logger.warn('ImmichAssetFile', 'event_writefile', `Rejected write to ${this.asset.id}: the media stream itself changed. Only embedded-metadata edits are allowed; content changes are not synced back to Immich.`);
                return false;
            case 'unsupported-format':
                logger.warn('ImmichAssetFile', 'event_writefile', `Rejected write to ${this.asset.id}: file type not supported for in-place metadata verification.`);
                return false;
            case 'applied':
                api.CACHE_InvalidateAssetXMP(this.asset.id);
                this.parent_directory.refresh();
                return true;
        }
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
        const api = this.file_system.getApi();
        // FETCH_AssetWithTags ensures currentTagIds is correct even when the cache
        // entry was populated from a search result that omitted the tags field.
        const actual_asset = await api.FETCH_AssetWithTags(this.asset.id);
        try
        {
            await saveAssetMetadataFileContent(actual_asset, content, api);
        }
        catch (err)
        {
            if ((err as any)?.response?.status === 404)
            {
                // 404 typically means the asset is in a shared album owned by another
                // user — the current API key cannot update it.  Return success so rclone
                // does not mark the file dirty and retry in an infinite loop.  The XMP
                // cache is intentionally not invalidated so subsequent reads stay consistent.
                logger.warn('ImmichAssetSidecarFile', 'event_writefile',
                    `XMP write for asset ${actual_asset.id} returned 404 — asset may be owned by another user; metadata update skipped`);
                return true;
            }
            throw err;
        }
        // Mark tags stale and evict the XMP render so the next read re-fetches from
        // Immich.  Do NOT delete from assetInfoCache — that would hide the asset from
        // directory listings until the next album validation cycle.
        api.CACHE_InvalidateAssetXMP(this.asset.id);
        this.parent_directory.refresh();
        return true;
    }
    async event_delete(): Promise<boolean>
    {
        return true;
    }
}

export type ImmichAssetFileType = ImmichAssetFile | ImmichAssetSidecarFile;

