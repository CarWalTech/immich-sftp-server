// prettier-ignore
import tmp from 'tmp'

export type VirtualFSNodeListInfo = { name: string; isDir: boolean; size: number; mtime: number }
export type VirtualFSNodeStats = { isDir: boolean; size: number; mtime: number; };
export type VirtualFSNodeAttributes = { mtime: number; };
export abstract class VirtualFsNode
{
    constructor(
        public name: string,
        public mtime: number = Date.now(),
        public parent: VirtualFsNode | null = null
    ) { }

    get fullpath(): string
    {
        if (this.parent) return this.parent.fullpath + "/" + this.name
        else return "/" + this.name
    }

    abstract isDir(): boolean;


    abstract event_logout(): Promise<void>
    abstract event_readfile(): Promise<tmp.FileResult>
    abstract event_writefile(contents: tmp.FileResult): Promise<boolean>
    abstract event_createfile(name: string, contents: tmp.FileResult): Promise<boolean>
    abstract event_mkdir(name: string): Promise<boolean>
    abstract event_delete(): Promise<boolean>
    abstract event_stat(): Promise<VirtualFSNodeStats | null>
    abstract event_rename(new_name: string): Promise<boolean>
    abstract event_setattr(attr: VirtualFSNodeAttributes): Promise<boolean>
    public event_list_info(): VirtualFSNodeListInfo { return { name: this.name, isDir: this.isDir(), size: 0, mtime: this.mtime } }
    async event_deleterecursive(): Promise<boolean> { return await this.event_delete() }





}