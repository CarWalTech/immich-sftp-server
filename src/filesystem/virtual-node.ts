// prettier-ignore
import { Timestamp } from '../utils/date-utils';
import { VirtualContentBuffer } from "./virtual-content-buffer";
import { VirtualMetadata } from './virtual-metadata';

export abstract class VirtualNode
{
    public name: string
    public mtime: Timestamp
    public parent: VirtualNode | null

    constructor(name: string, mtime: Timestamp = Timestamp.now(), parent: VirtualNode | null = null)
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
    abstract event_readfile(): Promise<VirtualContentBuffer>
    abstract event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    abstract event_createfile(name: string, contents: VirtualContentBuffer): Promise<boolean>
    abstract event_mkdir(name: string): Promise<boolean>
    abstract event_delete(recursive?: boolean): Promise<boolean>
    abstract event_stat(): Promise<VirtualMetadata>
    abstract event_rename(new_name: string): Promise<boolean>
    abstract event_setattr(attr: VirtualMetadata): Promise<boolean>





}