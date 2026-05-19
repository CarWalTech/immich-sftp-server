import { FileEntry } from "ssh2";
import { DateUtils } from "../utils/date-utils";

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


    get longname()
    {
        const perms = this.isDir ? 'drwxr-xr-x' : '-rw-r--r--';
        const d = new Date(this.mtime * 1000);
        const dateStr = `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
        return `${perms} 1 user group ${this.size} ${dateStr} ${this.name}`
    }

    convertTo(method: 'sftp' | 'unknown')
    {
        switch (method)
        {
            case "sftp":
                return {
                    filename: this.name,
                    longname: this.longname,
                    attrs: {
                        size: this.size,
                        mtime: this.mtime,
                        atime: this.atime,
                        mode: this.mode,
                        uid: this.uid,
                        gid: this.gid,
                    }
                } as FileEntry
            case "unknown":
                throw new Error("unknown conversion type for Virtual Metadata")
        }

    }

    /** Regular file, read-write */
    public static file_rw(name: string, size: number, mtime?: number): VirtualMetadata
    {
        if (!mtime) mtime = DateUtils.getTimestampNow()
        return new VirtualMetadata(
            name,
            false,
            size,
            mtime,
            VirtualMetadata.MODE_FILE,
            0,
            0,
            mtime
            //0o100644 // rw-r--r--
        );
    }

    /** Regular file, read-only */
    public static file_ro(name: string, size: number, mtime?: number): VirtualMetadata
    {
        if (!mtime) mtime = DateUtils.getTimestampNow()
        return new VirtualMetadata(
            name,
            false,
            size,
            mtime,
            VirtualMetadata.MODE_FILE,
            0,
            0,
            mtime
            //0o100444 // r--r--r--
        );
    }

    /** Directory, read-write */
    public static directory_rw(name: string, mtime?: number): VirtualMetadata
    {
        if (!mtime) mtime = DateUtils.getTimestampNow()
        return new VirtualMetadata(
            name,
            true,
            0,
            mtime,
            VirtualMetadata.MODE_DIR,
            0,
            0,
            mtime
        );
    }

    /** Directory, read-only */
    public static directory_ro(name: string, mtime?: number): VirtualMetadata
    {
        if (!mtime) mtime = DateUtils.getTimestampNow()
        return new VirtualMetadata(
            name,
            true,
            0,
            mtime,
            VirtualMetadata.MODE_DIR_READONLY,
            0,
            0,
            mtime
        );
    }

    /** Unknown node type — safest fallback */
    public static unknown(name: string): VirtualMetadata
    {
        const now = DateUtils.getTimestampNow()
        return new VirtualMetadata(
            name,
            false,
            0,
            now,
            VirtualMetadata.MODE_FILE,
            0,
            0,
            now
        );
    }
}
