// prettier-ignore
import tmp from 'tmp'
import { VirtualMetadata } from './virtual-metadata';

export abstract class VirtualNode
{
    public name: string
    public mtime: number
    public parent: VirtualNode | null

    constructor(name: string, mtime: number = Date.now(), parent: VirtualNode | null = null)
    {
        this.name = name
        this.mtime = mtime
        this.parent = parent
    }

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
    abstract event_delete(recursive?: boolean): Promise<boolean>
    abstract event_stat(): Promise<VirtualMetadata>
    abstract event_rename(new_name: string): Promise<boolean>
    abstract event_setattr(attr: VirtualMetadata): Promise<boolean>





}