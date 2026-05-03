
import { VirtualDirectory } from "../../../common/virtual-directory";
import { VirtualFsNode, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../../common/virtual-fs-node";
import { PathUtils } from "../../../utils/path-utils";
import { ImmichFileSystem } from "../../immich-file-system";
import { ImmichRootDirectory } from "../root-directory";
import { ImmichTag, ImmichTagDirectoryInfo, ImmichTagFolder } from "./tag-folder";

export class ImmichTagsDirectory extends VirtualDirectory
{
    private file_system: ImmichFileSystem;
    private tags_cache: ImmichTagDirectoryInfo[] = [];
    private current_file_tree: ImmichTagsDirectoryNode | null = null
    private must_refetch: boolean = false;

    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super("tags", undefined, root)
        this.file_system = file_system
    }

    get needs_refetch()
    {
        return this.must_refetch;
    }

    public stage_refetch()
    {
        this.must_refetch = true
    }

    async start_refetch()
    {
        this.must_refetch = false
        await this.refresh()
    }

    async event_rebuild(): Promise<Map<string, VirtualFsNode>>
    {
        await this.refresh();
        if (this.current_file_tree == null)
        {
            return new Map()
        }
        else
        {
            return new Map([...this.current_file_tree.children.values()].map(node => ([node.fsName, new ImmichTagFolder(this.file_system, this, this, node)])))
        }
    }

    async refresh()
    {
        this.tags_cache = await this.file_system.getApi().fetchTags();
        this.current_file_tree = this.getVirtualTagTree(this.tags_cache);
    }

    event_list_info(): VirtualFSNodeListInfo
    {
        return {
            name: this.name,
            isDir: true,
            size: 0,
            mtime: Math.floor(Date.now() / 1000),
        }
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
        return true
    }

    public getVirtualTagTree(tags: ImmichTag[]): ImmichTagsDirectoryNode
    {
        const root: ImmichTagsDirectoryNode = {
            rawName: '',
            fsName: '',
            children: new Map(),
        };

        // 1. Index tags by ID
        const byId = new Map<string, ImmichTagsDirectoryNode>();
        for (const tag of tags)
        {
            const fs = PathUtils.normalizeFolderDisplayName(tag.name, 'tag', tag.id);

            byId.set(tag.id, {
                rawName: tag.name,
                fsName: fs,
                children: new Map(),
                tag,
            });
        }

        // 2. Build hierarchy using parentId
        for (const tag of tags)
        {
            const node = byId.get(tag.id)!;

            if (tag.parentId && byId.has(tag.parentId))
            {
                // Attach to parent
                const parent = byId.get(tag.parentId)!;
                parent.children.set(node.fsName, node);
            } else
            {
                // No parent → attach to root
                root.children.set(node.fsName, node);
            }
        }

        return root;
    }
}

export interface ImmichTagsDirectoryNode
{
    rawName: string;     // original segment from albumName
    fsName: string;      // normalized displayName segment
    children: Map<string, ImmichTagsDirectoryNode>;
    tag?: ImmichTagDirectoryInfo;
}