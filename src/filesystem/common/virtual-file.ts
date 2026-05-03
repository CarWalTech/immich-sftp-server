import tmp from "tmp";
import { FileUtils } from "../utils/file-utils";
import { VirtualFsNode, VirtualFSNodeAttributes, VirtualFSNodeStats } from "./virtual-fs-node";

export class VirtualFile extends VirtualFsNode
{


    constructor(name: string, mtime: number = Date.now(), public parent: VirtualFsNode | null = null)
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
        console.error("Method not implemented.")
        return false;
    }
    async event_writefile(contents: tmp.FileResult): Promise<boolean>
    {
        console.error("Method not implemented.")
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
        console.error("Not a directory.")
        return false
    }
    async event_mkdir(name: string): Promise<boolean>
    {
        console.error("Not a directory.")
        return false
    }
}