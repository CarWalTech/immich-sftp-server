
import { VirtualDirectory } from "../../../common/virtual-directory";
import { VirtualFsNode, VirtualFSNodeAttributes, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../../common/virtual-fs-node";
import { PathUtils } from "../../../utils/path-utils";
import { ImmichFileSystem } from "../../immich-file-system";
import { ImmichAlbumBase } from "../../utils/immich-album-utils";
import { ImmichRootDirectory } from "../root-directory";
import { ImmichAssetUtils } from "../../utils/immich-asset-utils";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../../metadata/immich-album-metadata";
import { ImmichAssetFile } from "../asset-file";
import { ImmichAlbumDirectoryInfo, ImmichAlbumFolder, ImmichAlbumsDirectoryNode } from "./album-folder";

export class ImmichAlbumsDirectory extends VirtualDirectory
{
    private file_system: ImmichFileSystem;

    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super("albums", undefined, root)
        this.file_system = file_system
    }

    private getAlbumNormalizedName(segment: string, albumId: string): string
    {
        return PathUtils.normalizeFolderDisplayName(segment, 'album', albumId);
    }

    private getVirtualAlbumTree(albums: ImmichAlbumDirectoryInfo[]): ImmichAlbumsDirectoryNode
    {
        const root: ImmichAlbumsDirectoryNode = {
            rawName: '',
            fsName: '',
            children: new Map(),
        };

        for (const album of albums)
        {
            // Use the REAL album name for structure
            const rawSegments = album.albumName.split(' / ').map(s => s.trim()).filter(Boolean);

            let node = root;

            for (const raw of rawSegments)
            {
                const fs = this.getAlbumNormalizedName(raw, album.id);

                if (!node.children.has(fs))
                {
                    node.children.set(fs, {
                        rawName: raw,
                        fsName: fs,
                        children: new Map(),
                    });
                }

                node = node.children.get(fs)!;
            }

            node.album = album;
        }

        return root;
    }

    async event_stat(): Promise<VirtualFSNodeStats>
    {
        return {
            isDir: true,
            size: 0,
            mtime: Math.floor(Date.now() / 1000),
        };
    }

    async event_mkdir(albumName: string): Promise<boolean>
    {
        await this.file_system.getApi().SERVER_CreateAlbum(albumName)
        this.event_refetch()
        return true
    }

    async event_rebuild(): Promise<Map<string, VirtualFsNode>>
    {
        const albums_cache = await this.file_system.getApi().fetchAlbums();
        const current_file_tree = this.getVirtualAlbumTree(albums_cache);
        if (current_file_tree == null)
        {
            return new Map()
        }
        else
        {
            return new Map([...current_file_tree.children.values()].map(node => ([node.fsName, new ImmichAlbumFolder(this.file_system, this, this, node)])))
        }
    }

    public event_refetch()
    {
        this.refresh_nodes()
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
}

