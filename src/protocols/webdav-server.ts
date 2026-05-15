// ──────────────────────────────────────────────────────────────
// WebDAV Protocol Server — SFTP‑Equivalent Behavior
// ──────────────────────────────────────────────────────────────

import fs from 'fs';
import tmp from 'tmp';
import crypto from 'crypto';
import { Writable, Readable } from 'stream';
import { v2 as webdav } from 'webdav-server';
import { config } from '../config';
import { ImmichFileSystem } from '../immich/immich-file-system';
import { VirtualFileSystem } from '../filesystem/virtual-file-system';
import { TransferProtocolServer } from './transfer-protocol-server';
import { logger } from '../logger';
import path from 'path';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";

// ──────────────────────────────────────────────────────────────
// Shared path normalization (identical to SFTP)
// ──────────────────────────────────────────────────────────────

function normalizePath(p: string): string
{
  const normalized = path.posix.normalize(p);
  if (normalized === '.' || normalized === '') return '/';
  const abs = normalized.replace(/^\/+|\/+$/g, '');
  return '/' + abs;
}

// ──────────────────────────────────────────────────────────────
// Auth: identical to SFTP backend login
// ──────────────────────────────────────────────────────────────

interface ImmichWebdavUser extends webdav.IUser
{
  readonly fsBackend: VirtualFileSystem;
}

interface CachedUser
{
  readonly user: ImmichWebdavUser;
  readonly passwordBuf: Buffer;
  lastUsed: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const userCache = new Map<string, CachedUser>();

function pruneUserCache(): void
{
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, entry] of userCache)
  {
    if (entry.lastUsed < cutoff)
    {
      entry.user.fsBackend.logout().catch(() => { });
      userCache.delete(key);
    }
  }
}

setInterval(pruneUserCache, 5 * 60 * 1000).unref();

function cbOk<T>(callback: (err: Error, value?: T) => void, value: T): void
{
  callback(undefined!, value);
}

class ImmichWebdavUserManager implements webdav.ITestableUserManager
{
  getDefaultUser(callback: (user: webdav.IUser) => void): void
  {
    callback({ uid: 'default', username: 'anonymous', isDefaultUser: true });
  }

  getUserByNamePassword(
    username: string,
    password: string,
    callback: (error: Error, user?: webdav.IUser) => void,
  ): void
  {
    const passwordBuf = Buffer.from(password, 'utf8');
    const cached = userCache.get(username);

    if (cached)
    {
      const match =
        cached.passwordBuf.length === passwordBuf.length &&
        crypto.timingSafeEqual(cached.passwordBuf, passwordBuf);

      if (match)
      {
        cached.lastUsed = Date.now();
        cbOk(callback, cached.user);
        return;
      }

      cached.user.fsBackend.logout().catch(() => { });
      userCache.delete(username);
    }

    const fsBackend = new ImmichFileSystem();
    fsBackend
      .login(username, password)
      .then(() =>
      {
        const user: ImmichWebdavUser = { uid: username, username, fsBackend };
        userCache.set(username, { user, passwordBuf, lastUsed: Date.now() });
        cbOk(callback, user);
      })
      .catch(() =>
      {
        callback(new Error('Authentication failed'));
      });
  }
}

// ──────────────────────────────────────────────────────────────
// Upload stream — identical semantics to SFTP tmp‑file writes
// ──────────────────────────────────────────────────────────────

class WebdavUploadStream extends Writable
{
  private readonly tmpFile = tmp.fileSync();
  private readonly writeStream: fs.WriteStream;
  private completed = false;

  constructor(
    private readonly targetPath: string,
    private readonly fsBackend: VirtualFileSystem,
  )
  {
    super();
    this.writeStream = fs.createWriteStream(this.tmpFile.name);
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void
  {
    this.writeStream.write(chunk, cb);
  }

  override _final(cb: (err?: Error | null) => void): void
  {
    this.writeStream.end(async () =>
    {
      try
      {
        await this.fsBackend.writeFile(this.targetPath, new VirtualContentBuffer(this.tmpFile));
        await this.fsBackend.setAttributes(
          this.targetPath,
          Math.floor(Date.now() / 1000),
        );
        this.completed = true;
        cb();
      } catch (err)
      {
        cb(err as Error);
      }
    });
  }

  override _destroy(error: Error | null, cb: (err?: Error | null) => void): void
  {
    this.writeStream.destroy();
    if (!this.completed) this.tmpFile.removeCallback();
    cb(error);
  }
}

// ──────────────────────────────────────────────────────────────
// Serializer
// ──────────────────────────────────────────────────────────────

class NoopSerializer implements webdav.FileSystemSerializer
{
  uid(): string { return 'ImmichWebdavSerializer_1.0.0'; }
  serialize(_fs: webdav.FileSystem, cb: webdav.ReturnCallback<unknown>): void { cb(undefined, {}); }
  unserialize(_data: unknown, cb: webdav.ReturnCallback<webdav.FileSystem>): void
  {
    cb(undefined, new ImmichWebdavFileSystem());
  }
}

// ──────────────────────────────────────────────────────────────
// Shared lock + property managers
// ──────────────────────────────────────────────────────────────

const lockManagers = new Map<string, webdav.LocalLockManager>();
const propManagers = new Map<string, webdav.LocalPropertyManager>();

function getLockManager(key: string): webdav.LocalLockManager
{
  let m = lockManagers.get(key);
  if (!m)
  {
    m = new webdav.LocalLockManager();
    lockManagers.set(key, m);
  }
  return m;
}

function getPropManager(key: string): webdav.LocalPropertyManager
{
  let m = propManagers.get(key);
  if (!m)
  {
    m = new webdav.LocalPropertyManager();
    propManagers.set(key, m);
  }
  return m;
}

function getBackend(ctx: webdav.IContextInfo): VirtualFileSystem | null
{
  const user = ctx.context.user as ImmichWebdavUser | undefined;
  return user?.fsBackend ?? null;
}

// ──────────────────────────────────────────────────────────────
// WebDAV FileSystem — now identical to SFTP behavior
// ──────────────────────────────────────────────────────────────

class ImmichWebdavFileSystem extends webdav.FileSystem
{
  constructor()
  {
    super(new NoopSerializer());
    this.doNotSerialize();
  }

  // ── abstract required ──────────────────────────────────────

  protected _lockManager(
    path: webdav.Path,
    _ctx: webdav.LockManagerInfo,
    callback: webdav.ReturnCallback<webdav.ILockManager>,
  ): void
  {
    callback(undefined, getLockManager(path.toString()));
  }

  protected _propertyManager(
    path: webdav.Path,
    _ctx: webdav.PropertyManagerInfo,
    callback: webdav.ReturnCallback<webdav.IPropertyManager>,
  ): void
  {
    callback(undefined, getPropManager(path.toString()));
  }

  // ── type detection ──────────────────────────────────────────

  protected _type(path: webdav.Path, ctx: webdav.TypeInfo, cb: webdav.ReturnCallback<webdav.ResourceType>): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    if (p === '/')
      return cb(undefined, webdav.ResourceType.Directory);

    backend.stat(p)
      .then(stat =>
      {
        if (!stat) return cb(webdav.Errors.ResourceNotFound);
        cb(undefined, stat.isDir ? webdav.ResourceType.Directory : webdav.ResourceType.File);
      })
      .catch(err => cb(err));
  }

  // ── directory listing (match SFTP) ──────────────────────────

  protected _readDir(path: webdav.Path, ctx: webdav.ReadDirInfo, cb: webdav.ReturnCallback<string[]>): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    backend.listFiles(p)
      .then(files =>
      {
        const names = ['.', '..', ...files.map(f => f.name)];
        cb(undefined, names);
      })
      .catch(err => cb(err));
  }

  // ── metadata ────────────────────────────────────────────────

  protected _size(path: webdav.Path, ctx: webdav.SizeInfo, cb: webdav.ReturnCallback<number>): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    backend.stat(p)
      .then(stat =>
      {
        if (!stat) return cb(webdav.Errors.ResourceNotFound);
        cb(undefined, stat.size);
      })
      .catch(err => cb(err));
  }

  protected _lastModifiedDate(path: webdav.Path, ctx: webdav.LastModifiedDateInfo, cb: webdav.ReturnCallback<number>): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    backend.stat(p)
      .then(stat =>
      {
        if (!stat) return cb(webdav.Errors.ResourceNotFound);
        cb(undefined, stat.mtime * 1000);
      })
      .catch(err => cb(err));
  }

  protected _creationDate(path: webdav.Path, ctx: webdav.CreationDateInfo, cb: webdav.ReturnCallback<number>): void
  {
    this._lastModifiedDate(path, ctx as any, cb);
  }

  // ── read stream (identical tmp semantics to SFTP) ───────────

  protected _openReadStream(path: webdav.Path, ctx: webdav.OpenReadStreamInfo, cb: webdav.ReturnCallback<Readable>): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    backend.readFile(p)
      .then(tmpFile =>
      {
        const stream = tmpFile.createReadStream();
        stream.once('close', () => tmpFile.removeCallback());
        stream.once('error', () => tmpFile.removeCallback());
        cb(undefined, stream);
      })
      .catch(err => cb(err));
  }

  // ── write stream (identical to SFTP tmp‑write) ──────────────

  protected _openWriteStream(path: webdav.Path, ctx: webdav.OpenWriteStreamInfo, cb: webdav.ReturnCallback<Writable>): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    cb(undefined, new WebdavUploadStream(p, backend));
  }

  // ── create / delete / rename / move (match SFTP) ────────────

  protected _create(path: webdav.Path, ctx: webdav.CreateInfo, cb: webdav.SimpleCallback): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    if (ctx.type.isDirectory)
    {
      backend.mkdir(p).then(() => cb()).catch(err => cb(err));
    }
    else
    {
      cb(); // file creation handled by write stream
    }
  }

  protected _delete(path: webdav.Path, ctx: webdav.DeleteInfo, cb: webdav.SimpleCallback): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    backend.remove(p).then(() => cb()).catch(err => cb(err));
  }

  protected _rename(pathFrom: webdav.Path, newName: string, ctx: webdav.RenameInfo, cb: webdav.ReturnCallback<boolean>): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const oldPath = normalizePath(pathFrom.toString());
    const newPath = normalizePath(pathFrom.getParent().getChildPath(newName).toString());

    backend.rename(oldPath, newPath)
      .then(() => cb(undefined, true))
      .catch(err => cb(err));
  }

  protected _move(pathFrom: webdav.Path, pathTo: webdav.Path, ctx: webdav.MoveInfo, cb: webdav.ReturnCallback<boolean>): void
  {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const oldPath = normalizePath(pathFrom.toString());
    const newPath = normalizePath(pathTo.toString());

    backend.rename(oldPath, newPath)
      .then(() => cb(undefined, true))
      .catch(err => cb(err));
  }
}

// ──────────────────────────────────────────────────────────────
// Protocol server
// ──────────────────────────────────────────────────────────────

export class WebdavProtocolServer implements TransferProtocolServer
{
  readonly name = 'webdav';

  private readonly server = new webdav.WebDAVServer({
    port: config.webdavPort,
    hostname: config.listenHost,
    requireAuthentification: true,
    httpAuthentication: new webdav.HTTPBasicAuthentication(
      new ImmichWebdavUserManager(),
      'Immich WebDAV',
    ),
    rootFileSystem: new ImmichWebdavFileSystem(),
  });

  async start(): Promise<void>
  {
    await new Promise<void>((resolve, reject) =>
    {
      this.server.start((httpServer) =>
      {
        if (!httpServer)
        {
          reject(new Error('WebDAV server failed to start'));
          return;
        }
        logger.info(`WebDAV`, 'SERVER', `WebDAV server listening on ${config.listenHost}:${config.webdavPort}`);
        resolve();
      });
    });
  }
}
