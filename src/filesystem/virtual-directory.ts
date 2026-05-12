import tmp from "tmp";
import { VirtualFile } from "./virtual-file";
import { VirtualNode } from "./virtual-node";
import { VirtualMetadata } from './virtual-metadata';
import { logger } from "../logger";

export type VirtualDirectoryMoveItemFn = (item: VirtualNode, container: VirtualDirectory) => boolean;
export type VirtualDirectoryOptions = { sendFn?: VirtualDirectoryMoveItemFn, recieveFn?: VirtualDirectoryMoveItemFn, refreshOnMove?: boolean, refreshOnReadDir?: boolean }

export class VirtualDirectory extends VirtualNode
{
    private _child_nodes: Map<string, VirtualNode> | null = null;
    private _force_child_node_refresh: boolean = false
    private _recieveFunction?: VirtualDirectoryMoveItemFn
    private _sendFunction?: VirtualDirectoryMoveItemFn
    private _refreshOnMoveNode: boolean = false
    private _refreshOnReadDir: boolean = false
    private _rebuildPromise: Promise<Map<string, VirtualNode>> | null = null;

    constructor(name: string, mtime: number = Date.now(), parent: VirtualNode | null = null, options?: VirtualDirectoryOptions)
    {
        super(name, mtime, parent);
        if (options)
        {
            if (options.recieveFn) this._recieveFunction = options.recieveFn
            if (options.sendFn) this._sendFunction = options.sendFn
            if (options.refreshOnMove) this._refreshOnMoveNode = options.refreshOnMove
            if (options.refreshOnReadDir) this._refreshOnReadDir = options.refreshOnReadDir
        }
    }

    get fullpath(): string
    {
        return super.fullpath
    }

    isDir() { return true; }
    needsRefresh() { return false; }

    async node(name: string): Promise<VirtualNode | undefined>
    {
        const map = await this.nodes_map();
        return map.get(name);
    }
    async nodes(refresh?: boolean)
    {
        const results = await this.nodes_map(refresh);
        return [...results.values()];
    }

    async nodes_map(refresh?: boolean): Promise<Map<string, VirtualNode>>
    {
        if (this._child_nodes !== null && !this._force_child_node_refresh && !this.needsRefresh() && !refresh)
            return this._child_nodes;

        if (!this._rebuildPromise)
        {
            this._rebuildPromise = this.event_rebuild().then(result =>
            {
                this._child_nodes = result;
                this._force_child_node_refresh = false;
                this._rebuildPromise = null;
                return result;
            });
        }

        return this._rebuildPromise;
    }

    // #region Events

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
                let is_removed = await element.event_delete(true)
                if (!is_removed) return false;
            });
            return true
        }
    }
    async event_list(): Promise<VirtualMetadata[]>
    {
        const nodes = await this.nodes(this._refreshOnReadDir);
        const results = new Array<VirtualMetadata>(nodes.length);

        for (let i = 0; i < nodes.length; i++)
        {
            results[i] = await nodes[i].event_stat(); // sync call
        }

        return results;
    }
    async event_readfile(): Promise<tmp.FileResult>
    {
        throw new Error("Not a file.")
    }
    async event_writefile(content: tmp.FileResult): Promise<boolean>
    {
        logger.error("VirtualDirectory", "WriteFile", "error", "Not a file")
        return false
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(
            this.name,
            Math.floor(Date.now() / 1000)
        );
    }
    async event_rename(new_name: string): Promise<boolean>
    {
        logger.error("VirtualDirectory", "Rename", "error", "Method Not Implemented")
        return false
    }
    async event_setattr(attr: VirtualMetadata): Promise<boolean>
    {
        logger.error("VirtualDirectory", "SetAttributes", "error", "Method Not Implemented")
        return false
    }
    async event_createfile(name: string, contents: tmp.FileResult): Promise<boolean>
    {
        logger.error("VirtualDirectory", "CreateFile", "error", "Method Not Implemented")
        return false
    }
    async event_mkdir(name: string): Promise<boolean>
    {
        logger.error("VirtualDirectory", "MkDir", "error", "Method Not Implemented")
        return false
    }
    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        return new Map();
    }
    async event_movenode(item: VirtualNode, destination: VirtualDirectory): Promise<boolean>
    {
        const result = await this._doMove(item, destination)
        if (this._refreshOnMoveNode) this.refresh()
        return result
    }
    async event_sendnode(item: VirtualNode): Promise<boolean>
    {
        logger.error("VirtualDirectory", "SendNode", "error", "Method Not Implemented")
        return false
    }
    async event_recievenode(item: VirtualNode): Promise<boolean>
    {
        logger.error("VirtualDirectory", "RecieveNode", "error", "Method Not Implemented")
        return false
    }
    public refresh()
    {
        this._force_child_node_refresh = true
    }

    //#endregion

    private _canSendItem(item: VirtualNode, container: VirtualDirectory): boolean
    {
        if (this._sendFunction === undefined)
        {
            logger.error("VirtualDirectory", "PRIV_CanSendItem", "error", "Function Not Implemented")
            return false
        }
        else
        {
            return this._sendFunction(item, container)
        }

    }
    private _canRecieveItem(item: VirtualNode, container: VirtualDirectory): boolean
    {
        if (this._recieveFunction === undefined)
        {
            logger.error("VirtualDirectory", "PRIV_CanRecieveItem", "error", "Function Not Implemented")
            return false
        }
        else
        {
            return this._recieveFunction(item, container)
        }
    }
    private async _doMove(item: VirtualNode, destination: VirtualDirectory): Promise<boolean>
    {
        if (!this._canSendItem(item, destination)) return false
        if (!destination._canRecieveItem(item, this)) return false

        const depart_result = await this.event_sendnode(item)
        if (!depart_result) return false;

        const arrival_result = await destination.event_recievenode(item)
        if (!arrival_result)
        {
            const return_result = await this.event_recievenode(item)
            return false
        }

        return true;
    }

}