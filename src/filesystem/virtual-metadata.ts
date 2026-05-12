
export class VirtualMetadata
{
    static readonly MODE_DIR = 0o040755;
    static readonly MODE_DIR_READONLY = 0o40555;
    static readonly MODE_FILE = 0o100644;

    /** The name of the node (filename or directory name) */
    public name: string;

    /** True if this node is a directory */
    public isDir: boolean;

    /** File size in bytes (0 for directories) */
    public size: number;

    /** Last modification time (UNIX seconds) */
    public mtime: number;

    /** Last access time (UNIX seconds) */
    public atime: number;

    /** POSIX mode bits (040755 for dirs, 100644 for files) */
    public mode: number;

    /** Owner UID (SFTP requires this even if always 0) */
    public uid: number;

    /** Owner GID (SFTP requires this even if always 0) */
    public gid: number;

    constructor(
        name: string,
        isDir: boolean,
        size: number,
        mtime: number,
        mode: number,
        uid: number = 0,
        gid: number = 0,
        atime: number = mtime
    )
    {
        this.name = name;
        this.isDir = isDir;
        this.size = size;
        this.mtime = mtime;
        this.atime = atime;
        this.mode = mode;
        this.uid = uid;
        this.gid = gid;
    }

    /** Regular file, read-write */
    public static file_rw(name: string, size: number, mtime: number): VirtualMetadata
    {
        return new VirtualMetadata(
            name,
            false,
            size,
            mtime,
            VirtualMetadata.MODE_FILE
            //0o100644 // rw-r--r--
        );
    }

    /** Regular file, read-only */
    public static file_ro(name: string, size: number, mtime: number): VirtualMetadata
    {
        return new VirtualMetadata(
            name,
            false,
            size,
            mtime,
            VirtualMetadata.MODE_FILE
            //0o100444 // r--r--r--
        );
    }

    /** Directory, read-write */
    public static directory_rw(name: string, mtime: number): VirtualMetadata
    {
        return new VirtualMetadata(
            name,
            true,
            0,
            mtime,
            VirtualMetadata.MODE_DIR
        );
    }

    /** Directory, read-only */
    public static directory_ro(name: string, mtime: number): VirtualMetadata
    {
        return new VirtualMetadata(
            name,
            true,
            0,
            mtime,
            VirtualMetadata.MODE_DIR_READONLY
        );
    }

    /** Unknown node type — safest fallback */
    public static unknown(name: string): VirtualMetadata
    {
        const now = Math.floor(Date.now() / 1000);
        return new VirtualMetadata(
            name,
            false,
            0,
            now,
            VirtualMetadata.MODE_FILE
        );
    }
}
