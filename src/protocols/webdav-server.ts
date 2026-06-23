// ──────────────────────────────────────────────────────────────
// WebDAV Protocol Server — SFTP‑Equivalent Behavior
// ──────────────────────────────────────────────────────────────

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Readable, Writable } from 'stream';
import tmp from 'tmp';
import { v2 as webdav } from 'webdav-server';

// ── Runtime patch for xml-js-builder namespace bugs ──────────────────────────
// The library has two bugs that mangle non-DAV namespace properties (e.g. owncloud).
//
// Bug 1 — mutateNodeNS (parse phase, XMLElementUtil.js):
//   Namespace URI and local name are concatenated without a separator:
//   "http://owncloud.org/ns" + "permissions" → "http://owncloud.org/nspermissions"
//   Fix: insert '/' when URI doesn't already end with '/' or ':'
//
// Bug 2 — setFreeNamespaceName (serialize phase, unexported closure in XMLElementBuilder.js):
//   Appends a trailing ':' to HTTP namespace URIs in xmlns declarations:
//   xmlns:a="http://owncloud.org/ns:" (wrong) → should be xmlns:a="http://owncloud.org/ns"
//   Fix: post-process xmlns attribute values in XMLElementBuilder.prototype.add
//
// Patching live module exports rather than node_modules files means the fix
// survives `npm install`.
(function patchXmlJsBuilder(): void {
  // ── Fix 1: parse phase ────────────────────────────────────────────────────
  // XML.js captures the XMLElementUtil exports object by reference, so
  // replacing mutateNodeNS here affects all subsequent XML.parseXML calls.
  type NSMap = Record<string, string>;
  type AnyNode = Record<string, unknown>;

  function seekForNS(node: AnyNode, parentNS: NSMap): NSMap {
    if (!node.attributes) return parentNS;
    const ns: NSMap = { ...parentNS };
    const attrs = node.attributes as Record<string, string>;
    for (const name in attrs) {
      if (name.indexOf('xmlns:') === 0 || name === 'xmlns') {
        if (name === 'xmlns') ns['_default'] = attrs[name];
        else ns[name.substring('xmlns:'.length)] = attrs[name];
      }
    }
    return ns;
  }

  function patchedMutateNodeNS(node: AnyNode, parentNS: NSMap = {}): unknown {
    if (!node) return undefined;
    if (node['find']) return node;

    const nss = seekForNS(node, parentNS);
    if (node.name) {
      for (const ns in nss) {
        if (ns === '_default' && (node.name as string).indexOf(':') === -1) {
          node.name = nss[ns] + node.name;
          break;
        } else if ((node.name as string).indexOf(ns + ':') === 0) {
          const nsUri = nss[ns];
          const localName = (node.name as string).substring((ns + ':').length);
          // Insert separator when URI doesn't already end with '/' or ':'
          const sep = (nsUri.endsWith('/') || nsUri.endsWith(':')) ? '' : '/';
          node.name = nsUri + sep + localName;
          break;
        }
      }
    }

    const elements: unknown[] = (node.elements as unknown[]) ?? [];
    node['findIndex'] = (name: string): number => {
      for (let i = 0; i < elements.length; ++i)
        if ((elements[i] as AnyNode)?.name === name) return i;
      return -1;
    };
    node['find'] = (name: string): unknown => {
      for (const e of elements)
        if ((e as AnyNode)?.name === name) return e;
      throw new Error('Cannot find the XML element : ' + name);
    };
    node['findMany'] = (name: string): unknown[] =>
      elements.filter(e => (e as AnyNode)?.name === name);
    node['findText'] = (): string => {
      for (const e of elements)
        if ((e as AnyNode)?.type === 'text') return (e as AnyNode).text as string;
      return '';
    };
    node['findTexts'] = (): string[] =>
      elements.filter(e => (e as AnyNode)?.type === 'text').map(e => (e as AnyNode).text as string);

    if (node.elements)
      (node.elements as AnyNode[]).forEach(n => patchedMutateNodeNS(n, nss));
    else
      node.elements = [];

    return node;
  }

  const xmlUtil = require('xml-js-builder/lib/XMLElementUtil') as { mutateNodeNS: unknown };
  xmlUtil.mutateNodeNS = patchedMutateNodeNS;

  // ── Fix 2: serialize phase ────────────────────────────────────────────────
  // setFreeNamespaceName is an unexported closure, so we can't replace it.
  // Instead we wrap XMLElementBuilder.prototype.add to strip the trailing ':'
  // that the function incorrectly appends to HTTP namespace URIs.
  const { XMLElementBuilder } = require('xml-js-builder/lib/XMLElementBuilder') as {
    XMLElementBuilder: { prototype: { add(el: unknown): unknown } };
  };
  const origAdd = XMLElementBuilder.prototype.add;
  XMLElementBuilder.prototype.add = function (element: unknown): unknown {
    const result = origAdd.call(this, element);
    function fixXmlns(el: unknown): void {
      if (!el || (el as AnyNode).type !== 'element') return;
      const node = el as AnyNode;
      if (node.attributes) {
        const attrs = node.attributes as Record<string, string>;
        for (const key of Object.keys(attrs)) {
          if (key.startsWith('xmlns:') && typeof attrs[key] === 'string') {
            const val = attrs[key];
            // Strip trailing ':' that setFreeNamespaceName incorrectly adds to HTTP URIs
            if (/^https?:\/\//.test(val) && val.endsWith(':'))
              attrs[key] = val.slice(0, -1);
          }
        }
      }
      if (node.elements) (node.elements as unknown[]).forEach(fixXmlns);
    }
    if (result) fixXmlns(result);
    return result;
  };
})();
import { config } from '../config';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { VirtualFileSystem } from '../filesystem/virtual-file-system';
import { ImmichFileSystem } from '../immich/immich-file-system';
import { logger } from '../logger';
import { Timestamp } from '../utils/date-utils';
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

    const fsBackend = new ImmichFileSystem();
    fsBackend
      .login(username, password)
      .then(() => {
        const user: ImmichWebdavUser = { uid: username, username, fsBackend };
        userCache.set(username, { user, passwordBuf, lastUsed: Date.now() });
        cbOk(callback, user);
      })
      .catch(() => {
        callback(new Error('Authentication failed'));
      });
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

    backend.readFile(p)
      .then(tmpFile => {
        const stream = tmpFile.createReadStream();
        stream.once('close', () => tmpFile.removeCallback());
        stream.once('error', () => tmpFile.removeCallback());
        cb(undefined, stream);
      })
      .catch(err => cb(err));
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
    this.server.beforeRequest((ctx, next) => {
      if (ctx.request.method === 'PROPFIND') {
        logger.info('WebDAV', 'PROPFIND_REQ',
          `${ctx.request.method} ${ctx.request.url} Depth:${ctx.request.headers['depth'] ?? '?'} Host:${ctx.request.headers['host']}`);
      }
      next();
    });

    this.server.afterRequest((ctx, next) => {
      if (ctx.request.method === 'PROPFIND') {
        const body = (ctx as any).responseBody ?? '';
        logger.info('WebDAV', 'PROPFIND_RES',
          `${ctx.response.statusCode} body:\n${body}`);
      }
      next();
    });

    await new Promise<void>((resolve, reject) => {
      this.server.start((httpServer) => {
        if (!httpServer) {
          reject(new Error('WebDAV server failed to start'));
          return;
        }
        logger.info(`WebDAV`, 'SERVER', `WebDAV server listening on ${config.PROTOCOL_HOST}:${config.PROTOCOL_PORTS_WEBDAV}`);
        resolve();
      });
    });
  }
}
