import { VirtualDirectory, VirtualDirectoryMoveValidatorMode } from "../../../common/virtual-directory";
import { VirtualFsNode, VirtualFSNodeAttributes, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../../common/virtual-fs-node";
import { PathUtils } from "../../../utils/path-utils";
import { ImmichFileSystem } from "../../immich-file-system";
import { ImmichAlbumBase } from "../../utils/immich-album-utils";
import { ImmichRootDirectory } from "../root-directory";
import { ImmichAssetUtils } from "../../utils/immich-asset-utils";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../../metadata/immich-album-metadata";
import { ImmichAsset, ImmichAssetFile } from "../asset-file";
import { ImmichAlbumsDirectory } from "./albums-directory";
import { ImmichAlbumMetadataFile } from "./album-metadata";
import { ImmichAlbumLinkFile } from "./album-link";
import { FileResult } from "tmp";
import { ImmichUploadQueueItem } from "../../immich-api";
import { ImmichUnsortedDirectory } from "../unsorted-directory";

export class ImmichAlbumFolder extends VirtualDirectory
{

    public static SEPERATOR = " / "

    private file_system: ImmichFileSystem;
    private albums_root: ImmichAlbumsDirectory;
    private node_data: ImmichAlbumsDirectoryNode;

    constructor(file_system: ImmichFileSystem, albums_root: ImmichAlbumsDirectory, parent: ImmichAlbumsDirectory | ImmichAlbumFolder, node: ImmichAlbumsDirectoryNode)
    {
        super(node.fsName, undefined, parent)
        this.node_data = node
        this.albums_root = albums_root
        this.file_system = file_system
    }

    isVirtual()
    {
        return this.node_data.album == undefined
    }

    async get_assets(reserved_names: Set<string>): Promise<ImmichAssetFile[]>
    {
        if (!this.node_data.album) return [];

        const album = this.node_data.album;
        await this.file_system.getApi().fetchAssetsForAlbum(album);

        const assets = album.assets ?? [];
        const files = new Array<ImmichAssetFile>(assets.length);

        // Track collisions for asset filenames
        const nameCount = new Map<string, number>();

        for (let i = 0; i < assets.length; i++)
        {
            const asset = assets[i];

            let base = asset.originalFileName;

            // If the base name is reserved, force collision logic immediately
            if (reserved_names.has(base))
            {
                const count = nameCount.get(base) ?? 0;
                nameCount.set(base, count + 1);
                base = `${base} (${count + 1})`;
            }

            // Now ensure uniqueness among assets
            let finalName = base;
            let count = nameCount.get(finalName) ?? 0;

            if (count > 0)
            {
                // Already used — increment until unique
                do
                {
                    count++;
                    finalName = `${base} (${count})`;
                } while (reserved_names.has(finalName));
            }

            nameCount.set(base, count + 1);

            files[i] = new ImmichAssetFile(asset, finalName, this, this.file_system);
        }

        return files;
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
        ImmichAlbumsDirectoryUtils.collect_descendant_albums(this.node_data, affected);

        // 4. Rename each album
        for (const album of affected)
        {
            const suffix = album.albumName.slice(oldPrefix.length);
            const newFullName = newPrefix + suffix;

            await this.file_system.getApi().SERVER_RenameAlbum(album, newFullName);
        }
        this.event_refetch()
        return true;
    }
    async event_createfile(filename: string, contents: FileResult): Promise<boolean>
    {
        if (!this.node_data.album)
        {
            console.error("Can't add images to virtual albums yet!")
            return false
        }

        const full_name = this.fullpath + "/" + filename;
        const data: ImmichUploadQueueItem = {
            filename: full_name,
            tmpFile: contents,
            uploadToAlbum: this.node_data.album
        }
        await this.file_system.getApi().QUEUE_UploadFile_v2(data, Math.floor(Date.now() / 1000))
        this.event_refetch()
        return true
    }
    async event_stat(): Promise<VirtualFSNodeStats>
    {
        return {
            isDir: true,
            size: 0,
            mtime: Math.floor(Date.now() / 1000),
        };
    }
    async event_mkdir(folderName: string): Promise<boolean>
    {
        const segments = this.get_album_path();
        segments.push(folderName)
        const albumName = segments.join(ImmichAlbumFolder.SEPERATOR);
        await this.file_system.getApi().SERVER_CreateAlbum(albumName)
        this.event_refetch()
        return true
    }
    async event_delete(): Promise<boolean>
    {
        if (this.node_data.album)
            await this.file_system.getApi().SERVER_DeleteAlbum(this.node_data.album);
        this.event_refetch()
        return true
    }
    async event_rebuild(): Promise<Map<string, VirtualFsNode>>
    {
        var sub_folders = new Map([...this.node_data.children.values()].map(node => ([node.fsName, new ImmichAlbumFolder(this.file_system, this.albums_root, this, node) as VirtualFsNode])))
        if (this.node_data.album)
        {
            var metadata_files = new Map([
                [ALBUM_METADATA_FILE_NAME, new ImmichAlbumMetadataFile(this.node_data.album, ALBUM_METADATA_FILE_NAME, this, this.file_system) as VirtualFsNode],
                [ALBUM_BROWSER_LINK_FILE_NAME, new ImmichAlbumLinkFile(this.node_data.album, ALBUM_BROWSER_LINK_FILE_NAME, this, this.file_system) as VirtualFsNode]
            ])

            var reserved_names = Array.from(sub_folders.keys()).concat(Array.from(metadata_files.keys()))
            var assets = await this.get_assets(new Set(reserved_names));
            var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualFsNode])))
            return new Map([...Array.from(sub_folders.entries()), ...Array.from(metadata_files.entries()), ...Array.from(asset_files.entries())]);
        }
        else
        {
            return sub_folders
        }
    }
    async event_moveitem(item: VirtualFsNode, destination: VirtualDirectory): Promise<boolean>
    {
        const result = super.event_moveitem(item, destination)
        this.event_refetch()
        return result
    }
    async event_moveitem_depart(item: VirtualFsNode): Promise<boolean>
    {
        if (item instanceof ImmichAssetFile)
        {
            const asset = (item as ImmichAssetFile)
            const album = (this.node_data.album as ImmichAlbumDirectoryInfo)
            await this.file_system.getApi().SERVER_RemoveAssetFromAlbum(album, asset.asset_id)
            return true
        }
        else
        {
            return false;
        }
    }
    async event_moveitem_arrive(item: VirtualFsNode): Promise<boolean>
    {
        if (item instanceof ImmichAssetFile)
        {
            const asset = (item as ImmichAssetFile)
            const album = (this.node_data.album as ImmichAlbumDirectoryInfo)
            await this.file_system.getApi().SERVER_AddAssetToAlbum(album, asset.asset_id)
            return true
        }
        else
        {
            return false;
        }
    }
    public event_moveitem_isSendable(item: VirtualFsNode, container: VirtualDirectory): boolean
    {
        if (item instanceof ImmichAlbumFolder)
        {
            console.error("Can't move album directories yet!")
            return false;
        }
        else if (item instanceof ImmichAssetFile)
        {
            if (container instanceof ImmichAlbumFolder)
            {
                if (container.node_data.album)
                {
                    return true
                }
                else
                {
                    console.error("Can't move files from virtual albums yet!")
                    return false
                }
            }
            else if (container instanceof ImmichUnsortedDirectory)
            {
                return true
            }
            else
            {
                console.error("Unsupported Destination Container for Move")
                return false;
            }
        }
        else
        {
            console.error("Unsupported Item for Move")
            return false;
        }
    }
    public event_moveitem_isRecievable(item: VirtualFsNode, container: VirtualDirectory): boolean
    {
        if (item instanceof ImmichAssetFile)
        {
            if (container instanceof ImmichAlbumFolder)
            {
                if (container.node_data.album)
                {
                    return true
                }
                else
                {
                    console.error("Can't recieve files from virtual albums yet!")
                    return false
                }
            }
            else if (container instanceof ImmichUnsortedDirectory)
            {
                return true;
            }
            else
            {
                console.error("Unsupported Source Container for Move")
                return false;
            }
        }
        else
        {
            console.error("Unsupported Item for Move")
            return false;
        }
    }

    public event_list_info(): VirtualFSNodeListInfo
    {
        return {
            name: this.name,
            isDir: true,
            size: 0,
            mtime: Math.floor(Date.now() / 1000),
        }
    }
    public event_refetch()
    {
        this.albums_root.event_refetch()
    }



}

export interface ImmichAlbumDirectoryInfo extends ImmichAlbumBase
{
    assets?: ImmichAsset[];
    displayName?: string;
}

export interface ImmichAlbumsDirectoryNode
{
    rawName: string;     // original segment from albumName
    fsName: string;      // normalized displayName segment
    children: Map<string, ImmichAlbumsDirectoryNode>;
    album?: ImmichAlbumDirectoryInfo;
}

class ImmichAlbumsDirectoryUtils
{
    public static collect_descendant_albums(node: ImmichAlbumsDirectoryNode, out: ImmichAlbumDirectoryInfo[]): void
    {
        if (node.album) out.push(node.album);
        for (const child of node.children.values())
        {
            ImmichAlbumsDirectoryUtils.collect_descendant_albums(child, out);
        }
    }
}