import tmp from "tmp";
import { FileUtils } from "../utils/file-utils";
import { VirtualNode } from "./virtual-node";
import { VirtualMetadata } from './virtual-metadata';
import { logger } from "../logger";

export class VirtualFile extends VirtualNode
{


    constructor(name: string, mtime: number = Date.now(), public parent: VirtualNode | null = null)
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
    async event_readfile()
    {
        const content = await this.get_content();
        return FileUtils.createTmpFile(content);
    }
    async event_delete()
    {
        logger.error("VirtualFile", "Delete", "error", "Method Not Implemented")
        return false;
    }
    async event_writefile(contents: tmp.FileResult): Promise<boolean>
    {
        logger.error("VirtualFile", "WriteFile", "error", "Method Not Implemented")
        return false
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        const size = await this.get_size();
        return VirtualMetadata.file_rw(
            this.name,
            size,
            Math.floor(Date.now() / 1000)
        );
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
    async event_createfile(name: string, contents: tmp.FileResult): Promise<boolean>
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