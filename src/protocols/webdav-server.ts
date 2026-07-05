// ──────────────────────────────────────────────────────────────
// WebDAV Protocol Server — SFTP‑Equivalent Behavior
// ──────────────────────────────────────────────────────────────

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable, Writable } from 'stream';
import tmp from 'tmp';
import { v2 as webdav } from 'webdav-server';
import { config } from '../config';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { VirtualFileSystem } from '../filesystem/virtual-file-system';
import { ImmichFileSystem } from '../immich/immich-file-system';
import { logger } from '../logger';
import { Timestamp } from '../utils/date-utils';
import '../utils/xml-js-builder-patch';
import { TransferProtocolServer } from './transfer-protocol-server';

// ──────────────────────────────────────────────────────────────
// Shared path normalization (identical to SFTP)
// ──────────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  const normalized = path.posix.normalize(p);
  if (normalized === '.' || normalized === '') return '/';
  const abs = normalized.replace(/^\/+|\/+$/g, '');
  return '/' + abs;
}

// ──────────────────────────────────────────────────────────────
// Auth: identical to SFTP backend login
// ──────────────────────────────────────────────────────────────

interface ImmichWebdavUser extends webdav.IUser {
  readonly fsBackend: VirtualFileSystem;
}

interface CachedUser {
  readonly user: ImmichWebdavUser;
  readonly passwordBuf: Buffer;
  lastUsed: number;
}

const SESSION_TTL_MS = 60 * 60 * 1000;
const userCache = new Map<string, CachedUser>();

// In-flight deduplication: prevents concurrent requests from spawning multiple
// ImmichFileSystem login calls for the same credentials before the first resolves.
const authInflight = new Map<string, Promise<ImmichWebdavUser>>();

function pruneUserCache(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, entry] of userCache) {
    if (entry.lastUsed < cutoff) {
      entry.user.fsBackend.logout().catch(() => { });
      userCache.delete(key);
    }
  }
}

setInterval(pruneUserCache, 5 * 60 * 1000).unref();

function cbOk<T>(callback: (err: Error, value?: T) => void, value: T): void {
  callback(undefined!, value);
}

class ImmichWebdavUserManager implements webdav.ITestableUserManager {
  getDefaultUser(callback: (user: webdav.IUser) => void): void {
    callback({ uid: 'default', username: 'anonymous', isDefaultUser: true });
  }

  getUserByNamePassword(
    username: string,
    password: string,
    callback: (error: Error, user?: webdav.IUser) => void,
  ): void {
    const passwordBuf = Buffer.from(password, 'utf8');
    const cached = userCache.get(username);

    if (cached) {
      const match =
        cached.passwordBuf.length === passwordBuf.length &&
        crypto.timingSafeEqual(cached.passwordBuf, passwordBuf);

      if (match) {
        cached.lastUsed = Date.now();
        cbOk(callback, cached.user);
        return;
      }

      cached.user.fsBackend.logout().catch(() => { });
      userCache.delete(username);
    }

    // Deduplicate concurrent logins for the same credentials so a burst of
    // incoming requests doesn't spawn multiple ImmichFileSystem sessions.
    const inflightKey = `${username}\0${crypto.createHash('sha256').update(passwordBuf).digest('base64')}`;
    const existing = authInflight.get(inflightKey);
    if (existing) {
      existing
        .then(user => cbOk(callback, user))
        .catch(() => callback(new Error('Authentication failed')));
      return;
    }

    const fsBackend = new ImmichFileSystem();
    const promise = fsBackend
      .login(username, password)
      .then((): ImmichWebdavUser => {
        const user: ImmichWebdavUser = { uid: username, username, fsBackend };
        userCache.set(username, { user, passwordBuf, lastUsed: Date.now() });
        return user;
      })
      .finally(() => authInflight.delete(inflightKey));

    authInflight.set(inflightKey, promise);
    promise
      .then(user => cbOk(callback, user))
      .catch(() => callback(new Error('Authentication failed')));
  }
}

// ──────────────────────────────────────────────────────────────
// Upload stream — identical semantics to SFTP tmp‑file writes
// ──────────────────────────────────────────────────────────────

class WebdavUploadStream extends Writable {
  private readonly tmpFile = tmp.fileSync();
  private readonly writeStream: fs.WriteStream;
  private completed = false;

  constructor(
    private readonly targetPath: string,
    private readonly fsBackend: VirtualFileSystem,
  ) {
    super();
    this.writeStream = fs.createWriteStream(this.tmpFile.name);
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.writeStream.write(chunk, cb);
  }

  override _final(cb: (err?: Error | null) => void): void {
    this.writeStream.end(async () => {
      try {
        await this.fsBackend.writeFile(this.targetPath, new VirtualContentBuffer(this.tmpFile));
        await this.fsBackend.setAttributes(
          this.targetPath,
          Timestamp.currentTime(),
        );
        this.completed = true;
        cb();
      } catch (err) {
        cb(err as Error);
      }
    });
  }

  override _destroy(error: Error | null, cb: (err?: Error | null) => void): void {
    this.writeStream.destroy();
    if (!this.completed) this.tmpFile.removeCallback();
    cb(error);
  }
}

// ──────────────────────────────────────────────────────────────
// Serializer
// ──────────────────────────────────────────────────────────────

class NoopSerializer implements webdav.FileSystemSerializer {
  uid(): string { return 'ImmichWebdavSerializer_1.0.0'; }
  serialize(_fs: webdav.FileSystem, cb: webdav.ReturnCallback<unknown>): void { cb(undefined, {}); }
  unserialize(_data: unknown, cb: webdav.ReturnCallback<webdav.FileSystem>): void {
    cb(undefined, new ImmichWebdavFileSystem());
  }
}

// ──────────────────────────────────────────────────────────────
// Shared lock + property managers
// ──────────────────────────────────────────────────────────────

const lockManagers = new Map<string, webdav.LocalLockManager>();
const propManagers = new Map<string, webdav.LocalPropertyManager>();

function getLockManager(key: string): webdav.LocalLockManager {
  let m = lockManagers.get(key);
  if (!m) {
    m = new webdav.LocalLockManager();
    lockManagers.set(key, m);
  }
  return m;
}

function getPropManager(key: string): webdav.LocalPropertyManager {
  let m = propManagers.get(key);
  if (!m) {
    m = new webdav.LocalPropertyManager();
    propManagers.set(key, m);
  }
  return m;
}

function getBackend(ctx: webdav.IContextInfo): VirtualFileSystem | null {
  const user = ctx.context.user as ImmichWebdavUser | undefined;
  return user?.fsBackend ?? null;
}

// ──────────────────────────────────────────────────────────────
// WebDAV FileSystem — now identical to SFTP behavior
// ──────────────────────────────────────────────────────────────

class ImmichWebdavFileSystem extends webdav.FileSystem {
  constructor() {
    super(new NoopSerializer());
    this.doNotSerialize();
  }

  // ── abstract required ──────────────────────────────────────

  protected _lockManager(
    path: webdav.Path,
    _ctx: webdav.LockManagerInfo,
    callback: webdav.ReturnCallback<webdav.ILockManager>,
  ): void {
    callback(undefined, getLockManager(path.toString()));
  }

  protected _propertyManager(
    path: webdav.Path,
    _ctx: webdav.PropertyManagerInfo,
    callback: webdav.ReturnCallback<webdav.IPropertyManager>,
  ): void {
    callback(undefined, getPropManager(path.toString()));
  }

  // ── type detection ──────────────────────────────────────────

  protected _type(path: webdav.Path, ctx: webdav.TypeInfo, cb: webdav.ReturnCallback<webdav.ResourceType>): void {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    if (p === '/')
      return cb(undefined, webdav.ResourceType.Directory);

    backend.stat(p)
      .then(stat => {
        if (!stat || !stat.contents) return cb(webdav.Errors.ResourceNotFound);
        cb(undefined, stat.contents.isDir ? webdav.ResourceType.Directory : webdav.ResourceType.File);
      })
      .catch(err => cb(err));
  }

  // ── directory listing (match SFTP) ──────────────────────────

  protected _readDir(path: webdav.Path, ctx: webdav.ReadDirInfo, cb: webdav.ReturnCallback<string[]>): void {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    backend.listFiles(p)
      .then(files => {
        const names = files.map(f => f.name);
        cb(undefined, names);
      })
      .catch(err => cb(err));
  }

  // ── metadata ────────────────────────────────────────────────

  protected _size(path: webdav.Path, ctx: webdav.SizeInfo, cb: webdav.ReturnCallback<number>): void {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    backend.stat(p)
      .then(stat => {
        if (!stat || !stat.contents) return cb(webdav.Errors.ResourceNotFound);
        cb(undefined, stat.contents.size);
      })
      .catch(err => cb(err));
  }

  protected _lastModifiedDate(path: webdav.Path, ctx: webdav.LastModifiedDateInfo, cb: webdav.ReturnCallback<number>): void {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    backend.stat(p)
      .then(stat => {
        if (!stat || !stat.contents) return cb(webdav.Errors.ResourceNotFound);
        cb(undefined, stat.contents.mtime * 1000);
      })
      .catch(err => cb(err));
  }

  protected _creationDate(path: webdav.Path, ctx: webdav.CreationDateInfo, cb: webdav.ReturnCallback<number>): void {
    this._lastModifiedDate(path, ctx as any, cb);
  }

  // ── read stream (identical tmp semantics to SFTP) ───────────

  protected _openReadStream(path: webdav.Path, ctx: webdav.OpenReadStreamInfo, cb: webdav.ReturnCallback<Readable>): void {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    // Tie the Immich download to the HTTP client's connection lifetime.
    // When the client navigates away mid-download the 'close' event fires on
    // the response socket, aborting the in-flight axios stream and releasing
    // the download semaphore slot immediately.
    const ctrl = new AbortController();
    const res: import('http').ServerResponse | undefined = (ctx.context as any).response;
    const onClose = () => ctrl.abort();
    res?.once('close', onClose);

    backend.readFile(p, ctrl.signal)
      .then(tmpFile => {
        res?.removeListener('close', onClose);
        if (ctrl.signal.aborted) {
          // Client left before the download finished — discard and don't try to respond.
          tmpFile.removeCallback();
          return;
        }
        const stream = tmpFile.createReadStream();
        stream.once('close', () => tmpFile.removeCallback());
        stream.once('error', () => tmpFile.removeCallback());
        cb(undefined, stream);
      })
      .catch(err => {
        res?.removeListener('close', onClose);
        // Swallow abort errors — the client is already gone, nothing to respond to.
        if (ctrl.signal.aborted) return;
        cb(err);
      });
  }

  // ── write stream (identical to SFTP tmp‑write) ──────────────

  protected _openWriteStream(path: webdav.Path, ctx: webdav.OpenWriteStreamInfo, cb: webdav.ReturnCallback<Writable>): void {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    cb(undefined, new WebdavUploadStream(p, backend));
  }

  // ── create / delete / rename / move (match SFTP) ────────────

  protected _create(path: webdav.Path, ctx: webdav.CreateInfo, cb: webdav.SimpleCallback): void {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    if (ctx.type.isDirectory) {
      backend.mkdir(p).then(() => cb()).catch(err => cb(err));
    }
    else {
      cb(); // file creation handled by write stream
    }
  }

  protected _delete(path: webdav.Path, ctx: webdav.DeleteInfo, cb: webdav.SimpleCallback): void {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const p = normalizePath(path.toString());

    backend.remove(p).then(() => cb()).catch(err => cb(err));
  }

  protected _rename(pathFrom: webdav.Path, newName: string, ctx: webdav.RenameInfo, cb: webdav.ReturnCallback<boolean>): void {
    const backend = getBackend(ctx);
    if (!backend) return cb(webdav.Errors.ResourceNotFound);

    const oldPath = normalizePath(pathFrom.toString());
    const newPath = normalizePath(pathFrom.getParent().getChildPath(newName).toString());

    backend.rename(oldPath, newPath)
      .then(() => cb(undefined, true))
      .catch(err => cb(err));
  }

  protected _move(pathFrom: webdav.Path, pathTo: webdav.Path, ctx: webdav.MoveInfo, cb: webdav.ReturnCallback<boolean>): void {
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

export class WebdavProtocolServer implements TransferProtocolServer {
  readonly name = 'webdav';

  private readonly server = new webdav.WebDAVServer({
    port: config.PROTOCOL_PORTS_WEBDAV,
    hostname: config.PROTOCOL_HOST,
    requireAuthentification: true,
    httpAuthentication: new webdav.HTTPBasicAuthentication(
      new ImmichWebdavUserManager(),
      'Immich WebDAV',
    ),
    rootFileSystem: new ImmichWebdavFileSystem(),
    // Emit path-only hrefs (e.g. "/Albums/") instead of absolute URLs.
    // Required when running behind an HTTPS reverse proxy: the library
    // always builds "http://" hrefs but strict clients compare against
    // "https://", causing "Root not found in PROPFIND response".
    respondWithPaths: true,
  });

  async start(): Promise<void> {
    // Cap concurrent in-flight requests. Under extreme load this returns 503
    // immediately rather than letting requests queue until NextCloud times out
    // and reports the storage as disconnected.
    const MAX_CONCURRENT = 50;
    // If any single request takes longer than this, reply 503 and release the
    // slot so other requests aren't starved.
    const REQUEST_TIMEOUT_MS = 55_000;

    let activeRequests = 0;

    this.server.beforeRequest((ctx, next) => {
      if (activeRequests >= MAX_CONCURRENT) {
        ctx.response.writeHead(503, { 'Retry-After': '5', 'Content-Type': 'text/plain' });
        ctx.response.end('Server busy');
        return;
      }

      activeRequests++;

      // Decrement on response completion or client disconnect — whichever fires first.
      let settled = false;
      const settle = () => {
        if (!settled) { settled = true; activeRequests--; clearTimeout(timer); }
      };
      ctx.response.once('finish', settle);
      ctx.response.once('close', settle);

      const timer = setTimeout(() => {
        logger.warn('WebDAV', 'TIMEOUT', `Request timed out: ${ctx.request.method} ${ctx.request.url}`);
        try {
          if (!ctx.response.writableEnded) {
            ctx.response.writeHead(503, { 'Content-Type': 'text/plain' });
            ctx.response.end('Request timeout');
          }
        } catch { /* already ended */ }
      }, REQUEST_TIMEOUT_MS);

      next();
    });

    await new Promise<void>((resolve, reject) => {
      this.server.start((httpServer) => {
        if (!httpServer) {
          reject(new Error('WebDAV server failed to start'));
          return;
        }

        // Keep-alive slightly longer than a typical reverse-proxy (60 s) so the
        // proxy never closes the connection first and causes spurious reconnects.
        httpServer.keepAliveTimeout = 65_000;
        // Give clients enough time to finish sending headers even on slow links.
        httpServer.headersTimeout = 70_000;
        // Hard ceiling on how long any single request may occupy a connection slot.
        httpServer.requestTimeout = 60_000;
        // Disable the idle socket timeout — we rely on keepAliveTimeout instead.
        httpServer.timeout = 0;

        // Prevent malformed client connections from throwing unhandled exceptions.
        httpServer.on('error', (err: Error) => {
          logger.error('WebDAV', 'SERVER_ERROR', `HTTP server error: ${err.message}`);
        });
        httpServer.on('clientError', (err: Error, socket: any) => {
          logger.warn('WebDAV', 'CLIENT_ERROR', `Client socket error: ${err.message}`);
          try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* ignore */ }
        });

        logger.info(`WebDAV`, 'SERVER', `WebDAV server listening on ${config.PROTOCOL_HOST}:${config.PROTOCOL_PORTS_WEBDAV}`);
        resolve();
      });
    });
  }
}
