import { config } from '../config';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { VirtualDirectory } from "../filesystem/virtual-directory";
import { VirtualFile } from "../filesystem/virtual-file";
import { VFSResponse, VirtualFileSystem } from "../filesystem/virtual-file-system";
import { VirtualMetadata } from "../filesystem/virtual-metadata";
import type { VirtualPathInfo } from "../filesystem/virtual-path-info";
import { logger } from "../logger";
import { PathUtils } from "../utils/path-utils";
import { VirtualFsUtils } from "../utils/virtual-fs-utils";
import { ImmichRootDirectory } from "./directories/immich-root-directory";
import { ImmichAPI } from "./immich-api";

import path from "path";
import { Timestamp } from '../utils/date-utils';
import { ImmichUploadItem } from "./immich-api";
import { ImmichAlbumDirectoryInfo } from './utils/immich-api-utils';

export class ImmichFileSystem implements VirtualFileSystem
{
    private immichApi: ImmichAPI
    private root: ImmichRootDirectory
    memory: ImmichFileSystemMemory
    private _statInflight: Map<string, Promise<VFSResponse<VirtualMetadata>>> = new Map();
    private _listInflight: Map<string, Promise<VirtualMetadata[]>> = new Map();
    private _statCache: Map<string, { result: VFSResponse<VirtualMetadata>, expiresAt: number }> = new Map();
    private static readonly STAT_CACHE_TTL_MS = 500;
    private static readonly STAT_CACHE_PRUNE_THRESHOLD = 500;
    private static readonly PHANTOM_XMP_TTL_MS = 30_000;

    constructor()
    {
        this.root = new ImmichRootDirectory(this);
        this.immichApi = new ImmichAPI(config.IMMICH_HOST.replace(/\/+$/, ''));
        this.memory = new ImmichFileSystemMemory(this);
    }


    // VirtualFileSystem Methods
    async login(username: string, password: string): Promise<void>
    {
        logger.filesystem("ImmichFileSystem", "LOGIN", `Login starting for user: ${username}`)
        return await this.immichApi.login(username, password)
    }

    async logout(): Promise<void>
    {
        logger.filesystem("ImmichFileSystem", "LOGOUT", `Logout starting for user: ${this.immichApi.getUser()?.id ?? 'unknown'}`)
        await this.immichApi.logout();
        await this.root.event_logout();
        logger.filesystem("ImmichFileSystem", "LOGOUT", `Logout complete for user: ${this.immichApi.getUser()?.id ?? 'unknown'}`)
    }
    async setAttributes(_filename: string, _mtime: number)
    {
        // No-op: mtime/chmod from SFTP clients (e.g. post-upload SETSTAT) is not
        // meaningful for Immich-backed files. Skipping resolvePath avoids triggering
        // a cache rebuild (and a FETCH_Albums call) immediately after every upload.
    }
    async listFiles(currentDir: string)
    {
        const existing = this._listInflight.get(currentDir);
        if (existing) return existing;

        const promise = (async () =>
        {
            const { node } = await VirtualFsUtils.resolvePath(this.root, currentDir);
            if (!node || !node.isDir()) throw new Error(`Not a directory: ${currentDir}`);

            logger.filesystem("ImmichFileSystem", "LIST", `Listing files: ${currentDir}`)
            const result = await (node as VirtualDirectory).event_list()
            logger.filesystem("ImmichFileSystem", "LIST", `Done listing files: ${currentDir}`)
            if (result) return result
            else throw new Error("Unable to process event list")
        })().finally(() => this._listInflight.delete(currentDir));

        this._listInflight.set(currentDir, promise);
        return promise;
    }
    async readFile(filename: string)
    {
        const tmp_result = await this.memory.read(filename)
        if (tmp_result) return tmp_result;

        const { node } = await VirtualFsUtils.resolvePath(this.root, filename);
        if (!node || node.isDir()) throw new Error(`Not a file: ${filename}`);

        logger.filesystem("ImmichFileSystem", "READ", `Reading file: ${filename}`)

        const file = (node as VirtualFile);
        return await file.event_readfile();
    }
    async writeFile(filename: string, tmpFile: VirtualContentBuffer)
    {
        const is_tmp = await this.memory.write(filename, tmpFile)
        if (is_tmp) return

        const { parent, node, name } = await VirtualFsUtils.resolvePath(this.root, filename);

        if (node && !node.isDir())
        {
            logger.filesystem("ImmichFileSystem", "WRITE", `Writing file: ${filename}`)
            await (node as VirtualFile).event_writefile(tmpFile);
            return;
        }

        if (parent && parent.isDir())
        {
            // Immich rejects standalone XMP uploads (400 "Unsupported file type").
            // Store in tmp so stat/remove succeed and rclone doesn't retry indefinitely.
            if (name.toLowerCase().endsWith('.xmp'))
            {
                logger.filesystem("ImmichFileSystem", "WRITE", `Holding XMP in memory (no standalone upload): ${filename}`)
                await this.memory.push_tmp(name, path.posix.dirname(PathUtils.normalizePath(filename)), tmpFile, ImmichFileSystem.PHANTOM_XMP_TTL_MS);
                return;
            }

            logger.filesystem("ImmichFileSystem", "WRITE", `Writing to new file: ${filename}`)
            await parent.event_createfile(name, tmpFile);
            await this.memory.flushQueued(filename);
            return;
        }

        throw new Error("Cannot write to destination");
    }
    async stat(filename: string): Promise<VFSResponse<VirtualMetadata>>
    {
        const tmp_result = await this.memory.stat(filename)
        if (tmp_result) return { success: true, contents: tmp_result };

        // After a file leaves the memory queue (Immich upload complete) it is no
        // longer findable under its original name because the server presents it
        // under the renamed path.  Without this check, stat() returns failure and
        // rclone treats its confirmed upload as failed, re-queueing the same file
        // indefinitely.  Returning a placeholder keeps rclone satisfied until its
        // own VFS cache evicts the stale local entry.
        const recentUpload = this.immichApi.QUEUE_GetRecentUpload(filename);
        if (recentUpload)
        {
            const name = path.basename(filename);
            return { success: true, contents: VirtualMetadata.file_rw(name, recentUpload.fileSize, Timestamp.now()) };
        }

        const now = Date.now();
        const cached = this._statCache.get(filename);
        if (cached && now < cached.expiresAt) return cached.result;

        if (this._statCache.size >= ImmichFileSystem.STAT_CACHE_PRUNE_THRESHOLD)
        {
            for (const [key, entry] of this._statCache)
                if (now >= entry.expiresAt) this._statCache.delete(key);
        }

        const existing = this._statInflight.get(filename);
        if (existing) return existing;

        const promise = (async () =>
        {
            const { node } = await VirtualFsUtils.resolvePath(this.root, filename);
            if (!node) return { success: false, contents: undefined as any };

            logger.filesystem("ImmichFileSystem", "STAT", `Getting stats of: ${filename}`)

            const node_result = await node.event_stat();
            const result = { success: true, contents: node_result };
            this._statCache.set(filename, { result, expiresAt: Date.now() + ImmichFileSystem.STAT_CACHE_TTL_MS });
            return result;
        })().finally(() => this._statInflight.delete(filename));

        this._statInflight.set(filename, promise);
        return promise;
    }
    async rename(oldFileName: string, newFileName: string)
    {
        const tmp_result = await this.memory.rename(oldFileName, newFileName)
        if (tmp_result) return tmp_result;

        const oldRes = await VirtualFsUtils.resolvePath(this.root, oldFileName);
        const newRes = await VirtualFsUtils.resolvePath(this.root, newFileName);

        // If destination is a directory, append the original filename
        if (newRes.node && newRes.node.isDir())
        {
            newFileName = newFileName + "/" + oldRes.name;
            // Re-resolve with the corrected path
            const corrected = await VirtualFsUtils.resolvePath(this.root, newFileName);
            newRes.parent = corrected.parent;
            newRes.name = corrected.name;
        }

        if (!oldRes.node)
        {
            throw new Error('File not found');
        }
        else if (oldRes.name == newRes.name && oldRes.parent.fullpath != newRes.parent.fullpath)
        {
            logger.filesystem("ImmichFileSystem", "RENAME", `Renaming folder: ${oldFileName} -> ${newFileName}`)
            // Asset move: event handlers invalidate only what they touch.
            // Directory move: full tree invalidation needed since album structure changes.
            if (oldRes.node.isDir()) this.invalidateTree();
            return await oldRes.parent.event_movenode(oldRes.node, newRes.parent)
        }
        else
        {
            logger.filesystem("ImmichFileSystem", "RENAME", `Renaming file: ${oldFileName} -> ${newFileName}`)
            this.invalidateTree();
            return await oldRes.node.event_rename(newRes.name)
        }

    }
    async remove(filename: string)
    {
        const { parent, name, node } = await VirtualFsUtils.resolvePath(this.root, filename);

        if (!node)
        {
            return await this.memory.remove(filename);
        }

        logger.filesystem("ImmichFileSystem", "REMOVE", `Deleting: ${filename}`)
        return await node.event_delete();
    }
    async mkdir(path: string)
    {
        const { parent, node, name } = await VirtualFsUtils.resolvePath(this.root, path);

        if (node) return false;
        if (!parent) return false;

        logger.filesystem("ImmichFileSystem", "MKDIR", `Creating directory: ${path}`)

        const result = await parent.event_mkdir(name);
        return result;
    }


    public invalidateTree()
    {
        this.immichApi.CACHE_InvalidateTree()
    }

    public invalidatePath(path: string)
    {
        this.immichApi.CACHE_InvalidateFilepath(path)
        this._statCache.delete(path);
    }


    // Get Methods

    public getApi()
    {
        return this.immichApi;
    }
    public getUrl()
    {
        return this.immichApi.getBaseUrl()
    }
    public getCurrentUser()
    {
        return this.immichApi.getUser()
    }
    public getCurrentUserView()
    {
        return this.immichApi.getUserView()
    }
    public isAuthenticated(): boolean
    {
        return this.immichApi.getUser() !== null;
    }
    public getUserSettings()
    {
        return this.immichApi.getUserSettings()
    }
    public async getResolvedPath(path: string): Promise<VirtualPathInfo>
    {
        return await VirtualFsUtils.resolvePath(this.root, path);
    }




}

export class ImmichFileSystemMemory
{
    private immich_fs: ImmichFileSystem
    private entries_tmp: ImmichFileSystemMemoryEntry[] = [];

    constructor(immich_fs: ImmichFileSystem)
    {
        this.immich_fs = immich_fs
    }

    get entries(): ImmichUploadItem[]
    {
        return this.immich_fs.getApi().QUEUE_List()
    }

    private find(filename: string): { type: "queue" | "tmp", item: ImmichFileSystemMemoryEntry | ImmichUploadItem | undefined } | null
    {
        const uploadable = this.entries.find(f => f.longname === filename);
        if (uploadable) return { type: "queue", item: uploadable }

        const tmp_file = this.entries_tmp.find(f => f.longname === filename);
        if (tmp_file) return { type: "tmp", item: tmp_file }

        return null
    }

    async push_tmp(filename: string, fullpath: string, tmpFile: VirtualContentBuffer, ttlMs?: number)
    {
        var full_name = fullpath + "/" + filename;
        filename = PathUtils.normalizePath(filename);
        full_name = PathUtils.normalizePath(full_name);

        const data: ImmichFileSystemMemoryEntry = {
            filename: path.basename(full_name),
            longname: full_name,
            tmpFile: tmpFile,
            expiresAt: ttlMs !== undefined ? Date.now() + ttlMs : undefined
        };

        this.entries_tmp.push(data);

        return true;
    }

    async push(filename: string, fullpath: string, tmpFile: VirtualContentBuffer, album?: ImmichAlbumDirectoryInfo)
    {
        var full_name = fullpath + "/" + filename;
        filename = PathUtils.normalizePath(filename);
        full_name = PathUtils.normalizePath(full_name);

        const data: ImmichUploadItem = {
            filename: path.basename(full_name),
            longname: full_name,
            node: tmpFile,
            uploadToAlbum: album
        };
        this.immich_fs.getApi().QUEUE_AppendFile(data);
        return true;
    }

    async list(currentDir: string): Promise<VirtualMetadata[]>
    {
        const entriesMap = new Map<string, VirtualMetadata>();

        for (const entry of this.entries)
        {
            const parts = entry.longname.split('/');
            const dir = parts.slice(0, -1).join('/') || '/';
            const name = parts[parts.length - 1];

            if (dir !== currentDir) continue;
            entriesMap.set(name, VirtualMetadata.file_rw(name, 0, Timestamp.now()));
        }

        const now = Date.now();
        this.entries_tmp = this.entries_tmp.filter(e => !e.expiresAt || now <= e.expiresAt);

        for (const entry of this.entries_tmp)
        {
            const parts = entry.longname.split('/');
            const dir = parts.slice(0, -1).join('/') || '/';
            const name = parts[parts.length - 1];

            if (dir !== currentDir) continue;
            entriesMap.set(name, VirtualMetadata.file_rw(name, 0, Timestamp.now()));
        }

        return [...entriesMap.values()];
    }

    async read(filename: string)
    {
        filename = PathUtils.normalizePath(filename);
        const found = this.find(filename);
        if (!found || !found.item) return null

        if (found.type === "tmp")
        {
            logger.filesystem("ImmichFileSystemMemory", "READ", `Reading memory file: ${filename}`)
            const entry = found.item as ImmichFileSystemMemoryEntry;
            // Return the existing tmp file directly
            return entry.tmpFile;
        }
        return null;
    }

    async write(filename: string, tmpFile: VirtualContentBuffer)
    {
        // Normalize once
        const normalized = filename;

        // 1) If this is a .part file → keep it in memory only
        if (normalized.endsWith(".part"))
        {
            logger.filesystem("ImmichFileSystemMemory", "WRITE", `Writing memory file: ${filename}`)
            const dir = path.posix.dirname(normalized);
            const base = path.posix.basename(normalized);

            await this.push_tmp(base, dir, tmpFile);
            return true;
        }
        else
        {
            return false;
        }
    }

    async stat(filename: string)
    {
        filename = PathUtils.normalizePath(filename);
        const entry = this.find(filename);
        if (!entry) return null;

        if (entry.type === "tmp")
        {
            const item = entry.item as ImmichFileSystemMemoryEntry;
            if (item.expiresAt && Date.now() > item.expiresAt) return null;
        }

        logger.filesystem("ImmichFileSystemMemory", "STAT", `Getting stats of: ${filename}`)

        // Upload is now triggered directly by writeFile → flushQueued.
        // stat() just confirms the file is known so the client gets a sensible response.
        return VirtualMetadata.file_rw(filename, 0, Timestamp.now());
    }

    /**
     * Upload and dequeue the first queue entry that matches filename.
     * Called by ImmichFileSystem.writeFile immediately after event_createfile
     * so the upload starts as soon as the file is closed, not on the next stat().
     */
    async flushQueued(filename: string): Promise<void>
    {
        const normalized = PathUtils.normalizePath(filename);
        const index = this.entries.findIndex(e => e.longname === normalized);
        if (index === -1) return;

        const queueItem = this.entries[index];
        try
        {
            await this.immich_fs.getApi().QUEUE_UploadFile(queueItem, Timestamp.currentTime());
        }
        finally
        {
            // Always remove from queue regardless of upload success/failure
            this.immich_fs.getApi().QUEUE_Splice(index, 1);
        }
    }

    async rename(oldName: string, newName: string)
    {
        oldName = PathUtils.normalizePath(oldName);
        newName = PathUtils.normalizePath(newName);
        const entry = this.find(oldName);

        if (!entry)
        {
            logger.error("ImmichWritableMemory", "Rename", `Not found: ${oldName}`)
            return false;
        }
        if (this.entries.find(e => e.longname === newName))
        {
            logger.error("ImmichWritableMemory", "Rename", `Target already exists: ${newName} (old name: ${oldName})`)
            return false;
        }

        if (entry.type === "queue")
        {
            this.immich_fs.getApi().QUEUE_RenameFileInFlight((entry.item as ImmichUploadItem).longname, newName)
            return true;
        }
        else if (entry.type === "tmp")
        {
            const fileIndex = this.entries_tmp.findIndex(f => f.longname === oldName);
            if (fileIndex === -1) return false;

            const mem = this.entries_tmp[fileIndex];

            const wasPart = oldName.endsWith(".part");
            const isPart = newName.endsWith(".part");

            if (wasPart && !isPart)
            {
                // FINALIZE: .part → real file
                // writeFile first — if it throws the entry stays in entries_tmp so
                // a retry is still possible and the data is not silently lost.
                await this.immich_fs.writeFile(newName, mem.tmpFile);

                // Only remove from tmp list after the write has been accepted.
                this.entries_tmp.splice(fileIndex, 1);

                logger.info("ImmichWritableMemory", "Finalize", `Promoted .part ${oldName} -> ${newName} and wrote to backend`);

                return true;
            }
            else
            {
                // Still a tmp file, just rename in memory
                const oldLongName = mem.longname;
                mem.longname = newName;
                mem.filename = path.basename(mem.longname);
                logger.info(`ImmichWritableMemory`, "TMP", `Renamed: ${oldLongName} -> ${newName}`);
                return true;
            }
        }

        return false




    }

    async remove(path: string)
    {
        const item_entry = this.find(path);
        if (!item_entry)
        {
            logger.error("ImmichWritableMemory", "Remove", `Not found: ${path}`)
            return false;
        }

        if (item_entry.type === "queue")
        {
            const index = this.entries.findIndex(e => e.longname === path);
            if (index === -1)
            {
                logger.error("ImmichWritableMemory", "Remove", `Not found: ${path}`)
                return false;
            }
            const entry = this.entries[index];
            this.immich_fs.getApi().QUEUE_Splice(index, 1);
            return true;
        }
        else if (item_entry.type === "tmp")
        {
            const index = this.entries_tmp.findIndex(e => e.longname === path);
            if (index === -1)
            {
                logger.error("ImmichWritableMemory", "Remove", `Not found: ${path}`)
                return false;
            }
            this.entries_tmp.splice(index, 1)
            return true;
        }
        return false


    }
}

export interface ImmichFileSystemMemoryEntry
{
    filename: string;
    longname: string;
    tmpFile: VirtualContentBuffer;
    expiresAt?: number;
}











