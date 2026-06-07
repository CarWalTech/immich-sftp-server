import { VirtualDirectory, VirtualDirectoryOptions } from "../filesystem/virtual-directory";
import { VirtualNode } from "../filesystem/virtual-node";
import { ImmichFileSystem } from "./immich-file-system";

export class ImmichVirtualDirectory extends VirtualDirectory
{
    readonly file_system: ImmichFileSystem;

    constructor(file_system: ImmichFileSystem, name: string, mtime?: number, parent?: VirtualNode | null, options?: VirtualDirectoryOptions)
    {
        super(name, mtime, parent, options)
        this.file_system = file_system
    }


}