import { VirtualFile } from "../filesystem/virtual-file";
import { VirtualNode } from "../filesystem/virtual-node";
import { Timestamp } from "../utils/date-utils";
import { ImmichFileSystem } from "./immich-file-system";

export class ImmichVirtualFile extends VirtualFile
{
    readonly file_system: ImmichFileSystem;

    constructor(file_system: ImmichFileSystem, name: string, mtime?: Timestamp, parent?: VirtualNode | null)
    {
        super(name, mtime, parent)
        this.file_system = file_system
    }


}