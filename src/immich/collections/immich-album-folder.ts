import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { ImmichFileSystem } from "../immich-file-system";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../utils/immich-metadata-utils";
import { ImmichVirtualAssetFile } from "./immich-virtual-asset-file";
import { ImmichAlbumsDirectory } from "./immich-albums-directory";
import { ImmichAlbumLinkFile } from "./immich-album-link";
import { FileResult } from "tmp";
import { ImmichRootUnsortedDirectory } from "./immich-root-commons";
import { config } from "../../config";
import { getDesecendantAlbums, collectAlbumAssets, ImmichAlbumsDirectoryNode } from "../utils/immich-api-utils";
import { ImmichAlbumDirectoryInfo } from '../utils/immich-api-utils';
import { canRecieveFileFrom, canSendFileTo } from "../utils/immich-fs-utils";
import { ImmichVirtualDirectory } from "./immich-virtual-directory";
import { logger } from "../../logger";
import { ImmichAlbumMetadataFile } from "./immich-album-metadata";

export class ImmichAlbumFolder extends ImmichVirtualDirectory 
{

    public static SEPERATOR = config.immichDefaults.subAlbumSeperator

    readonly albums_root: ImmichAlbumsDirectory;
    private node_data: ImmichAlbumsDirectoryNode;

    constructor(file_system: ImmichFileSystem, albums_root: ImmichAlbumsDirectory, parent: ImmichAlbumsDirectory | ImmichAlbumFolder, node: ImmichAlbumsDirectoryNode)
    {
        super(file_system, node.fsName, undefined, parent, { sendFn: canSendFileTo, recieveFn: canRecieveFileFrom, refreshOnMove: true, refreshOnReadDir: true })
        this.node_data = node
        this.albums_root = albums_root
    }

    public get_album_data()
    {
        return this.node_data
    }
    public get_album_realname()
    {
        let album_real_name;
        if (this.node_data.album) album_real_name = this.node_data.album.albumName
        else album_real_name = this.node_data.rawName
        return album_real_name
    }
    public get_album_fullname()
    {
        const segments = this.get_album_path();
        return segments.join(ImmichAlbumFolder.SEPERATOR);
    }
    public get_album_path(): string[]
    {
        if ((this.parent as ImmichAlbumsDirectory) !== undefined)
        {
            return [this.get_album_realname()]
        }
        else if ((this.parent as ImmichAlbumFolder) !== undefined)
        {
            return [...(this.parent as ImmichAlbumFolder).get_album_path(), this.get_album_realname()]
        }
        else throw Error("Can't figure out album path because the folder parents seem to be invalid")
    }

    async event_rename(new_name: string): Promise<boolean>
    {
        // 1. Compute old prefix
        const oldSegments = this.get_album_path();
        const oldPrefix = oldSegments.join(ImmichAlbumFolder.SEPERATOR);

        // 2. Compute new prefix
        const newSegments = [...oldSegments];
        newSegments.pop();
        newSegments.push(new_name);
        const newPrefix = newSegments.join(ImmichAlbumFolder.SEPERATOR);

        // 3. Collect all descendant albums
        const affected: ImmichAlbumDirectoryInfo[] = [];
        getDesecendantAlbums(this.node_data, affected);

        // 4. Rename each album
        for (const album of affected)
        {
            const suffix = album.albumName.slice(oldPrefix.length);
            const newFullName = newPrefix + suffix;

            await this.file_system.getApi().SERVER_RenameAlbum(album, newFullName);
        }
        this.refresh()
        return true;
    }
    async event_createfile(filename: string, contents: FileResult): Promise<boolean>
    {
        const album = this.node_data.album;

        if (!album)
        {
            logger.error('ImmichAlbumFolder', 'CreateFile', 'error', 'Cannot upload — this folder is virtual and has no album bound to it');
            return false;
        }

        await this.file_system.memory.push(filename, this.fullpath, contents, album)
        return true;
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(this.name, Math.floor(Date.now() / 1000))
    }
    async event_mkdir(folderName: string): Promise<boolean>
    {
        const segments = this.get_album_path();
        segments.push(folderName)
        const albumName = segments.join(ImmichAlbumFolder.SEPERATOR);
        await this.file_system.getApi().SERVER_CreateAlbum(albumName)
        this.refresh()
        return true
    }
    async event_delete(): Promise<boolean>
    {
        if (this.node_data.album)
            await this.file_system.getApi().SERVER_DeleteAlbum(this.node_data.album);
        this.refresh() //Think about how this is implemented
        return true
    }
    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        const new_result = await this.file_system.getApi().FETCH_VirtualAlbumBranch(this.node_data.path_id)
        if (!new_result) return new Map();
        else this.node_data = new_result

        var sub_folders = new Map([...this.node_data.children.values()].map(node => ([node.fsName, new ImmichAlbumFolder(this.file_system, this.albums_root, this, node) as VirtualNode])))
        if (this.node_data.album)
        {
            var metadata_files = new Map([
                [ALBUM_METADATA_FILE_NAME, new ImmichAlbumMetadataFile(this.node_data.album, ALBUM_METADATA_FILE_NAME, this, this.file_system) as VirtualNode],
                [ALBUM_BROWSER_LINK_FILE_NAME, new ImmichAlbumLinkFile(this.node_data.album, ALBUM_BROWSER_LINK_FILE_NAME, this, this.file_system) as VirtualNode]
            ])

            var reserved_names = Array.from(sub_folders.keys()).concat(Array.from(metadata_files.keys()))
            var assets = await collectAlbumAssets(this, new Set(reserved_names));
            var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualNode])))
            return new Map([...Array.from(sub_folders.entries()), ...Array.from(metadata_files.entries()), ...Array.from(asset_files.entries())]);
        }
        else
        {
            return sub_folders
        }
    }
    async event_sendnode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichVirtualAssetFile)
        {
            const asset = (item as ImmichVirtualAssetFile)
            const album = (this.node_data.album as ImmichAlbumDirectoryInfo)
            await this.file_system.getApi().SERVER_DeleteAssetFromAlbumOnly(album, asset.asset_id)
            return true
        }
        else
        {
            return false;
        }
    }
    async event_recievenode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichVirtualAssetFile)
        {
            const asset = (item as ImmichVirtualAssetFile)
            const album = (this.node_data.album as ImmichAlbumDirectoryInfo)
            await this.file_system.getApi().SERVER_AddAssetToAlbum(album, asset.asset_id)
            return true
        }
        else
        {
            return false;
        }
    }
}


