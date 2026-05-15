import tmp from 'tmp';
import { VirtualMetadata } from './virtual-metadata';
import { VirtualContentBuffer } from "./virtual-content-buffer";


export interface VirtualFileBuffer
{
    buffer: Buffer
}

// Interface: VirtualFileSystem
export interface VirtualFileSystem
{
    setAttributes(filename: string, mtime: number): Promise<void>;
    listFiles(currentDir: string): Promise<Array<VirtualMetadata>>;
    readFile(filename: string): Promise<VirtualContentBuffer>;
    writeFile(filename: string, tmpFile: VirtualContentBuffer): Promise<void>;
    stat(filename: string): Promise<VirtualMetadata>;
    rename(oldName: string, newName: string): Promise<boolean>;
    remove(filename: string): Promise<boolean>;
    mkdir(path: string): Promise<boolean>;

    login(username: string, password: string): Promise<void>;
    logout(): Promise<void>;
}












