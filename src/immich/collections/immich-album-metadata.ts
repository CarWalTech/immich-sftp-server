import { VirtualFile } from "../../filesystem/virtual-file";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { getAlbumMtime, ImmichAlbumBase } from "../utils/immich-api-utils";
import { ImmichRootDirectory } from "./immich-root-directory";
import { ImmichAssetUtils } from "../utils/immich-asset-utils";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../utils/immich-metadata-utils";
import tmp from 'tmp';
import { VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { saveAlbumMetadataFileContent, buildAlbumBrowserLinkForAlbum, buildAlbumMetadataYamlForAlbum } from "../utils/immich-metadata-utils";
import { ImmichAlbumFolder } from "./immich-album-folder";
import { ImmichAlbumDirectoryInfo } from '../utils/immich-api-utils';
import fs from 'fs';
import { logger } from "../../logger";

export class ImmichAlbumMetadataFile extends VirtualFile
{
    private album: ImmichAlbumDirectoryInfo
    private file_system: ImmichFileSystem
    private album_folder: ImmichAlbumFolder

    constructor(album: ImmichAlbumDirectoryInfo, fsName: string, parent: ImmichAlbumFolder, file_system: ImmichFileSystem)
    {
        super(fsName, undefined, parent)
        this.album_folder = parent
        this.file_system = file_system
        this.album = album
    }

    async event_setattr(attr: VirtualMetadata): Promise<boolean>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        return true;
    }
    async event_rename(new_name: string): Promise<boolean>
    {
        //Since this is virtual, ignore
        logger.error('ImmichAlbumMetadataFile', 'Rename', 'Renaming metadata files is not allowed');
        return false;
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        const metadata = buildAlbumMetadataYamlForAlbum(this.album, this.file_system.getCurrentUser(), this.file_system.getUrl());
        return VirtualMetadata.file_rw(this.name, Buffer.byteLength(metadata, 'utf8'), getAlbumMtime(this.album));
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        await this.file_system.getApi().FETCH_AssetsForAlbum(this.album, this.album_folder);
        return VirtualContentBufferUtils.bufferFromString(buildAlbumMetadataYamlForAlbum(this.album, this.file_system.getCurrentUser(), this.file_system.getUrl()));
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        const album = this.album
        const content = contents.contents()
        await this.file_system.getApi().FETCH_AssetsForAlbum(album, this.album_folder);
        await saveAlbumMetadataFileContent({
            album,
            content,
            currentUser: this.file_system.getCurrentUser(),
            baseUrl: this.file_system.getUrl(),
            immichAPI: this.file_system.getApi()
        });

        this.album_folder.refresh()
        return true;
    }
    async event_delete(): Promise<boolean>
    {
        //Since this is virtual, allow for it's removal without doing anything
        return true
    }
}