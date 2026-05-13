import fs from 'fs';
import tmp from 'tmp';
import { VirtualMetadata } from '../filesystem/virtual-metadata';
import { ImmichFileSystem } from "./immich-file-system";
import { ImmichUploadQueueItem } from "./immich-api";
import { ImmichAlbumDirectoryInfo } from './utils/immich-api-utils';
import path from "path";
import { logger } from '../logger';
import { VirtualContentBuffer } from '../filesystem/virtual-content-buffer';



export class ImmichWritableMemory
{
    private immich_fs: ImmichFileSystem
    private entries_tmp: MemoryEntry[] = [];

    constructor(immich_fs: ImmichFileSystem)
    {
        this.immich_fs = immich_fs
    }

    get entries(): ImmichUploadQueueItem[]
    {
        return this.immich_fs.getApi().QUEUE_List()
    }

    private find(filename: string): { type: "queue" | "tmp", item: MemoryEntry | ImmichUploadQueueItem | undefined } | null
    {
        const uploadable = this.entries.find(f => f.longname === filename);
        if (uploadable) return { type: "queue", item: uploadable }

        const tmp_file = this.entries_tmp.find(f => f.longname === filename);
        if (tmp_file) return { type: "tmp", item: tmp_file }

        return null
    }

    async push_tmp(filename: string, fullpath: string, tmpFile: VirtualContentBuffer)
    {
        var full_name = fullpath + "/" + filename;
        filename = normalizePath(filename);
        full_name = normalizePath(full_name);

        const data: MemoryEntry = {
            filename: path.basename(full_name),
            longname: full_name,
            tmpFile: tmpFile
        };

        this.entries_tmp.push(data);

        return true;
    }

    async push(filename: string, fullpath: string, tmpFile: VirtualContentBuffer, album?: ImmichAlbumDirectoryInfo)
    {
        var full_name = fullpath + "/" + filename;
        filename = normalizePath(filename);
        full_name = normalizePath(full_name);

        const data: ImmichUploadQueueItem = {
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
            entriesMap.set(name, VirtualMetadata.file_rw(name, 0, new Date().getTime() / 1000));
        }

        for (const entry of this.entries_tmp)
        {
            const parts = entry.longname.split('/');
            const dir = parts.slice(0, -1).join('/') || '/';
            const name = parts[parts.length - 1];

            if (dir !== currentDir) continue;
            entriesMap.set(name, VirtualMetadata.file_rw(name, 0, new Date().getTime() / 1000));
        }

        return [...entriesMap.values()];
    }

    async read(filename: string)
    {
        filename = normalizePath(filename);
        const found = this.find(filename);
        if (!found || !found.item) return null

        if (found.type === "tmp")
        {
            const entry = found.item as MemoryEntry;
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
        filename = normalizePath(filename);
        const entry = this.find(filename);
        if (!entry) return null

        if (entry.type === "queue")
        {
            await this.immich_fs.getApi().QUEUE_UploadFile((entry.item as ImmichUploadQueueItem), new Date().getTime() / 1000);
            await this.immich_fs.getApi().QUEUE_Splice(this.entries.findIndex(e => e.longname === filename), 1)

            return VirtualMetadata.file_rw(filename, 0, new Date().getTime() / 1000);
        }
        else if (entry.type === "tmp")
        {
            return VirtualMetadata.file_rw(filename, 0, new Date().getTime() / 1000);
        }
        return VirtualMetadata.file_rw(filename, 0, new Date().getTime() / 1000);

    }

    async rename(oldName: string, newName: string)
    {
        oldName = normalizePath(oldName);
        newName = normalizePath(newName);
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
            this.immich_fs.getApi().QUEUE_RenameFileInFlight((entry.item as ImmichUploadQueueItem).longname, newName)
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
                const dir = path.posix.dirname(newName);
                const base = path.posix.basename(newName);

                // Remove from tmp list
                this.entries_tmp.splice(fileIndex, 1);

                // Hand off to real write path
                await this.immich_fs.writeFile(newName, mem.tmpFile);

                logger.info("ImmichWritableMemory", "Finalize", `Promoted .part ${oldName} -> ${newName} and wrote to backend`
                );

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

function normalizePath(path: string): string
{
    if (!path) return "/";

    // Replace backslashes, collapse duplicate slashes
    path = path.replace(/\\/g, "/").replace(/\/+/g, "/");

    // Ensure leading slash
    if (!path.startsWith("/")) path = "/" + path;

    // Remove trailing slash unless root
    if (path.length > 1 && path.endsWith("/"))
    {
        path = path.slice(0, -1);
    }

    return path;
}

export interface MemoryEntry
{
    filename: string;
    longname: string;
    tmpFile: VirtualContentBuffer;
}