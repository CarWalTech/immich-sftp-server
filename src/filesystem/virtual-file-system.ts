import tmp from 'tmp';

// Interface: VirtualFileSystem
export interface VirtualFileSystem
{
    setAttributes(filename: string, mtime: number): Promise<void>;
    listFiles(currentDir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>;
    readFile(filename: string): Promise<tmp.FileResult>;
    writeFile(filename: string, tmpFile: tmp.FileResult): Promise<void>;
    stat(filename: string): Promise<{ isDir: boolean; size: number; mtime: number } | null>;
    rename(oldName: string, newName: string): Promise<void>;
    remove(filename: string): Promise<void>;
    mkdir(path: string): Promise<void>;

    login(username: string, password: string): Promise<void>;
    logout(): Promise<void>;
}

export type VirtualPathInfo = { parent: VirtualDirectory, node: VirtualFsNode | null, name: string }

export abstract class VirtualFsNode
{
    constructor(
        public name: string,
        public mtime: number = Date.now()
    ) { }

    abstract isDir(): boolean;
}

export class VirtualFile extends VirtualFsNode
{
    constructor(
        name: string,
        public content: Buffer,
        mtime: number = Date.now()
    )
    {
        super(name, mtime);
    }

    isDir() { return false; }

    get size()
    {
        return this.content.length;
    }
}

export class VirtualDirectory extends VirtualFsNode
{
    children: Map<string, VirtualFsNode> = new Map();

    constructor(name: string, mtime: number = Date.now())
    {
        super(name, mtime);
    }

    isDir() { return true; }

    add(node: VirtualFsNode)
    {
        this.children.set(node.name, node);
        return this;
    }

    get(name: string): VirtualFsNode | undefined
    {
        return this.children.get(name);
    }

    remove(name: string)
    {
        this.children.delete(name);
    }

    list(): VirtualFsNode[]
    {
        return [...this.children.values()];
    }

    resolvePath(path: string): VirtualPathInfo
    {
        return VirtualDirectory.resolvePath(this, path)
    }

    static resolvePath(root: VirtualDirectory, path: string): VirtualPathInfo
    {
        const parts = path.split("/").filter(Boolean);

        let current: VirtualDirectory = root;

        for (let i = 0; i < parts.length - 1; i++)
        {
            const next = current.get(parts[i]);
            if (!next || !next.isDir()) throw new Error(`Directory not found: ${parts[i]}`);
            current = next as VirtualDirectory;
        }

        const name = parts[parts.length - 1];
        const node = current.get(name) ?? null;

        return { parent: current, node, name };
    }

}