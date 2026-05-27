import fs from "fs";
import { ReadStreamOptions } from "ssh2";
import tmp from "tmp";
import { logger } from "../logger";


export class VirtualContentBuffer
{
    tmp?: tmp.FileResult;
    buffer?: Buffer;
    filepath?: string;
    checksum?: string; // pre-computed SHA-1 base64; set by SFTP write path to skip re-hash on upload

    // Cached size for tmp/filepath nodes — cleared after each write so the
    // next access re-measures.  Buffer nodes don't need this (length is O(1)).
    private _cachedSize?: number;

    // Cached read-fd for filepath nodes — opened lazily, closed in removeCallback.
    // Avoids a pair of openSync/closeSync on every read() call.
    private _fd?: number;

    // For buffer nodes: track how many bytes are actually written vs. how many
    // are allocated (capacity may be larger due to exponential growth).
    private _bufferLen?: number;

    constructor(tmp?: tmp.FileResult, buffer?: Buffer, filepath?: string)
    {
        if (tmp) this.tmp = tmp;
        if (buffer)
        {
            this.buffer = buffer;
            this._bufferLen = buffer.length;
        }
        if (filepath) this.filepath = filepath;
    }

    /** True if this node is backed by a tmp file */
    get isTmp()
    {
        return !!this.tmp;
    }

    /** True if this node is backed by an in-memory buffer */
    get isBuffer()
    {
        return !!this.buffer;
    }

    /** True if this node is backed by a plain filesystem path */
    get isFilepath()
    {
        return !!this.filepath;
    }

    /** Path-like name for tmp files or filepath nodes */
    get name()
    {
        if (this.tmp) return this.tmp.name;
        if (this.filepath) return this.filepath;
        throw new Error("VirtualNodeBuffer: no tmp file backing");
    }

    /** Size of the underlying data */
    get size()
    {
        if (this.tmp)
        {
            if (this._cachedSize !== undefined) return this._cachedSize;
            const s = fs.statSync(this.tmp.name).size;
            this._cachedSize = s;
            return s;
        }
        if (this.buffer)
        {
            // _bufferLen tracks actual written bytes; buffer.length may be larger
            // (pre-allocated capacity).
            return this._bufferLen ?? this.buffer.length;
        }
        if (this.filepath)
        {
            if (this._cachedSize !== undefined) return this._cachedSize;
            const s = fs.statSync(this.filepath).size;
            this._cachedSize = s;
            return s;
        }
        throw new Error("VirtualNodeBuffer: no data backing");
    }

    /** Read a slice of data */
    read(offset: number, length: number): Buffer
    {
        if (this.tmp)
        {
            const fd = this.tmp.fd;
            try
            {
                const out = Buffer.allocUnsafe(length); // readSync overwrites every byte; zeroing is wasteful
                const bytes = fs.readSync(fd, out, 0, length, offset);
                return out.subarray(0, bytes);
            }
            catch (e)
            {
                logger.error('VCB', 'read', `tmp fd=${fd} offset=${offset} len=${length} error:`, e);
                throw e;
            }
        }

        if (this.buffer)
        {
            const end = Math.min(offset + length, this._bufferLen ?? this.buffer.length);
            return this.buffer.subarray(offset, end);
        }

        if (this.filepath)
        {
            // Lazy-open: keep the fd across calls so we don't pay openSync/closeSync
            // for every SFTP READ chunk.  The fd is closed in removeCallback().
            if (this._fd === undefined)
            {
                this._fd = fs.openSync(this.filepath, 'r');
            }
            try
            {
                const out = Buffer.allocUnsafe(length);
                const bytes = fs.readSync(this._fd, out, 0, length, offset);
                return out.subarray(0, bytes);
            }
            catch (e)
            {
                logger.error('VCB', 'read', `filepath='${this.filepath}' offset=${offset} len=${length} error:`, e);
                throw e;
            }
        }

        throw new Error("VirtualNodeBuffer: no data backing");
    }

    /** Append or write data at an offset */
    write(offset: number, data: Buffer)
    {
        // Invalidate size cache — the underlying store is about to change.
        this._cachedSize = undefined;

        if (this.tmp)
        {
            fs.writeSync(this.tmp.fd, data, 0, data.length, offset);
            return;
        }

        if (this.buffer)
        {
            const end = offset + data.length;
            if (end > this.buffer.length)
            {
                // Exponential growth: double the current capacity (or grow to `end`,
                // whichever is larger) to avoid O(n²) reallocation on sequential writes.
                const newCapacity = Math.max(end, this.buffer.length * 2);
                const newBuf = Buffer.allocUnsafe(newCapacity);
                this.buffer.copy(newBuf, 0, 0, this._bufferLen ?? this.buffer.length);
                this.buffer = newBuf;
            }
            data.copy(this.buffer, offset);
            this._bufferLen = Math.max(this._bufferLen ?? 0, end);
            return;
        }

        if (this.filepath)
        {
            throw new Error("VirtualContentBuffer: filepath nodes are read-only");
        }

        throw new Error("VirtualNodeBuffer: no data backing");
    }

    /** Stream reading */
    createReadStream(options?: BufferEncoding | ReadStreamOptions)
    {
        if (this.tmp)
        {
            return fs.createReadStream(this.tmp.name, options);
        }
        if (this.buffer)
        {
            const usedBuf = this._bufferLen !== undefined
                ? this.buffer.subarray(0, this._bufferLen)
                : this.buffer;
            const { Readable } = require('stream');
            return Readable.from(usedBuf);
        }
        if (this.filepath)
        {
            return fs.createReadStream(this.filepath, options);
        }
        throw new Error("VirtualNodeBuffer: no data backing");
    }

    /** Cleanup */
    removeCallback()
    {
        if (this.tmp)
        {
            this.tmp.removeCallback();
            return;
        }
        if (this.buffer)
        {
            return;
        }
        if (this.filepath)
        {
            // Close the cached read-fd if one was opened.
            if (this._fd !== undefined)
            {
                try { fs.closeSync(this._fd); } catch { }
                this._fd = undefined;
            }
            return; // We don't own the file; nothing else to clean up.
        }
        throw new Error("VirtualNodeBuffer: no data backing");
    }

    /** Return full contents as UTF-8 string */
    contents()
    {
        if (this.tmp)
        {
            return fs.readFileSync(this.tmp.name, 'utf8');
        }
        if (this.buffer)
        {
            const usedBuf = this._bufferLen !== undefined
                ? this.buffer.subarray(0, this._bufferLen)
                : this.buffer;
            return usedBuf.toString('utf8');
        }
        if (this.filepath)
        {
            return fs.readFileSync(this.filepath, 'utf8');
        }
        throw new Error("VirtualNodeBuffer: no data backing");
    }
}
export class VirtualContentBufferUtils
{

    /** Create a tmp-backed node containing a UTF-8 string */
    static bufferFromString(content: string): VirtualContentBuffer
    {
        return new VirtualContentBuffer(undefined, Buffer.from(content, 'utf8'));
    }

    /** Create a tmp-backed node from a readable stream */
    static async bufferFromStream(stream: NodeJS.ReadableStream): Promise<VirtualContentBuffer>
    {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(chunk as Buffer);
        return new VirtualContentBuffer(undefined, Buffer.concat(chunks));
    }

}
