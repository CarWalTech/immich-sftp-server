import { logger } from "../logger";
import { Timestamp } from "../utils/date-utils";
import { VirtualContentBuffer, VirtualContentBufferUtils } from "./virtual-content-buffer";
import { VirtualMetadata } from './virtual-metadata';
import { VirtualNode } from "./virtual-node";
import { RangeReadResult, RangeSpec, StreamReadResult } from "./virtual-file-system";

export class VirtualFile extends VirtualNode
{


    constructor(name: string, mtime: Timestamp = Timestamp.now(), public parent: VirtualNode | null = null)
    {
        super(name, mtime, parent);
    }

    isDir() { return false; }

    async get_content()
    {
        return "";
    }
    async get_size()
    {
        return 0;
    }



    async event_logout(): Promise<void>
    {
        return;
    }
    async event_readfile(_signal?: AbortSignal): Promise<VirtualContentBuffer>
    {
        const content = await this.get_content();
        return VirtualContentBufferUtils.bufferFromString(content)
    }
    // Default: no range support. Callers fall back to a full event_readfile() + in-memory slice.
    async event_readfile_range(_range: RangeSpec, _signal?: AbortSignal): Promise<RangeReadResult | null>
    {
        return null;
    }
    // Default: no streaming support. Callers fall back to a full event_readfile().
    async event_readfile_stream(_signal?: AbortSignal): Promise<StreamReadResult | null>
    {
        return null;
    }
    async event_delete()
    {
        logger.error("VirtualFile", "Delete", "error", "Method Not Implemented")
        return false;
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        logger.error("VirtualFile", "WriteFile", "error", "Method Not Implemented")
        return false
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        const size = await this.get_size();
        return VirtualMetadata.file_rw(this.name, size, this.mtime);
    }
    async event_rename(new_name: string): Promise<boolean>
    {
        logger.error("VirtualFile", "Rename", "error", "Method Not Implemented")
        return false
    }
    async event_setattr(attr: VirtualMetadata): Promise<boolean>
    {
        logger.error("VirtualFile", "SetAttributes", "error", "Method Not Implemented")
        return false
    }
    async event_createfile(name: string, contents: VirtualContentBuffer): Promise<boolean>
    {
        logger.error("VirtualFile", "CreateFile", "error", "Method Not Implemented")
        return false
    }
    async event_mkdir(name: string): Promise<boolean>
    {
        logger.error("VirtualFile", "MkDir", "error", "Method Not Implemented")
        return false
    }
}