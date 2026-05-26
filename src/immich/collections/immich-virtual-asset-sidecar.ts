import { VirtualFile } from "../../filesystem/virtual-file";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualContentBuffer, VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { getAssetMtime, ImmichAlbumBase } from "../utils/immich-api-utils";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME, buildAlbumMetadataUserYaml, buildAssetMetadataXMP as buildAssetMetadataXMP, saveAssetMetadataFileContent } from "../utils/immich-metadata-utils";
import { ImmichAsset } from "../utils/immich-api-utils";
import { deleteAssetFromContainer } from "../utils/immich-fs-utils";
import { ImmichSessionCache } from "../cache/immich-session-cache";
import { ImmichVirtualAssetFile } from "./immich-virtual-asset-file";
import { logger } from "../../logger";
import { readFileSync } from "fs";
import { config } from "../../config";
import fs from 'fs';
export class ImmichVirtualAssetSidecar extends VirtualFile
{

    private asset: ImmichAsset
    private file_system: ImmichFileSystem
    private parent_directory: VirtualDirectory
    private metadata_contents: string | null = null
    private _lastBuiltUpdatedAt: string | undefined

    constructor(asset: ImmichAsset, fsName: string, parent: VirtualDirectory, file_system: ImmichFileSystem)
    {
        super(fsName, getAssetMtime(asset), parent)
        this.parent_directory = parent
        this.file_system = file_system
        this.asset = asset

    }
    private async get_xmp()
    {
        const actual_asset = await this.file_system.getApi().FETCH_Asset(this.asset.id)
        try
        {
            if (config.enableLocalFiles)
            {
                const filepath = "/immich" + actual_asset.originalPath + ".xmp";
                const xmp_data = await fs.promises.readFile(filepath, 'utf8');
                this.metadata_contents = buildAssetMetadataXMP(actual_asset, xmp_data);
            }
            else
            {
                this.metadata_contents = buildAssetMetadataXMP(actual_asset, null);
            }
        }
        catch
        {
            this.metadata_contents = buildAssetMetadataXMP(actual_asset, null);
        }
        this._lastBuiltUpdatedAt = actual_asset.updatedAt;
        return this.metadata_contents ?? ""
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
        const meta = await this.get_xmp()
        return VirtualMetadata.file_rw(this.name, Buffer.byteLength(meta, 'utf8'), getAssetMtime(this.asset));
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        const meta = await this.get_xmp()
        return VirtualContentBufferUtils.bufferFromString(meta);
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        const content = contents.contents()
        const actual_asset = await this.file_system.getApi().FETCH_Asset(this.asset.id)
        await saveAssetMetadataFileContent(actual_asset, content, this.file_system.getApi());
        this.parent_directory.refresh()
        return true;
    }
    async event_delete(): Promise<boolean>
    {
        return true
    }
}

