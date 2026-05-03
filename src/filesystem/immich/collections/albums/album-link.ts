import { VirtualFile } from "../../../common/virtual-file";
import { VirtualDirectory } from "../../../common/virtual-directory";
import { VirtualFsNode, VirtualFSNodeAttributes, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../../common/virtual-fs-node";
import { PathUtils } from "../../../utils/path-utils";
import { ImmichFileSystem } from "../../immich-file-system";
import { getAlbumMtime, ImmichAlbumBase } from "../../utils/immich-album-utils";
import { ImmichRootDirectory } from "./../root-directory";
import { ImmichAssetUtils } from "../../utils/immich-asset-utils";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../../metadata/immich-album-metadata";
import { FileResult } from "tmp";
import { FileUtils } from "../../../utils/file-utils";
import { buildAlbumBrowserLinkForAlbum } from "../../metadata/immich-album-metadata-service";
import { ImmichAlbumDirectoryInfo } from "./album-folder";

export class ImmichAlbumLinkFile extends VirtualFile
{
    private album: ImmichAlbumDirectoryInfo
    private file_system: ImmichFileSystem

    constructor(album: ImmichAlbumDirectoryInfo, fsName: string, parent: VirtualDirectory, file_system: ImmichFileSystem)
    {
        super(fsName, undefined, parent)
        this.file_system = file_system
        this.album = album
    }

    event_list_info(): VirtualFSNodeListInfo
    {
        const linkContent = buildAlbumBrowserLinkForAlbum(this.album, this.file_system.getUrl());
        return {
            name: ALBUM_BROWSER_LINK_FILE_NAME,
            isDir: false,
            size: Buffer.byteLength(linkContent, 'utf8'),
            mtime: getAlbumMtime(this.album),
        }
    }

    async event_stat(): Promise<VirtualFSNodeStats>
    {
        const link = buildAlbumBrowserLinkForAlbum(this.album, this.file_system.getUrl());
        return {
            isDir: false,
            size: Buffer.byteLength(link, 'utf8'),
            mtime: getAlbumMtime(this.album),
        };
    }

    async event_rename(new_name: string): Promise<boolean>
    {
        //Since this is virtual, ignore
        console.error('Renaming metadata files is not allowed');
        return true;
    }

    async event_setattr(attr: VirtualFSNodeAttributes): Promise<boolean>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        return true;
    }

    async event_readfile(): Promise<FileResult>
    {
        await this.file_system.getApi().fetchAssetsForAlbum(this.album);
        return FileUtils.createTmpFile(buildAlbumBrowserLinkForAlbum(this.album, this.file_system.getUrl()));
    }

    async event_writefile(contents: FileResult): Promise<boolean>
    {
        //Since this is virtual, reject
        return false;
    }

    async event_delete(): Promise<boolean>
    {
        //Since this is virtual, ignore
        return true;
    }

    async event_event_delete_from_parent(): Promise<boolean>
    {
        //Since this is virtual, ignore
        return true
    }
}