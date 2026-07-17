import tmp from 'tmp';
import { VirtualMetadata } from './virtual-metadata';
import { VirtualContentBuffer } from "./virtual-content-buffer";


export interface VirtualFileBuffer
{
    buffer: Buffer
}

export interface VFSResponse<T>
{
    success: boolean
    contents?: T
}

// A single HTTP byte-range request, in the three forms RFC 7233 allows:
// {start, end} / {start} (open-ended) / {suffixLength} ("last N bytes").
export interface RangeSpec
{
    start?: number;
    end?: number;
    suffixLength?: number;
}

export interface RangeReadResult
{
    stream: NodeJS.ReadableStream;
    start: number; // inclusive, resolved against the asset's actual size
    end: number;   // inclusive, resolved against the asset's actual size
    total: number; // total size of the underlying asset
}

// Interface: VirtualFileSystem
export interface VirtualFileSystem
{
    setAttributes(filename: string, mtime: number): Promise<void>;
    listFiles(currentDir: string): Promise<Array<VirtualMetadata>>;
    readFile(filename: string, signal?: AbortSignal): Promise<VirtualContentBuffer>;
    // Optional: true byte-range pass-through for GET Range requests (video seeking,
    // partial reads). Returning null tells the caller to fall back to a full readFile().
    readFileRange?(filename: string, range: RangeSpec, signal?: AbortSignal): Promise<RangeReadResult | null>;
    writeFile(filename: string, tmpFile: VirtualContentBuffer): Promise<void>;
    stat(filename: string): Promise<VFSResponse<VirtualMetadata>>;
    rename(oldName: string, newName: string): Promise<boolean>;
    remove(filename: string): Promise<boolean>;
    mkdir(path: string): Promise<boolean>;

    login(username: string, password: string): Promise<void>;
    logout(): Promise<void>;
    isAuthenticated(): boolean;
}












