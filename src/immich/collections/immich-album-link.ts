import { VirtualFile } from "../../filesystem/virtual-file";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { getAlbumMtime, ImmichAlbumBase } from "../utils/immich-api-utils";
import { ImmichRootDirectory } from "./immich-root-directory";
import { VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { buildAlbumBrowserLink } from "../utils/immich-metadata-utils";
import { ImmichAlbumDirectoryInfo } from '../utils/immich-api-utils';
import { logger } from "../../logger";
import { ImmichAlbumFolder } from "./immich-album-folder";
import { ImmichWebLinkFile } from "./immich-web-link";

export class ImmichAlbumLinkFile extends ImmichWebLinkFile
{
    private album: ImmichAlbumDirectoryInfo
    private album_folder: ImmichAlbumFolder

    constructor(album: ImmichAlbumDirectoryInfo, parent: ImmichAlbumFolder, file_system: ImmichFileSystem)
    {
        super(parent, file_system)
        this.album_folder = parent
        this.album = album
    }

    async event_buildlink()
    {
        return buildAlbumBrowserLink(this.album, this.file_system.getUrl())
    }

    async event_getmodtime()
    {
        return getAlbumMtime(this.album)
    }

    async event_readlink()
    {
        await this.file_system.getApi().FETCH_AssetsForAlbum(this.album, this.album_folder);
        return buildAlbumBrowserLink(this.album, this.file_system.getUrl())
    }
}