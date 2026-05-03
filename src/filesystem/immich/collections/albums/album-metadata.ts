import { VirtualFile } from "../../../common/virtual-file";
import { VirtualDirectory } from "../../../common/virtual-directory";
import { VirtualFsNode, VirtualFSNodeAttributes, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../../common/virtual-fs-node";
import { PathUtils } from "../../../utils/path-utils";
import { ImmichFileSystem } from "../../immich-file-system";
import { getAlbumMtime, ImmichAlbumBase } from "../../utils/immich-album-utils";
import { ImmichRootDirectory } from "./../root-directory";
import { ImmichAssetUtils } from "../../utils/immich-asset-utils";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../../metadata/immich-album-metadata";
import tmp from 'tmp';
import { FileUtils } from "../../../utils/file-utils";
import { applyAlbumMetadataFileContent, buildAlbumBrowserLinkForAlbum, buildAlbumMetadataYamlForAlbum } from "../../metadata/immich-album-metadata-service";
import { ImmichAlbumDirectoryInfo, ImmichAlbumFolder } from "./album-folder";
import fs from 'fs';

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

    event_list_info(): VirtualFSNodeListInfo
    {
        const metadataContent = buildAlbumMetadataYamlForAlbum(this.album, this.file_system.getCurrentUser(), this.file_system.getUrl());
        return {
            name: ALBUM_METADATA_FILE_NAME,
            isDir: false,
            size: Buffer.byteLength(metadataContent, 'utf8'),
            mtime: getAlbumMtime(this.album),
        }
    }

    async event_setattr(attr: VirtualFSNodeAttributes): Promise<boolean>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        return true;
    }

    async event_rename(new_name: string): Promise<boolean>
    {
        //Since this is virtual, ignore
        console.error('Renaming metadata files is not allowed');
        return true;
    }

    async event_stat(): Promise<VirtualFSNodeStats>
    {
        const metadata = buildAlbumMetadataYamlForAlbum(this.album, this.file_system.getCurrentUser(), this.file_system.getUrl());
        return {
            isDir: false,
            size: Buffer.byteLength(metadata, 'utf8'),
            mtime: getAlbumMtime(this.album),
        };
    }

    async event_readfile(): Promise<tmp.FileResult>
    {
        await this.file_system.getApi().fetchAssetsForAlbum(this.album);
        return FileUtils.createTmpFile(buildAlbumBrowserLinkForAlbum(this.album, this.file_system.getUrl()));
    }

    async event_writefile(contents: tmp.FileResult): Promise<boolean>
    {
        const album = this.album
        await this.file_system.getApi().fetchAssetsForAlbum(album);
        const content = fs.readFileSync(contents.name, 'utf8');
        contents.removeCallback();
        await applyAlbumMetadataFileContent({
            album,
            content,
            currentUser: this.file_system.getCurrentUser(),
            baseUrl: this.file_system.getUrl(),
            immichAPI: this.file_system.getApi(),
            refreshAlbumAssets: (targetAlbum) => this.file_system.getApi().fetchAssetsForAlbum(targetAlbum),
        });

        this.album_folder.event_refetch()
        return true;
    }

    async event_delete(): Promise<boolean>
    {
        //Since this is virtual, allow for it's removal without doing anything
        return true
    }


    async event_event_delete_from_parent(): Promise<boolean>
    {
        //Since this is virtual, allow for it's removal without doing anything
        return true
    }
}