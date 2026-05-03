import tmp from "tmp";
import { VirtualFile } from "./virtual-file";
import { VirtualFsNode, VirtualFSNodeAttributes, VirtualFSNodeListInfo, VirtualFSNodeStats } from "./virtual-fs-node";

export type VirtualPathInfo = { parent: VirtualDirectory, node: VirtualFsNode | null, name: string }

export type VirtualDirectoryMoveValidatorMode = "source" | "dest"

export class VirtualDirectory extends VirtualFsNode
{
    private _child_nodes: Map<string, VirtualFsNode> | null = null;
    private _force_child_node_refresh: boolean = false

    constructor(name: string, mtime: number = Date.now(), parent: VirtualFsNode | null = null)
    {
        super(name, mtime, parent);
    }

    isDir() { return true; }
    refreshDelay() { return 200; }

    async node(name: string): Promise<VirtualFsNode | undefined>
    {
        const map = await this.nodes_map();
        return map.get(name);
    }
    async nodes()
    {
        const results = await this.nodes_map();
        return [...results.values()];
    }
    async nodes_map(): Promise<Map<string, VirtualFsNode>>
    {
        if (this._child_nodes !== null && !this._force_child_node_refresh) return this._child_nodes;
        await new Promise(resolve => setTimeout(resolve, this.refreshDelay()));
        this._child_nodes = await this.event_rebuild();
        this._force_child_node_refresh = false;
        return this._child_nodes;
    }
    public refresh_nodes()
    {
        this._force_child_node_refresh = true
    }


    async event_logout(): Promise<void>
    {
        return;
    }
    async event_delete(): Promise<boolean>
    {
        const nodes = await this.nodes();
        if (nodes.length == 0) return true
        else
        {
            nodes.forEach(async element =>
            {
                let is_removed = await element.event_deleterecursive()
                if (!is_removed) return false;
            });
            return true
        }
    }
    async event_list(): Promise<VirtualFSNodeListInfo[]>
    {
        const nodes = await this.nodes(); // one async boundary only
        const results = new Array<VirtualFSNodeListInfo>(nodes.length);

        for (let i = 0; i < nodes.length; i++)
        {
            results[i] = nodes[i].event_list_info(); // sync call
        }

        return results;
    }
    async event_readfile(): Promise<tmp.FileResult>
    {
        throw new Error("Not a file.")
    }
    async event_writefile(content: tmp.FileResult): Promise<boolean>
    {
        console.error("Not a file")
        return false
    }
    async event_stat(): Promise<VirtualFSNodeStats | null>
    {
        console.error("Method not implemented.")
        return null
    }
    async event_rename(new_name: string): Promise<boolean>
    {
        console.error("Method not implemented.")
        return false
    }
    async event_setattr(attr: VirtualFSNodeAttributes): Promise<boolean>
    {
        console.error("Method not implemented.")
        return false
    }
    async event_createfile(name: string, contents: tmp.FileResult): Promise<boolean>
    {
        console.error("Method not implemented.")
        return false
    }
    async event_mkdir(name: string): Promise<boolean>
    {
        console.error("Method not implemented.")
        return false
    }
    async event_rebuild(): Promise<Map<string, VirtualFsNode>>
    {
        return new Map();
    }
    async event_moveitem(item: VirtualFsNode, destination: VirtualDirectory): Promise<boolean>
    {
        if (!this.event_moveitem_isSendable(item, destination)) return false
        if (!destination.event_moveitem_isRecievable(item, this)) return false

        const depart_result = await this.event_moveitem_depart(item)
        if (!depart_result) return false;

        const arrival_result = await destination.event_moveitem_arrive(item)
        if (!arrival_result)
        {
            const return_result = await this.event_moveitem_arrive(item)
            return false
        }

        return true;
    }
    async event_moveitem_depart(item: VirtualFsNode): Promise<boolean>
    {
        console.error("Method not implemented.")
        return false
    }
    async event_moveitem_arrive(item: VirtualFsNode): Promise<boolean>
    {
        console.error("Method not implemented.")
        return false
    }
    public event_moveitem_isSendable(item: VirtualFsNode, container: VirtualDirectory): boolean
    {
        console.error("Method not implemented.")
        return false
    }
    public event_moveitem_isRecievable(item: VirtualFsNode, container: VirtualDirectory): boolean
    {
        console.error("Method not implemented.")
        return false
    }

    //#region Path Resolving

    async resolvePath(path: string): Promise<VirtualPathInfo>
    {
        return await VirtualDirectory.resolvePath(this, path)
    }

    static async resolvePath(root: VirtualDirectory, path: string): Promise<VirtualPathInfo>
    {
        if (path == "/") return { parent: root, node: root, name: root.name }
        const parts = path.split("/").filter(Boolean);

        let current: VirtualDirectory = root;

        for (let i = 0; i < parts.length - 1; i++)
        {
            const next = await current.node(parts[i]);
            if (!next || !next.isDir()) throw new Error(`Directory not found: ${parts[i]}`);
            current = next as VirtualDirectory;
        }

        const name = parts[parts.length - 1];
        const node = await current.node(name) ?? null;

        return { parent: current, node, name };
    }

    //#endregion

}