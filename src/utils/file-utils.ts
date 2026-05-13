import fs from 'fs';
import tmp from 'tmp';
import { VirtualContentBuffer } from '../filesystem/virtual-content-buffer';
import { pipeline } from 'stream/promises';

export class FileUtils
{

    /** Create a tmp-backed node containing a UTF-8 string */
    static tmpFromString(content: string): VirtualContentBuffer
    {
        const node = this.tmp();
        fs.writeFileSync(node.name, content, 'utf8');
        return node;
    }

    /** Create a tmp-backed node containing raw binary data */
    static tmpFromBuffer(buf: Buffer): VirtualContentBuffer
    {
        const node = this.tmp();
        fs.writeFileSync(node.name, buf);
        return node;
    }

    /** Create a node backed by an in-memory buffer */
    static buffer(buf: Buffer): VirtualContentBuffer
    {
        return new VirtualContentBuffer(undefined, buf);
    }

    /** Create an empty tmp-backed node */
    static tmp(): VirtualContentBuffer
    {
        return new VirtualContentBuffer(tmp.fileSync());
    }

    /** Create a tmp-backed node from a readable stream */
    static async tmpFromStream(stream: NodeJS.ReadableStream): Promise<VirtualContentBuffer>
    {
        const node = this.tmp();
        const writeStream = fs.createWriteStream(node.name);
        await pipeline(stream, writeStream);
        return node;
    }
}
