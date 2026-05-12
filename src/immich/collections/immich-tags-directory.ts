
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichRootDirectory } from "./immich-root-directory";
import { ImmichTagFolder } from "./immich-tag-folder";
import { getVirtualTagTree, ImmichTagDirectoryInfo } from "../utils/immich-api-utils";
import { ImmichTag, ImmichTagsDirectoryNode } from "../utils/immich-api-utils";

export class ImmichTagsDirectory extends VirtualDirectory
{
    private file_system: ImmichFileSystem;
    private tags_cache: ImmichTagDirectoryInfo[] = [];
    private current_file_tree: ImmichTagsDirectoryNode | null = null

    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super("tags", undefined, root)
        this.file_system = file_system
    }

    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        this.tags_cache = await this.file_system.getApi().FETCH_Tags();
        this.current_file_tree = getVirtualTagTree(this.tags_cache);
        if (this.current_file_tree == null)
        {
            return new Map()
        }
        else
        {
            return new Map([...this.current_file_tree.children.values()].map(node => ([node.fsName, new ImmichTagFolder(this.file_system, this, this, node)])))
        }
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_ro(this.name, Math.floor(Date.now() / 1000));
    }
    async event_mkdir(albumName: string): Promise<boolean>
    {
        return false
    }
}

