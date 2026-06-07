
import { VirtualContentBuffer, VirtualContentBufferUtils } from '../../filesystem/virtual-content-buffer';
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { VirtualNode } from "../../filesystem/virtual-node";
import { logger } from '../../logger';
import { DateUtils } from "../../utils/date-utils";
import { ImmichAssetFile } from '../files/immich-asset-file';
import { ImmichWebLinkFile } from "../files/immich-web-link-file";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichVirtualDirectory } from "../immich-virtual-directory";
import { ImmichVirtualFile } from '../immich-virtual-file';
import { getAlbumMtime, getDesecendantAlbums, ImmichAlbumDirectoryInfo, ImmichAlbumsDirectoryNode } from '../utils/immich-api-utils';
import { canRecieveFileFrom, canSendFileTo, DIRNAME_ALBUMS, FILENAME_ALBUM_PROPERTIES } from "../utils/immich-fs-utils";
import { buildAlbumBrowserLink, buildAlbumMetadataUserYaml, saveAlbumMetadataFileContent } from "../utils/immich-metadata-utils";
import { ImmichRootDirectory } from "./immich-root-directory";

export class ImmichAlbumsDirectory extends ImmichVirtualDirectory
{
    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super(file_system, DIRNAME_ALBUMS, undefined, root, { refreshOnReadDir: true })
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_ro(this.name, DateUtils.getTimestampNow())
    }
    async event_mkdir(albumName: string): Promise<boolean>
    {
        await this.file_system.getApi().SERVER_CreateAlbum(albumName)
        this.refresh()
        return true
    }
    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        const current_file_tree = await this.file_system.getApi().FETCH_AlbumVirtualTree();
        if (!current_file_tree) return new Map()
        return new Map([...current_file_tree.children.values()].map(node => ([node.fsName, new ImmichAlbumFolder(this.file_system, this, this, node)])))
    }
}

export class ImmichAlbumFolder extends ImmichVirtualDirectory
{
    readonly albums_root: ImmichAlbumsDirectory;
    private node_data: ImmichAlbumsDirectoryNode;

    constructor(file_system: ImmichFileSystem, albums_root: ImmichAlbumsDirectory, parent: ImmichAlbumsDirectory | ImmichAlbumFolder, node: ImmichAlbumsDirectoryNode)
    {
        super(file_system, node.fsName, undefined, parent, { sendFn: canSendFileTo, recieveFn: canRecieveFileFrom, refreshOnMove: true, refreshOnReadDir: true });
        this.node_data = node;
        this.albums_root = albums_root;
    }

    public get_album_data()
    {
        return this.node_data;
    }
    public get_album_realname()
    {
        return this.node_data.rawName;
    }
    public get_album_seperator()
    {
        return this.file_system.getApi().getUserSettings().subAlbumSeperator;
    }
    public get_album_fullname()
    {
        const segments = this.get_album_path();
        return segments.join(this.get_album_seperator());
    }
    public get_album_path(): string[]
    {
        if (this.parent instanceof ImmichAlbumsDirectory)
        {
            return [this.get_album_realname()];
        }

        if (this.parent instanceof ImmichAlbumFolder)
        {
            return [...this.parent.get_album_path(), this.get_album_realname()];
        }

        throw new Error("Invalid album folder parent");

    }
    public get_album_modtime()
    {
        if (this.node_data.album)
        {
            return getAlbumMtime(this.node_data.album);
        }

        return DateUtils.getDateNow();
    }

    async event_rename(new_name: string): Promise<boolean>
    {
        const separator = this.get_album_seperator();

        // 1. Compute the old path segments for THIS album
        const oldSegments = this.get_album_path();
        const newSegments = [...oldSegments];
        newSegments[newSegments.length - 1] = new_name;

        // 2. Compute the new full name for THIS album
        const newFullName = newSegments.join(separator);

        // 3. Collect all descendant albums (including this one)
        const affected: ImmichAlbumDirectoryInfo[] = [];
        getDesecendantAlbums(this.node_data, affected);

        // 4. Rename each album based on segment replacement
        for (const album of affected)
        {
            // Get the descendant's current path segments
            const descendantSegments = album.albumName.split(separator);

            // Replace the prefix (oldSegments) with the new prefix (newSegments)
            const updatedSegments = [
                ...newSegments,
                ...descendantSegments.slice(oldSegments.length)
            ];

            const updatedFullName = updatedSegments.join(separator);

            await this.file_system.getApi().SERVER_RenameAlbum(album, updatedFullName);
        }

        // 5. Refresh this folder
        this.refresh();
        return true;
    }
    async event_createfile(filename: string, contents: VirtualContentBuffer): Promise<boolean>
    {
        const album = this.node_data.album;

        if (!album)
        {
            logger.error('ImmichAlbumFolder', 'CreateFile', 'error', 'Cannot upload — this folder is virtual and has no album bound to it');
            return false;
        }

        await this.file_system.memory.push(filename, this.fullpath, contents, album);
        this.file_system.invalidatePath(this.fullpath);
        super.refresh();
        return true;
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(this.name, this.get_album_modtime());
    }
    async event_mkdir(folderName: string): Promise<boolean>
    {
        const segments = this.get_album_path();
        segments.push(folderName);
        const albumName = segments.join(this.get_album_seperator());
        await this.file_system.getApi().SERVER_CreateAlbum(albumName);
        this.refresh();
        return true;
    }
    async event_delete(): Promise<boolean>
    {
        if (this.node_data.album)
            await this.file_system.getApi().SERVER_DeleteAlbum(this.node_data.album);
        this.refresh(); //Think about how this is implemented
        return true;
    }
    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        const new_result = await this.file_system.getApi().FETCH_AlbumVirtualBranch(this.node_data.path_id);
        if (!new_result) return new Map();
        else this.node_data = new_result;

        var sub_folders = new Map([...this.node_data.children.values()].map(node => ([node.fsName, new ImmichAlbumFolder(this.file_system, this.albums_root, this, node) as VirtualNode])));
        if (this.node_data.album)
        {
            var metadata_files = new Map<string, VirtualNode>([]);

            if (this.file_system.getUserSettings().enableAlbumLinks)
            {
                const link = new ImmichAlbumLinkFile(this.node_data.album, this, this.file_system);
                metadata_files.set(link.name, link as VirtualNode)
            }
            if (this.file_system.getUserSettings().enableAlbumMetadata)
            {
                const metadata = new ImmichAlbumMetadataFile(this.node_data.album, this, this.file_system);
                metadata_files.set(metadata.name, metadata as VirtualNode)
            }

            var reserved_names = Array.from(sub_folders.keys()).concat(Array.from(metadata_files.keys()));
            var assets = await this.file_system.getApi().FETCH_AssetsForAlbum(this.node_data.album, this, new Set(reserved_names));
            var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualNode])));
            return new Map([
                ...Array.from(sub_folders.entries()),
                ...Array.from(metadata_files.entries()),
                ...Array.from(asset_files.entries())
            ]);
        }

        else
        {
            return sub_folders;
        }
    }
    async event_sendnode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichAssetFile)
        {
            const asset = (item as ImmichAssetFile);
            const album = (this.node_data.album as ImmichAlbumDirectoryInfo);
            await this.file_system.getApi().SERVER_DeleteAssetFromAlbumOnly(album, asset.asset_id);
            this.file_system.invalidatePath(this.fullpath);
            return true;
        }

        else
        {
            return false;
        }
    }
    async event_recievenode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichAssetFile)
        {
            const asset = (item as ImmichAssetFile);
            if (this.get_album_data().album)
            {
                const album = (this.node_data.album as ImmichAlbumDirectoryInfo);
                await this.file_system.getApi().SERVER_AddAssetToAlbum(album.id, asset.asset_id);
            }

            else
            {
                const albumId = await this.file_system.getApi().SERVER_CreateAlbum(this.get_album_fullname());
                await this.file_system.getApi().SERVER_AddAssetToAlbum(albumId, asset.asset_id);
            }
            // Drop cached asset list and force _child_nodes rebuild so the
            // destination shows the newly received file immediately.
            this.file_system.invalidatePath(this.fullpath);
            super.refresh();
            return true;
        }

        else
        {
            return false;
        }
    }
    refresh()
    {
        super.refresh();
    }
}

export class ImmichAlbumLinkFile extends ImmichWebLinkFile
{
    private album: ImmichAlbumDirectoryInfo;
    private album_folder: ImmichAlbumFolder;

    constructor(album: ImmichAlbumDirectoryInfo, parent: ImmichAlbumFolder, file_system: ImmichFileSystem)
    {
        super(parent, file_system);
        this.album_folder = parent;
        this.album = album;
    }

    async event_buildlink()
    {
        return buildAlbumBrowserLink(this.album, this.file_system.getUrl());
    }

    async event_getmodtime()
    {
        return getAlbumMtime(this.album);
    }

    async event_readlink()
    {
        await this.file_system.getApi().FETCH_AssetsForAlbum(this.album, this.album_folder);
        return buildAlbumBrowserLink(this.album, this.file_system.getUrl());
    }
}

export class ImmichAlbumMetadataFile extends ImmichVirtualFile
{
    private album: ImmichAlbumDirectoryInfo;
    private album_folder: ImmichAlbumFolder;

    constructor(album: ImmichAlbumDirectoryInfo, parent: ImmichAlbumFolder, file_system: ImmichFileSystem)
    {
        super(file_system, FILENAME_ALBUM_PROPERTIES, undefined, parent);
        this.album_folder = parent;
        this.album = album;
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
        const metadata = buildAlbumMetadataUserYaml(this.album, this.file_system.getCurrentUser(), this.file_system.getUrl());
        return VirtualMetadata.file_rw(this.name, Buffer.byteLength(metadata, 'utf8'), getAlbumMtime(this.album));
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        await this.file_system.getApi().FETCH_AssetsForAlbum(this.album, this.album_folder);
        return VirtualContentBufferUtils.bufferFromString(buildAlbumMetadataUserYaml(this.album, this.file_system.getCurrentUser(), this.file_system.getUrl()));
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        const album = this.album;
        const content = contents.contents();
        await this.file_system.getApi().FETCH_AssetsForAlbum(album, this.album_folder);
        await saveAlbumMetadataFileContent({
            album,
            content,
            currentUser: this.file_system.getCurrentUser(),
            baseUrl: this.file_system.getUrl(),
            immichAPI: this.file_system.getApi()
        });

        this.album_folder.refresh();
        return true;
    }
    async event_delete(): Promise<boolean>
    {
        //Since this is virtual, allow for it's removal without doing anything
        return true;
    }
}



