import './immich-sftp-patch';
import { Attributes, Server, Connection, Session, AcceptSftpConnection, RejectConnection, AcceptConnection, AuthContext, ServerChannel, SessionAccept, PseudoTtyInfo, WindowChangeInfo, X11Info, SetEnvInfo, SignalInfo, ExecInfo, SubsystemInfo, TransferOptions, Callback, WriteFileOptions, ReadStreamOptions, ReadStream, WriteStream, WriteStreamOptions, OpenMode, Stats, InputAttributes, FileEntry, FileEntryWithStats, ReadFileOptions, TcpipBindInfo, ServerCallback, TcpipRequestInfo, SocketRequestInfo, SocketBindInfo, NegotiatedAlgorithms, ServerConfig, ClientInfo } from 'ssh2';
import EventEmitter from 'events';
import { VirtualFileSystem } from '../src/filesystem/virtual-file-system';
import { Server as NetServer, Socket } from "net";



export type AcceptImmichSftpConnection = () => ImmichSFTPWrapper;
export type ServerConnectionListener = (client: Connection, info: ClientInfo) => void;

export class ImmichTCPServer extends Server
{
    static KEEPALIVE_CLIENT_INTERVAL: number;
    static KEEPALIVE_CLIENT_COUNT_MAX: number;

    constructor(cfg: ServerConfig, listener?: ServerConnectionListener)
    {
        super(cfg, listener)
    }

    injectSocket(socket: Socket): void
    {
        return super.injectSocket(socket)
    }

    on(event: string | symbol, listener: Function): this
    {
        return super.on(event, listener)
    }

    once(event: string | symbol, listener: Function): this
    {
        return super.on(event, listener)
    }
}

export interface ImmichSftpConnection extends EventEmitter
{
    fsBackend?: VirtualFileSystem;
    noMoreSessions: boolean;
    authenticated: boolean;

    on(event: "authentication", listener: (context: AuthContext) => void): this;
    on(event: "ready", listener: () => void): this;
    on(event: "session", listener: (accept: AcceptConnection<ImmichSftpConnectionSession>, reject: RejectConnection) => void): this;
    on(event: "tcpip", listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection, info: TcpipRequestInfo) => void,): this;
    on(event: "openssh.streamlocal", listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection, info: SocketRequestInfo) => void,): this;
    on(event: "request", listener: (accept: ((chosenPort?: number) => void) | undefined, reject: (() => void) | undefined, name: "tcpip-forward" | "cancel-tcpip-forward", info: TcpipBindInfo,) => void,): this;
    on(event: "request", listener: (accept: (() => void) | undefined, reject: () => void, name: "streamlocal-forward@openssh.com" | "cancel-streamlocal-forward@openssh.com", info: SocketBindInfo,) => void,): this;
    on(event: "rekey", listener: () => void): this;
    //on(event: "error", listener: ErrorCallback): this;
    on(event: "end", listener: () => void): this;
    on(event: "close", listener: () => void): this;
    on(event: "handshake", listener: (negotiated: NegotiatedAlgorithms) => void): this;
    on(event: "greeting", listener: (greeting: string) => void): this;

    once(event: "authentication", listener: (context: AuthContext) => void): this;
    once(event: "ready", listener: () => void): this;
    once(event: "session", listener: (accept: AcceptConnection<ImmichSftpConnectionSession>, reject: RejectConnection) => void): this;
    once(event: "tcpip", listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection, info: TcpipRequestInfo) => void,): this;
    once(event: "openssh.streamlocal", listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection, info: SocketRequestInfo) => void,): this;
    once(event: "request", listener: (accept: ((chosenPort?: number) => void) | undefined, reject: (() => void) | undefined, name: "tcpip-forward" | "cancel-tcpip-forward", info: TcpipBindInfo,) => void,): this;
    once(event: "request", listener: (accept: (() => void) | undefined, reject: () => void, name: "streamlocal-forward@openssh.com" | "cancel-streamlocal-forward@openssh.com", info: SocketBindInfo,) => void,): this;
    once(event: "rekey", listener: () => void): this;
    //once(event: "error", listener: ErrorCallback): this;
    once(event: "end", listener: () => void): this;
    once(event: "close", listener: () => void): this;
    once(event: "handshake", listener: (negotiated: NegotiatedAlgorithms) => void): this;
    once(event: "greeting", listener: (greeting: string) => void): this;

    end(): this;
    x11(originAddr: string, originPort: number, channel: ServerCallback): this;
    forwardOut(boundAddr: string, boundPort: number, remoteAddr: string, remotePort: number, callback: ServerCallback,): this;
    rekey(callback?: () => void): void;
    openssh_forwardOutStreamLocal(socketPath: string, callback: ServerCallback): this;
}

export interface ImmichSftpConnectionSession extends ServerChannel
{
    // Session events

    /**
     * Emitted when the client requested allocation of a pseudo-TTY for this session.
     */
    on(event: "pty", listener: (accept: SessionAccept, reject: RejectConnection, info: PseudoTtyInfo) => void): this;

    /**
     * Emitted when the client reported a change in window dimensions during this session.
     */
    on(
        event: "window-change",
        listener: (accept: SessionAccept, reject: RejectConnection, info: WindowChangeInfo) => void,
    ): this;

    /**
     * Emitted when the client requested X11 forwarding.
     */
    on(event: "x11", listener: (accept: SessionAccept, reject: RejectConnection, info: X11Info) => void): this;

    /**
     * Emitted when the client requested an environment variable to be set for this session.
     */
    on(event: "env", listener: (accept: SessionAccept, reject: RejectConnection, info: SetEnvInfo) => void): this;

    /**
     * Emitted when the client has sent a POSIX signal.
     */
    on(event: "signal", listener: (accept: SessionAccept, reject: RejectConnection, info: SignalInfo) => void): this;

    /**
     * Emitted when the client has requested incoming ssh-agent requests be forwarded to them.
     */
    on(event: "auth-agent", listener: (accept: SessionAccept, reject: RejectConnection) => void): this;

    /**
     * Emitted when the client has requested an interactive shell.
     */
    on(event: "shell", listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection) => void): this;

    /**
     * Emitted when the client has requested execution of a command string.
     */
    on(
        event: "exec",
        listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection, info: ExecInfo) => void,
    ): this;

    /**
     * Emitted when the client has requested the SFTP subsystem.
     */
    on(event: "sftp", listener: (accept: AcceptImmichSftpConnection, reject: RejectConnection) => void): this;

    /**
     * Emitted when the client has requested an arbitrary subsystem.
     */
    on(
        event: "subsystem",
        listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection, info: SubsystemInfo) => void,
    ): this;

    on(event: string | symbol, listener: Function): this;

    /**
     * Emitted when the client requested allocation of a pseudo-TTY for this session.
     */
    once(event: "pty", listener: (accept: SessionAccept, reject: RejectConnection, info: PseudoTtyInfo) => void): this;

    /**
     * Emitted when the client reported a change in window dimensions during this session.
     */
    once(
        event: "window-change",
        listener: (accept: SessionAccept, reject: RejectConnection, info: WindowChangeInfo) => void,
    ): this;

    /**
     * Emitted when the client requested X11 forwarding.
     */
    once(event: "x11", listener: (accept: SessionAccept, reject: RejectConnection, info: X11Info) => void): this;

    /**
     * Emitted when the client requested an environment variable to be set for this session.
     */
    once(event: "env", listener: (accept: SessionAccept, reject: RejectConnection, info: SetEnvInfo) => void): this;

    /**
     * Emitted when the client has sent a POSIX signal.
     */
    once(event: "signal", listener: (accept: SessionAccept, reject: RejectConnection, info: SignalInfo) => void): this;

    /**
     * Emitted when the client has requested incoming ssh-agent requests be forwarded to them.
     */
    once(event: "auth-agent", listener: (accept: SessionAccept, reject: RejectConnection) => void): this;

    /**
     * Emitted when the client has requested an interactive shell.
     */
    once(event: "shell", listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection) => void): this;

    /**
     * Emitted when the client has requested execution of a command string.
     */
    once(
        event: "exec",
        listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection, info: ExecInfo) => void,
    ): this;

    /**
     * Emitted when the client has requested the SFTP subsystem.
     */
    once(event: "sftp", listener: (accept: AcceptImmichSftpConnection, reject: RejectConnection) => void): this;

    /**
     * Emitted when the client has requested an arbitrary subsystem.
     */
    once(
        event: "subsystem",
        listener: (accept: AcceptConnection<ServerChannel>, reject: RejectConnection, info: SubsystemInfo) => void,
    ): this;

    once(event: string | symbol, listener: Function): this;
}

export interface ImmichSFTPWrapper extends EventEmitter
{
    /**
     * (Client-only)
     * Downloads a file at `remotePath` to `localPath` using parallel reads for faster throughput.
     */
    fastGet(remotePath: string, localPath: string, options: TransferOptions, callback: Callback): void;

    /**
     * (Client-only)
     * Downloads a file at `remotePath` to `localPath` using parallel reads for faster throughput.
     */
    fastGet(remotePath: string, localPath: string, callback: Callback): void;

    /**
     * (Client-only)
     * Uploads a file from `localPath` to `remotePath` using parallel reads for faster throughput.
     */
    fastPut(localPath: string, remotePath: string, options: TransferOptions, callback: Callback): void;

    /**
     * (Client-only)
     * Uploads a file from `localPath` to `remotePath` using parallel reads for faster throughput.
     */
    fastPut(localPath: string, remotePath: string, callback: Callback): void;

    /**
     * (Client-only)
     * Reads a file in memory and returns its contents
     */
    readFile(
        remotePath: string,
        options: ReadFileOptions,
        callback: (err: Error | undefined, handle: Buffer) => void,
    ): void;

    /**
     * (Client-only)
     * Reads a file in memory and returns its contents
     */
    readFile(
        remotePath: string,
        encoding: BufferEncoding,
        callback: (err: Error | undefined, handle: Buffer) => void,
    ): void;

    /**
     * (Client-only)
     * Reads a file in memory and returns its contents
     */
    readFile(remotePath: string, callback: (err: Error | undefined, handle: Buffer) => void): void;

    /**
     * (Client-only)
     * Returns a new readable stream for `path`.
     */
    createReadStream(path: string, options?: ReadStreamOptions): ReadStream;

    /**
     * (Client-only)
     * Writes data to a file
     */
    writeFile(remotePath: string, data: string | Buffer, options: WriteFileOptions, callback?: Callback): void;

    /**
     * (Client-only)
     * Writes data to a file
     */
    writeFile(remotePath: string, data: string | Buffer, encoding: string, callback?: Callback): void;

    /**
     * (Client-only)
     * Writes data to a file
     */
    writeFile(remotePath: string, data: string | Buffer, callback?: Callback): void;

    /**
     * (Client-only)
     * Appends data to a file
     */
    appendFile(remotePath: string, data: string | Buffer, options: WriteFileOptions, callback?: Callback): void;

    /**
     * (Client-only)
     * Appends data to a file
     */
    appendFile(remotePath: string, data: string | Buffer, callback?: Callback): void;

    /**
     * (Client-only)
     * Returns a new writable stream for `path`.
     */
    createWriteStream(path: string, options?: WriteStreamOptions): WriteStream;

    /**
     * (Client-only)
     * Opens a file `filename` for `mode` with optional `attributes`.
     */
    open(
        filename: string,
        mode: number | OpenMode,
        attributes: InputAttributes,
        callback: (err: Error | undefined, handle: Buffer) => void,
    ): void;
    open(
        filename: string,
        mode: number | OpenMode,
        attributes: string | number,
        callback: (err: Error | undefined, handle: Buffer) => void,
    ): void;

    /**
     * (Client-only)
     * Opens a file `filename` for `mode`.
     */
    open(filename: string, mode: number | OpenMode, callback: (err: Error | undefined, handle: Buffer) => void): void;

    /**
     * (Client-only)
     * Closes the resource associated with `handle` given by `open()` or `opendir()`.
     */
    close(handle: Buffer, callback: Callback): void;

    /**
     * (Client-only)
     * Reads `length` bytes from the resource associated with `handle` starting at `position`
     * and stores the bytes in `buffer` starting at `offset`.
     */
    read(
        handle: Buffer,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
        callback: (err: Error | undefined, bytesRead: number, buffer: Buffer, position: number) => void,
    ): void;

    /**
     * (Client-only)
     */
    write(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: Callback): void;

    /**
     * (Client-only)
     * Retrieves attributes for the resource associated with `handle`.
     */
    fstat(handle: Buffer, callback: (err: Error | undefined, stats: Stats) => void): void;

    /**
     * (Client-only)
     * Sets the attributes defined in `attributes` for the resource associated with `handle`.
     */
    fsetstat(handle: Buffer, attributes: InputAttributes, callback: Callback): void;

    /**
     * (Client-only)
     * Sets the access time and modified time for the resource associated with `handle`.
     */
    futimes(handle: Buffer, atime: number | Date, mtime: number | Date, callback: Callback): void;

    /**
     * (Client-only)
     * Sets the owner for the resource associated with `handle`.
     */
    fchown(handle: Buffer, uid: number, gid: number, callback: Callback): void;

    /**
     * (Client-only)
     * Sets the mode for the resource associated with `handle`.
     */
    fchmod(handle: Buffer, mode: number | string, callback: Callback): void;

    /**
     * (Client-only)
     * Opens a directory `path`.
     */
    opendir(path: string, callback: (err: Error | undefined, handle: Buffer) => void): void;

    /**
     * (Client-only)
     * Retrieves a directory listing.
     */
    readdir(location: string | Buffer, callback: (err: Error | undefined, list: FileEntryWithStats[]) => void): void;

    /**
     * (Client-only)
     * Removes the file/symlink at `path`.
     */
    unlink(path: string, callback: Callback): void;

    /**
     * (Client-only)
     * Renames/moves `srcPath` to `destPath`.
     */
    rename(srcPath: string, destPath: string, callback: Callback): void;

    /**
     * (Client-only)
     * Creates a new directory `path`.
     */
    mkdir(path: string, attributes: InputAttributes, callback: Callback): void;

    /**
     * (Client-only)
     * Creates a new directory `path`.
     */
    mkdir(path: string, callback: Callback): void;

    /**
     * (Client-only)
     * Removes the directory at `path`.
     */
    rmdir(path: string, callback: Callback): void;

    /**
     * (Client-only)
     * Retrieves attributes for `path`.
     */
    stat(path: string, callback: (err: Error | undefined, stats: Stats) => void): void;

    /**
     * (Client-only)
     * `path` exists.
     */
    exists(path: string, callback: (hasError: boolean) => void): void;

    /**
     * (Client-only)
     * Retrieves attributes for `path`. If `path` is a symlink, the link itself is stat'ed
     * instead of the resource it refers to.
     */
    lstat(path: string, callback: (err: Error | undefined, stats: Stats) => void): void;

    /**
     * (Client-only)
     * Sets the attributes defined in `attributes` for `path`.
     */
    setstat(path: string, attributes: InputAttributes, callback: Callback): void;

    /**
     * (Client-only)
     * Sets the access time and modified time for `path`.
     */
    utimes(path: string, atime: number | Date, mtime: number | Date, callback: Callback): void;

    /**
     * (Client-only)
     * Sets the owner for `path`.
     */
    chown(path: string, uid: number, gid: number, callback: Callback): void;

    /**
     * (Client-only)
     * Sets the mode for `path`.
     */
    chmod(path: string, mode: number | string, callback: Callback): void;

    /**
     * (Client-only)
     * Retrieves the target for a symlink at `path`.
     */
    readlink(path: string, callback: (err: Error | undefined, target: string) => void): void;

    /**
     * (Client-only)
     * Creates a symlink at `linkPath` to `targetPath`.
     */
    symlink(targetPath: string, linkPath: string, callback: Callback): void;

    /**
     * (Client-only)
     * Resolves `path` to an absolute path.
     */
    realpath(path: string, callback: (err: Error | undefined, absPath: string) => void): void;

    /**
     * (Client-only, OpenSSH extension)
     * Performs POSIX rename(3) from `srcPath` to `destPath`.
     */
    ext_openssh_rename(srcPath: string, destPath: string, callback: Callback): void;

    /**
     * (Client-only, OpenSSH extension)
     * Performs POSIX statvfs(2) on `path`.
     */
    ext_openssh_statvfs(path: string, callback: (err: Error | undefined, fsInfo: any) => void): void;

    /**
     * (Client-only, OpenSSH extension)
     * Performs POSIX fstatvfs(2) on open handle `handle`.
     */
    ext_openssh_fstatvfs(handle: Buffer, callback: (err: Error | undefined, fsInfo: any) => void): void;

    /**
     * (Client-only, OpenSSH extension)
     * Performs POSIX link(2) to create a hard link to `targetPath` at `linkPath`.
     */
    ext_openssh_hardlink(targetPath: string, linkPath: string, callback: Callback): void;

    /**
     * (Client-only, OpenSSH extension)
     * Performs POSIX fsync(3) on the open handle `handle`.
     */
    ext_openssh_fsync(handle: Buffer, callback: (err: Error | undefined, fsInfo: any) => void): void;

    /**
     * (Client-only, OpenSSH extension)
     * Similar to setstat(), but instead sets attributes on symlinks.
     */
    ext_openssh_lsetstat(path: string, attrs: InputAttributes, callback: Callback): void;
    ext_openssh_lsetstat(path: string, callback: Callback): void;

    /**
     * (Client-only, OpenSSH extension)
     * Similar to realpath(), but supports tilde-expansion, i.e. "~", "~/..." and "~user/...". These paths are expanded using shell-like rules.
     */
    ext_openssh_expandPath(path: string, callback: (err: Error | undefined, absPath: string) => void): void;

    /**
     * (Client-only)
     * Performs a remote file copy. If length is 0, then the server will read from srcHandle until EOF is reached.
     */
    ext_copy_data(
        handle: Buffer,
        srcOffset: number,
        len: number,
        dstHandle: Buffer,
        dstOffset: number,
        callback: Callback,
    ): void;

    /**
     * Emitted after initial protocol version check has passed
     */
    on(event: "ready", listener: () => void): this;
    on(event: "OPEN", listener: (reqId: number, filename: string, flags: number, attrs: Attributes) => void): this;
    on(event: "READ", listener: (reqId: number, handle: Buffer, offset: number, len: number) => void): this;
    on(event: "WRITE", listener: (reqId: number, handle: Buffer, offset: number, data: Buffer) => void): this;
    on(event: "FSTAT", listener: (reqId: number, handle: Buffer) => void): this;
    on(event: "FSETSTAT", listener: (reqId: number, handle: Buffer, attrs: Attributes) => void): this;
    on(event: "CLOSE", listener: (reqId: number, handle: Buffer) => void): this;
    on(event: "OPENDIR", listener: (reqId: number, path: string) => void): this;
    on(event: "READDIR", listener: (reqId: number, handle: Buffer) => void): this;
    on(event: "LSTAT", listener: (reqId: number, path: string) => void): this;
    on(event: "STAT", listener: (reqId: number, path: string) => void): this;
    on(event: "REMOVE", listener: (reqId: number, path: string) => void): this;
    on(event: "RMDIR", listener: (reqId: number, path: string) => void): this;
    on(event: "REALPATH", listener: (reqId: number, path: string) => void): this;
    on(event: "READLINK", listener: (reqId: number, path: string) => void): this;
    on(event: "SETSTAT", listener: (reqId: number, path: string, attrs: Attributes) => void): this;
    on(event: "MKDIR", listener: (reqId: number, path: string, attrs: Attributes) => void): this;
    on(event: "RENAME", listener: (reqId: number, oldPath: string, newPath: string) => void): this;
    on(event: "SYMLINK", listener: (reqId: number, targetPath: string, linkPath: string) => void): this;
    on(event: "EXTENDED", listener: (reqId: number, extName: string, extData: Buffer) => void): this;
    on(event: string | symbol, listener: Function): this;

    /**
     * Emitted after initial protocol version check has passed
     */
    once(event: "ready", listener: () => void): this;
    once(event: "OPEN", listener: (reqId: number, filename: string, flags: number, attrs: Attributes) => void): this;
    once(event: "READ", listener: (reqId: number, handle: Buffer, offset: number, len: number) => void): this;
    once(event: "WRITE", listener: (reqId: number, handle: Buffer, offset: number, data: Buffer) => void): this;
    once(event: "FSTAT", listener: (reqId: number, handle: Buffer) => void): this;
    once(event: "FSETSTAT", listener: (reqId: number, handle: Buffer, attrs: Attributes) => void): this;
    once(event: "CLOSE", listener: (reqId: number, handle: Buffer) => void): this;
    once(event: "OPENDIR", listener: (reqId: number, path: string) => void): this;
    once(event: "READDIR", listener: (reqId: number, handle: Buffer) => void): this;
    once(event: "LSTAT", listener: (reqId: number, path: string) => void): this;
    once(event: "STAT", listener: (reqId: number, path: string) => void): this;
    once(event: "REMOVE", listener: (reqId: number, path: string) => void): this;
    once(event: "RMDIR", listener: (reqId: number, path: string) => void): this;
    once(event: "REALPATH", listener: (reqId: number, path: string) => void): this;
    once(event: "READLINK", listener: (reqId: number, path: string) => void): this;
    once(event: "SETSTAT", listener: (reqId: number, path: string, attrs: Attributes) => void): this;
    once(event: "MKDIR", listener: (reqId: number, path: string, attrs: Attributes) => void): this;
    once(event: "RENAME", listener: (reqId: number, oldPath: string, newPath: string) => void): this;
    once(event: "SYMLINK", listener: (reqId: number, targetPath: string, linkPath: string) => void): this;
    once(event: "EXTENDED", listener: (reqId: number, extName: string, extData: Buffer) => void): this;
    once(event: string | symbol, listener: Function): this;

    /**
     * Sends a status response for the request identified by id.
     */
    status(reqId: number, code: number, message?: string): void;

    /**
     * Sends a handle response for the request identified by id.
     * handle must be less than 256 bytes and is an opaque value that could merely contain the value of a
     * backing file descriptor or some other unique, custom value.
     */
    handle(reqId: number, handle: Buffer): void;

    /**
     * Sends a data response for the request identified by id. data can be a Buffer or string.
     * If data is a string, encoding is the encoding of data.
     */
    data(reqId: number, data: Buffer | string, encoding?: BufferEncoding): void;

    /**
     * Sends a name response for the request identified by id.
     */
    name(reqId: number, names: FileEntry[]): void;

    /**
     * Sends an attrs response for the request identified by id.
     */
    attrs(reqId: number, attrs: Attributes): void;

    /**
     * Closes the channel.
     */
    end(): void;

    /**
     * Closes the channel.
     */
    destroy(): void;
}




