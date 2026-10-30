import { config } from "../config";
import { logger } from "../logger";
import { mapLimit } from "../utils/async-utils";
import { Timestamp } from "../utils/date-utils";
import { VirtualContentBuffer } from "./virtual-content-buffer";
import { VirtualMetadata } from './virtual-metadata';
import { VirtualNode } from "./virtual-node";
export type VirtualDirectoryMoveItemFn = (item: VirtualNode, container: VirtualDirectory) => boolean;
export type VirtualDirectoryOptions = {
    sendFn?: VirtualDirectoryMoveItemFn,
    recieveFn?: VirtualDirectoryMoveItemFn,
    refreshOnMove?: boolean,
    /**
     * Rebuild the child node graph on every readdir.  Correct but very expensive:
     * a listing of an album with sidecars re-allocates two nodes per asset even
     * when every backing API response came from cache.  Prefer `refreshTtlMs`,
     * which bounds staleness in time instead of rebuilding unconditionally.
     */
    refreshOnReadDir?: boolean,
    /**
     * Reuse the built node graph for this long before rebuilding.  Explicit
     * refresh() after a write/move/delete bypasses it, so this only governs how
     * quickly changes made *outside* the bridge become visible.
     */
    refreshTtlMs?: number
}

export class VirtualDirectory extends VirtualNode
{
    private _child_nodes: Map<string, VirtualNode> | null = null;
    private _force_child_node_refresh: boolean = false
    private _recieveFunction?: VirtualDirectoryMoveItemFn
    private _sendFunction?: VirtualDirectoryMoveItemFn
    private _refreshOnMoveNode: boolean = false
    private _refreshOnReadDir: boolean = false
    private _refreshTtlMs: number = 0
    private _builtAt: number = 0
    private _rebuildPromise: Promise<Map<string, VirtualNode>> | null = null;

    constructor(name: string, mtime: Timestamp = Timestamp.now(), parent: VirtualNode | null = null, options?: VirtualDirectoryOptions)
    {
        super(name, mtime, parent);
        if (options)
        {
            if (options.recieveFn) this._recieveFunction = options.recieveFn
            if (options.sendFn) this._sendFunction = options.sendFn
            if (options.refreshOnMove) this._refreshOnMoveNode = options.refreshOnMove
            if (options.refreshOnReadDir) this._refreshOnReadDir = options.refreshOnReadDir
            if (options.refreshTtlMs !== undefined) this._refreshTtlMs = options.refreshTtlMs
        }
    }

    /**
     * Newest mtime among the children built so far, or this node's own mtime if
     * the directory hasn't been listed yet.
     *
     * Directories have no timestamp of their own in Immich, and defaulting to
     * "now" makes every listing look freshly modified — which pushes sync clients
     * into rescanning content that hasn't changed.  Deriving from the children
     * gives a value that is both stable and actually meaningful.
     */
    protected latestChildMtime(): Timestamp
    {
        if (this._child_nodes === null || this._child_nodes.size === 0) return this.mtime;

        let latest = 0;
        for (const child of this._child_nodes.values())
            if (child.mtime.value() > latest) latest = child.mtime.value();

        return latest > 0 ? Timestamp.fromSeconds(latest) : this.mtime;
    }

    /** True when the built node graph has outlived its refresh TTL. */
    private isStale(): boolean
    {
        if (this._refreshTtlMs <= 0) return false;
        return (Date.now() - this._builtAt) >= this._refreshTtlMs;
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

    /**
     * Synchronous cache probe — avoids async overhead when the directory is
     * already built. Returns `{ hit: false }` if the cache is absent or stale
     * (caller must fall back to the async path). Returns `{ hit: true, node }`
     * if the cache is valid; `node` may be `undefined` meaning "not found."
     */
    tryNodeFromCache(name: string): { hit: false } | { hit: true; node: VirtualNode | undefined }
    {
        if (this._child_nodes === null || this._force_child_node_refresh || this.needsRefresh() || this.isStale())
            return { hit: false };
        return { hit: true, node: this._child_nodes.get(name) };
    }
    async nodes(refresh?: boolean)
    {
        const results = await this.nodes_map(refresh);
        return [...results.values()];
    }

    async nodes_map(refresh?: boolean): Promise<Map<string, VirtualNode>>
    {
        if (this._child_nodes !== null && !this._force_child_node_refresh && !this.needsRefresh() && !this.isStale() && !refresh)
            return this._child_nodes;

        if (!this._rebuildPromise)
        {
            this._rebuildPromise = this.event_rebuild().then(result =>
            {
                this._child_nodes = result;
                this._force_child_node_refresh = false;
                this._builtAt = Date.now();
                this._rebuildPromise = null;
                return result;
            }).catch(err =>
            {
                // Leave the previous graph in place and let the next call retry —
                // otherwise a transient API failure would wedge the directory
                // behind a permanently-rejected promise.
                this._rebuildPromise = null;
                throw err;
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
        if (nodes.length == 0) return true;

        // Every child must actually finish deleting before this resolves — the
        // previous forEach(async …) returned true immediately and dropped both the
        // results and any rejections on the floor.
        const results = await mapLimit(nodes, config.OPTION_MAX_CONCURRENT_STATS, n => n.event_delete(true));
        return results.every(Boolean);
    }
    /**
     * Children paired with their metadata.
     *
     * The pairing is what makes this worth having: a protocol layer can use it to
     * pre-populate a path-keyed stat cache, so the per-child property requests
     * that follow a readdir (WebDAV alone asks for type, size, mtime, ctime, etag
     * and mimetype) are answered from memory instead of re-walking the tree.
     */
    async event_list_entries(): Promise<Array<{ node: VirtualNode; meta: VirtualMetadata }>>
    {
        const nodes = await this.nodes(this._refreshOnReadDir);
        // Bounded: a large album would otherwise open one stat per asset at once,
        // and a sidecar stat can reach the network or the disk.
        const metas = await mapLimit(nodes, config.OPTION_MAX_CONCURRENT_STATS, n => n.event_stat());
        return nodes.map((node, i) => ({ node, meta: metas[i] }));
    }
    async event_list(): Promise<VirtualMetadata[]>
    {
        return (await this.event_list_entries()).map(e => e.meta);
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        throw new Error("Not a file.")
    }
    async event_writefile(content: VirtualContentBuffer): Promise<boolean>
    {
        logger.error("VirtualDirectory", "WriteFile", "error", "Not a file")
        return false
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(this.name, this.mtime);
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
    async event_createfile(name: string, contents: VirtualContentBuffer): Promise<boolean>
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