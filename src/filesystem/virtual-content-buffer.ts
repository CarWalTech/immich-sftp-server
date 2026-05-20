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

    constructor(tmp?: tmp.FileResult, buffer?: Buffer, filepath?: string)
    {
        if (tmp) this.tmp = tmp;
        if (buffer) this.buffer = buffer;
        if (filepath) this.filepath = filepath
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
            return fs.statSync(this.tmp.name).size;
        }
        if (this.buffer)
        {
            return this.buffer.length;
        }
        if (this.filepath)
        {
            return fs.statSync(this.filepath).size;
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
            return this.buffer.subarray(offset, offset + length);
        }

        if (this.filepath)
        {
            let fd: number | undefined;
            try
            {
                fd = fs.openSync(this.filepath, 'r');
                const out = Buffer.allocUnsafe(length);
                const bytes = fs.readSync(fd, out, 0, length, offset);
                return out.subarray(0, bytes);
            }
            catch (e)
            {
                logger.error('VCB', 'read', `filepath='${this.filepath}' offset=${offset} len=${length} error:`, e);
                throw e;
            }
            finally
            {
                if (fd !== undefined) fs.closeSync(fd);
            }
        }

        throw new Error("VirtualNodeBuffer: no data backing");
    }

    /** Append or write data at an offset */
    write(offset: number, data: Buffer)
    {
        if (this.tmp)
        {
            fs.writeSync(this.tmp.fd, data, 0, data.length, offset);
            return;
        }

        if (this.buffer)
        {
            // Expand buffer if needed
            const end = offset + data.length;
            if (end > this.buffer.length)
            {
                const newBuf = Buffer.alloc(end);
                this.buffer.copy(newBuf, 0, 0, this.buffer.length);
                this.buffer = newBuf;
            }
            data.copy(this.buffer, offset);
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
            const { Readable } = require('stream');
            return Readable.from(this.buffer);
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
            return; // We don't own the file; nothing to clean up.
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
            return this.buffer.toString('utf8');
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

