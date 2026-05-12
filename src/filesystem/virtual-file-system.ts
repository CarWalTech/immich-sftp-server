import tmp from 'tmp';
import { VirtualMetadata } from './virtual-metadata';


// Interface: VirtualFileSystem
export interface VirtualFileSystem
{
    setAttributes(filename: string, mtime: number): Promise<void>;
    listFiles(currentDir: string): Promise<Array<VirtualMetadata>>;
    readFile(filename: string): Promise<tmp.FileResult>;
    writeFile(filename: string, tmpFile: tmp.FileResult): Promise<void>;
    stat(filename: string): Promise<VirtualMetadata>;
    rename(oldName: string, newName: string): Promise<boolean>;
    remove(filename: string): Promise<boolean>;
    mkdir(path: string): Promise<boolean>;

    login(username: string, password: string): Promise<void>;
    logout(): Promise<void>;
}












