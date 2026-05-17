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
import { VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { buildAlbumBrowserLinkForAlbum } from "../utils/immich-metadata-utils";
import { ImmichAlbumDirectoryInfo } from '../utils/immich-api-utils';
import { logger } from "../../logger";
import { ImmichAlbumFolder } from "./immich-album-folder";

export class ImmichAlbumLinkFile extends VirtualFile
{
    private album: ImmichAlbumDirectoryInfo
    private file_system: ImmichFileSystem
    private album_folder: ImmichAlbumFolder

    constructor(album: ImmichAlbumDirectoryInfo, fsName: string, parent: ImmichAlbumFolder, file_system: ImmichFileSystem)
    {
        super(fsName, undefined, parent)
        this.file_system = file_system
        this.album_folder = parent
        this.album = album
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        const link = buildAlbumBrowserLinkForAlbum(this.album, this.file_system.getUrl());
        return VirtualMetadata.file_ro(this.name, Buffer.byteLength(link, 'utf8'), getAlbumMtime(this.album));
    }
    async event_rename(new_name: string): Promise<boolean>
    {
        //Since this is virtual, ignore
        logger.error('ImmichAlbumLinkFile', 'Rename', 'Renaming metadata files is not allowed');
        return false;
    }
    async event_setattr(attr: VirtualMetadata): Promise<boolean>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        return true;
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        await this.file_system.getApi().FETCH_AssetsForAlbum(this.album, this.album_folder);
        return VirtualContentBufferUtils.bufferFromString(buildAlbumBrowserLinkForAlbum(this.album, this.file_system.getUrl()));
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        //Since this is virtual, reject
        return false;
    }
    async event_delete(): Promise<boolean>
    {
        //Since this is virtual, ignore
        return false;
    }
}