import fs from 'fs';
import { AcceptConnection, Attributes, AuthContext, Connection, RejectConnection, Server, ServerConfig, ServerConnectionListener, Session, SFTPWrapper } from 'ssh2';
import path, { basename } from 'path';
import crypto from 'crypto';
import tmp from 'tmp';
import { VirtualFileSystem } from '../filesystem/virtual-file-system';
import { ImmichFileSystem } from '../immich/immich-file-system';
import { config } from '../config';
import { TransferProtocolServer } from './transfer-protocol-server';
import { VirtualMetadata } from '../filesystem/virtual-metadata';
import { logger } from '../logger';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { DateUtils } from '../utils/date-utils';

// #region TCP Receivers

async function TCP_Authentication(con: SftpConnection, ctx: AuthContext)
{
  logger.info('SFTP', 'Authentication', `Authenticating connection (method: ${ctx.method})`);

  if (ctx.method === 'password')
  {
    if (!con.fsBackend) throw new Error("Backend not Initalized");

    //Login
    try
    {
      await con.fsBackend.login(ctx.username, ctx.password);
    } catch (err)
    {
      logger.error('SFTP', 'Authentication', 'Authentication failed:', err);
      return ctx.reject();
    }

    logger.info('SFTP', 'Authentication', 'User authenticated successfully');
    ctx.accept();
  }
  else
  {
    // Return supported authentication methods
    return ctx.reject(['password']);
  }
}

async function TCP_End(con: SftpConnection)
{
  if (con.fsBackend) await con.fsBackend.logout();
  logger.info('SFTP', 'SOCKET', 'Client disconnected');
}

function TCP_Greeting(con: SftpConnection, greeting: string)
{
  logger.info('SFTP', 'SOCKET', `greet: ${greeting}`)
}

function TCP_Error(con: SftpConnection, err: Error)
{
  logger.error('SFTP', 'SOCKET', `Connection error: ${err.message}`);
}

function TCP_Session(con: SftpConnection, accept: AcceptConnection<Session>, reject: RejectConnection)
{
  // Reject the session if the user has not completed login on this connection.
  if (!con.fsBackend?.isAuthenticated())
  {
    logger.warn('SFTP', 'SESSION', 'Session requested without authenticated user — rejecting.');
    reject();
    return;
  }

  const session = accept();
  logger.info('SFTP', 'SOCKET', 'Session started');
  session.on('sftp', (accept, reject) =>
  {
    const fsBackend = con.fsBackend;
    const netConfig = con.cfg;

    // Re-check: the user could have logged out between the session open and
    // the SFTP subsystem request (e.g. TCP_End fired concurrently).
    if (!fsBackend || !fsBackend.isAuthenticated() || !netConfig)
    {
      logger.warn('SFTP', 'SOCKET', 'SFTP subsystem requested with no authenticated backend — rejecting.');
      reject();
      return;
    }

    //Accept SFTP session
    const sftpStream = accept();
    logger.info('SFTP', 'SOCKET', 'SFTP session started');

    //Handle map
    const handleMap: Record<string, SftpHandleEntry> = {};

    const phaseOnePending = new Map<string, number>(); // path → expiry ms

    const service: SftpConnectionInstance = {
      fsBackend,
      handleMap,
      sftpStream,
      netConfig,
      phaseOnePending
    }

    sftpStream.on('ready', async () => { await SFTP_READY(service) });
    sftpStream.on('OPEN', async (reqid: number, filename: string, flags: number, attrs: Attributes) => { await SFTP_OPEN(service, reqid, filename, flags, attrs) });
    sftpStream.on('READ', async (reqid: number, handle: Buffer, offset: number, len: number) => { await SFTP_READ(service, reqid, handle, offset, len) });
    sftpStream.on('WRITE', async (reqid: number, handle: Buffer, offset: number, data: Buffer) => { await SFTP_WRITE(service, reqid, handle, offset, data) });
    sftpStream.on('FSTAT', async (reqid: number, handle: Buffer) => { await SFTP_FSTAT(service, reqid, handle) });
    sftpStream.on('FSETSTAT', async (reqid: number, handle: Buffer, attrs: Attributes) => { await SFTP_FSETSTAT(service, reqid, handle, attrs) });
    sftpStream.on('CLOSE', async (reqid: number, handle: Buffer) => { await SFTP_CLOSE(service, reqid, handle) });
    sftpStream.on('OPENDIR', async (reqid: number, rawPath) => { await SFTP_OPENDIR(service, reqid, rawPath) });
    sftpStream.on('READDIR', async (reqid: number, handle) => { await SFTP_READDIR(service, reqid, handle) });
    sftpStream.on("LSTAT", async (reqid: number, path: string) => { await SFTP_LSTAT(service, reqid, path) });
    sftpStream.on('STAT', async (reqid: number, filePath) => { await SFTP_STAT(service, reqid, filePath) });
    sftpStream.on('REMOVE', async (reqid: number, filePath) => { await SFTP_REMOVE(service, reqid, filePath) });
    sftpStream.on('RMDIR', async (reqid, dirPath) => { await SFTP_RMDIR(service, reqid, dirPath) });
    sftpStream.on('REALPATH', async (reqid: number, givenPath) => { await SFTP_REALPATH(service, reqid, givenPath) });
    sftpStream.on('READLINK', async (reqid: number, path: string) => { await SFTP_READLINK(service, reqid, path) });
    sftpStream.on('SETSTAT', async (reqid: number, filePath, attrs: Attributes) => { await SFTP_SETSTAT(service, reqid, filePath, attrs) });
    sftpStream.on('MKDIR', async (reqid: number, dirPath, attrs) => { await SFTP_MKDIR(service, reqid, dirPath, attrs) });
    sftpStream.on('RENAME', async (reqid: number, oldPath, newPath) => { await SFTP_RENAME(service, reqid, oldPath, newPath) });
    sftpStream.on('SYMLINK', async (reqid: number, targetPath: string, linkPath: string) => { await SFTP_SYMLINK(service, reqid, targetPath, linkPath) });
    sftpStream.on('EXTENDED', async (reqid: number, extName: string, extData: Buffer) => { await SFTP_EXTENDED(service, reqid, extName, extData) });

    // Clean up tmp files for any write handles that were never CLOSE'd
    // (e.g. when the client drops the connection mid-upload).
    sftpStream.on('close', () =>
    {
      for (const key of Object.keys(handleMap))
      {
        const entry = handleMap[key];
        if (!entry.closed && entry.writeNode)
        {
          logger.warn('SFTP', 'CLEANUP', `Connection dropped with open write handle: ${entry.path}`);
          try { entry.writeNode.removeCallback(); } catch { }
        }
      }
      phaseOnePending.clear();
    });
  });
}

// #endregion

// #region SFTP Functions: DIR

async function SFTP_REALPATH(self: SftpConnectionInstance, reqid: number, givenPath: string)
{
  try
  {
    const normalized = normalizePath(givenPath);
    logger.info('SFTP', 'REALPATH', `reqid=${reqid} path=${givenPath} → ${normalized}`);
    self.sftpStream.name(reqid, [
      {
        filename: normalized,
        longname: `drwxr-xr-x 1 user group 0 0 Jan 1 00:00 ${normalized}`,
        attrs: createFolderAttributes()
      }
    ]);
  } catch (e)
  {
    logger.error('SFTP', 'REALPATH', `reqid=${reqid} error=${e}`);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_OPENDIR(self: SftpConnectionInstance, reqid: number, rawPath: string)
{
  try
  {
    const normalized = normalizePath(rawPath);

    // ASCII-safe handle key
    const key = crypto.randomBytes(16).toString('hex');
    const handle = Buffer.from(key, 'ascii');

    logger.info('SFTP', 'OPENDIR', `reqid=${reqid} path='${rawPath}' → '${normalized}', handle=${key}`);

    self.handleMap[key] = {
      path: normalized,
      intendedName: basename(normalized),
      directoryEntryRead: false,
      readInitPromise: null
    };
    self.sftpStream.handle(reqid, handle);
  } catch (e)
  {
    logger.error('SFTP', 'OPENDIR', `reqid=${reqid} error=${e}`);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_READDIR(self: SftpConnectionInstance, reqid: number, handle: Buffer)
{
  const key = getHandleKey(handle);
  const entry = self.handleMap[key] as SftpHandleEntry | undefined;

  // AeroFTP may send READDIR after CLOSE → respond EOF
  if (!entry || entry.closed)
  {
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
    return;
  }

  if (!entry.dirPendingReqs)
  {
    entry.dirPendingReqs = [];
  }

  entry.dirPendingReqs.push(reqid);

  if (!entry.dirBusy)
  {
    processReadDirQueue(entry, key, self).catch(err =>
    {
      logger.error('SFTP', 'READDIR', `Unhandled error in processReadDirQueue for handle=${key}:`, err);
    });
  }
}
async function SFTP_MKDIR(self: SftpConnectionInstance, reqid: number, dirPath: string, attrs: Attributes)
{
  try
  {
    const normalized = normalizePath(dirPath);
    logger.info('SFTP', 'MKDIR', `: ${normalized}`);

    await self.fsBackend.mkdir(normalized);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  } catch (e)
  {
    logger.error('SFTP', 'MKDIR', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_RMDIR(self: SftpConnectionInstance, reqid: number, dirPath: string)
{
  try
  {
    const normalized = normalizePath(dirPath);
    logger.info('SFTP', 'RMDIR', `: ${normalized}`);

    await self.fsBackend.remove(normalized);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  } catch (e)
  {
    logger.error('SFTP', 'RMDIR', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}

// #endregion

// #region SFTP Functions: INPUT/OUTPUT

async function SFTP_OPEN(self: SftpConnectionInstance, reqid: number, filename: string, flags: number, attrs: Attributes)
{
  try
  {
    const normalized = normalizePath(filename);

    const key = crypto.randomBytes(16).toString('hex');
    const handle = Buffer.from(key, 'ascii');

    const flagNames: string[] = [];
    if (flags & OPEN_MODE.READ) flagNames.push('READ');
    if (flags & OPEN_MODE.WRITE) flagNames.push('WRITE');
    if (flags & OPEN_MODE.APPEND) flagNames.push('APPEND');
    if (flags & OPEN_MODE.CREAT) flagNames.push('CREAT');
    if (flags & OPEN_MODE.TRUNC) flagNames.push('TRUNC');
    if (flags & OPEN_MODE.EXCL) flagNames.push('EXCL');
    logger.info('SFTP', 'OPEN', `for: '${normalized}' flags=[${flagNames.join('|')}] handle: ${key}`);

    const entry: SftpHandleEntry = {
      path: normalized,
      intendedName: basename(normalized),
      directoryEntryRead: null,
      readNode: undefined,
      writeNode: undefined,
      readInitPromise: null
    };

    const WRITE_FLAGS = OPEN_MODE.WRITE | OPEN_MODE.CREAT | OPEN_MODE.TRUNC | OPEN_MODE.APPEND;
    if (flags & WRITE_FLAGS)
    {
      if (self.phaseOnePending.has(normalized))
      {
        self.phaseOnePending.delete(normalized);
        logger.info('SFTP', 'OPEN', `Phase 2 write starting: ${normalized}`);
      }
      entry.writeNode = new VirtualContentBuffer(tmp.fileSync());
      entry.sha1 = crypto.createHash('sha1');
      entry.sha1Offset = 0;
    }
    else
    {
      // Prefetch: kick off the download immediately so it overlaps with the
      // client-server round trip before the first READ arrives.
      entry.readInitPromise = (async () =>
      {
        const backendResult = await self.fsBackend.readFile(entry.path);
        if (backendResult instanceof VirtualContentBuffer)
          entry.readNode = backendResult;
        else if (Buffer.isBuffer(backendResult))
          entry.readNode = new VirtualContentBuffer(undefined, backendResult);
        else
          entry.readNode = new VirtualContentBuffer(backendResult);
        entry.readSize = entry.readNode!.size;   // cache once; avoids per-READ statSync
      })();
      // Suppress unhandled-rejection warning in the window before the first READ
      void entry.readInitPromise.catch(() => { });
    }

    self.handleMap[key] = entry;
    self.sftpStream.handle(reqid, handle);
  }
  catch (e)
  {
    logger.error('SFTP', 'OPEN', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_READ(self: SftpConnectionInstance, reqid: number, handle: Buffer, offset: number, length: number)
{
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry || entry.closed)
    {
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
    }

    if (!entry.readInitPromise)
    {
      entry.readInitPromise = (async () =>
      {
        const backendResult = await self.fsBackend.readFile(entry.path);

        if (backendResult instanceof VirtualContentBuffer)
        {
          entry.readNode = backendResult;
        }
        else if (Buffer.isBuffer(backendResult))
        {
          entry.readNode = new VirtualContentBuffer(undefined, backendResult);
        }
        else
        {
          entry.readNode = new VirtualContentBuffer(backendResult);
        }
        entry.readSize = entry.readNode!.size;  // keep in sync with OPEN path so FSTAT is always accurate
      })();
    }

    await entry.readInitPromise;

    const node = entry.readNode!;
    // Prefer the size cached on OPEN to avoid a statSync on every READ request
    const fileSize = entry.readSize ?? node.size;
    if (offset >= fileSize)
    {
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
    }

    const chunk = node.read(offset, length);
    self.sftpStream.data(reqid, chunk);
  }
  catch (e)
  {
    logger.error('SFTP', 'READ', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_WRITE(self: SftpConnectionInstance, reqid: number, handle: Buffer, offset: number, data: Buffer)
{
  logger.debug('SFTP', 'WRITE', `handle=${handle.toString('hex').slice(0, 8)} offset=${offset} len=${data.length}`);

  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry || entry.closed)
    {
      logger.warn('SFTP', 'WRITE', `no entry or closed for handle=${handle.toString('hex').slice(0, 8)}`);
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }

    if (!entry.writeNode)
    {
      entry.writeNode = new VirtualContentBuffer(tmp.fileSync());
    }

    entry.writeNode.write(offset, data);

    // Update incremental SHA-1 while writes arrive sequentially.
    // If an out-of-order write is detected, disable and fall back to full re-hash at upload time.
    if (entry.sha1 !== undefined)
    {
      if (offset === entry.sha1Offset)
      {
        entry.sha1.update(data);
        entry.sha1Offset! += data.length;
      }
      else
      {
        entry.sha1 = undefined;   // out-of-order — incremental hash is no longer valid
      }
    }

    self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }
  catch (e)
  {
    logger.error('SFTP', 'WRITE', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_REMOVE(self: SftpConnectionInstance, reqid: number, filePath: string)
{
  try
  {
    const normalized = normalizePath(filePath);
    logger.info('SFTP', 'REMOVE', `requested: ${normalized}`);

    const result = await self.fsBackend.remove(normalized);
    if (result) self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
    else self.sftpStream.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
  } catch (e)
  {
    logger.error('SFTP', 'REMOVE', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_RENAME(self: SftpConnectionInstance, reqid: number, oldPath: string, newPath: string)
{
  try
  {
    const oldName = normalizePath(oldPath);
    const newName = normalizePath(newPath);
    logger.info('SFTP', 'RENAME', `requested: ${oldName} → ${newName}`);

    await self.fsBackend.rename(oldName, newName);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  } catch (e)
  {
    logger.error('SFTP', 'RENAME', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_CLOSE(self: SftpConnectionInstance, reqid: number, handle: Buffer)
{
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry)
    {
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
    }

    entry.closed = true;

    if (entry.readNode)
    {
      // Download already finished — clean up the buffer/tmp file immediately.
      entry.readNode.removeCallback();
    }
    else if (entry.readInitPromise)
    {
      // Download still in progress. Respond to the client now so it isn't
      // blocked (Dolphin thumbnail workers have a tight per-job timeout).
      // Clean up the node asynchronously once the download settles.
      entry.readInitPromise
        .then(() => { entry.readNode?.removeCallback(); })
        .catch(() => { /* download failed — nothing to clean up */ });
    }

    if (entry.writeNode)
    {
      const bytesWritten = entry.sha1Offset ?? 0;
      const fileSize = entry.writeNode.size;
      logger.info('SFTP', 'CLOSE', `write handle closed: ${entry.path} — sha1Offset=${bytesWritten} fileSize=${fileSize}`);

      if (fileSize === 0)
      {
        // Phase 1 of a two-phase upload: the client opens and immediately closes
        // with no data to probe that the path is writable, then checks STAT or
        // READDIR before sending Phase 2 data.  Register a placeholder so those
        // queries succeed; clean up the empty tmp file now.
        // Use fileSize (statSync) not sha1Offset: sha1Offset stays 0 when the
        // first write is at a non-zero offset (hash is invalidated), which would
        // incorrectly discard real data in Phase 3+ writes.
        self.phaseOnePending.set(entry.path, Date.now() + 30_000);
        logger.info('SFTP', 'CLOSE', `Phase 1 placeholder registered: ${entry.path}`);
        try { entry.writeNode.removeCallback(); } catch { }
      }
      else
      {
        // Attach the pre-computed checksum so the upload path can skip re-hashing
        if (entry.sha1)
        {
          entry.writeNode.checksum = entry.sha1.digest('base64');
        }
        // Fire the Immich upload asynchronously — blocking CLOSE on the HTTP
        // upload causes SFTP clients to ECONNRESET when the upload takes longer
        // than their operation timeout (common for large files).
        void self.fsBackend.writeFile(entry.path, entry.writeNode).catch(e =>
          logger.error('SFTP', 'CLOSE', 'upload error (async):', e)
        );
      }
    }

    self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);

    setTimeout(() =>
    {
      delete self.handleMap[key];
    }, 1000);
  }
  catch (e)
  {
    logger.error('SFTP', 'CLOSE', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}

// #endregion

// #region SFTP Functions: STAT
async function SFTP_STAT(self: SftpConnectionInstance, reqid: number, filePath: string, mode: string = 'STAT')
{
  try
  {
    const normalized = normalizePath(filePath);

    if (normalized === '/')
    {
      logger.info('SFTP', mode, `RESPOND attrs (root) reqid=${reqid}`);
      return self.sftpStream.attrs(reqid, createFolderAttributes());
    }

    const stat_response = await self.fsBackend.stat(normalized);
    if (!stat_response.success || !stat_response.contents)
    {
      const expiry = self.phaseOnePending.get(normalized);
      if (expiry && Date.now() < expiry)
      {
        logger.info('SFTP', mode, `RESPOND Phase 1 placeholder attrs: ${normalized} reqid=${reqid}`);
        return self.sftpStream.attrs(reqid, createFileAttributes(0));
      }
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    }
    const stat = stat_response.contents;

    self.sftpStream.attrs(reqid, {
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      mtime: stat.mtime,
      atime: stat.atime
    });
  } catch (e)
  {
    logger.error('SFTP', mode, `RESPOND failure reqid=${reqid} error: `, e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_LSTAT(self: SftpConnectionInstance, reqid: number, path: string)
{
  // No symlink support — LSTAT and STAT are equivalent.
  return SFTP_STAT(self, reqid, path, 'LSTAT');
}
async function SFTP_FSTAT(self: SftpConnectionInstance, reqid: number, handle: Buffer)
{
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry)
    {
      logger.info('SFTP', 'FSTAT', `RESPOND NO_SUCH_FILE reqid=${reqid}`);
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    }

    if (entry.writeNode)
    {
      logger.info('SFTP', 'FSTAT', `RESPOND attrs ${entry.path} reqid=${reqid}`);
      return self.sftpStream.attrs(reqid, createFileAttributes(entry.writeNode.size));
    }

    if (entry.readInitPromise)
    {
      // Download already finished — return the exact byte count that will be served.
      if (entry.readSize !== undefined)
      {

        logger.info('SFTP', 'FSTAT', `RESPOND attrs ${entry.path} reqid=${reqid}`);
        return self.sftpStream.attrs(reqid, createFileAttributes(entry.readSize));
      }

      // Download still in progress — try to respond immediately using metadata size
      // so the client is not blocked waiting for the full file download.
      // If the metadata size is unavailable (asset has no exifInfo AND the HTTP
      // fallback also fails), fall through to awaiting the actual download so we
      // always return an accurate byte count rather than zero.
      const stat = await self.fsBackend.stat(entry.path).catch(() => null);
      if (stat && stat.contents && stat.contents.size > 0)
      {
        logger.info('SFTP', 'FSTAT', `RESPOND still-downloading ${entry.path} reqid=${reqid}`);
        return self.sftpStream.attrs(reqid, createFileAttributes(stat.contents.size));
      }

      // Size unknown — wait for the download so the response is always accurate.
      await entry.readInitPromise;
      logger.info('SFTP', 'FSTAT', `RESPOND unknown-size ${entry.path} reqid=${reqid}`);
      return self.sftpStream.attrs(reqid, createFileAttributes(entry.readSize ?? entry.readNode?.size ?? 0));
    }

    // No handle-specific state — delegate to path-based STAT.
    return SFTP_STAT(self, reqid, entry.path, 'FSTAT');
  }
  catch (e)
  {
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
// #endregion

// #region SFTP Functions: SETSTAT

async function SFTP_SETSTAT(self: SftpConnectionInstance, reqid: number, filePath: string, attrs: Attributes, mode: string = 'SETSTAT')
{
  try
  {
    const normalized = normalizePath(filePath);
    logger.info('SFTP', `${mode}`, `RESPOND reqid=${reqid} path=${normalized}`, attrs);

    await self.fsBackend.setAttributes(normalized, attrs.mtime);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  } catch (e)
  {
    logger.error('SFTP', mode, 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_FSETSTAT(self: SftpConnectionInstance, reqid: number, handle: Buffer, attrs: Attributes)
{
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry)
    {
      logger.info('SFTP', 'FSETSTAT', `RESPOND NO_SUCH_FILE reqid=${reqid}`);
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    }

    // If writing, apply to the in‑progress node when possible
    if (entry.writeNode)
    {
      logger.info('SFTP', 'FSETSTAT', `RESPOND reqid=${reqid} path=${entry.path}`, attrs);
      if (attrs.mtime && entry.writeNode.isTmp)
      {
        // Only tmp-backed nodes have a real path we can utime
        fs.utimesSync(entry.writeNode.name, attrs.mtime, attrs.mtime);
      }
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
    }

    // Otherwise delegate to SETSTAT using the handle's resolved path.
    return SFTP_SETSTAT(self, reqid, entry.path, attrs, 'FSETSTAT');
  }
  catch (e)
  {
    logger.error('SFTP', 'FSETSTAT', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
// #endregion

// #region SFTP Functions: MISC

async function SFTP_EXTENDED(self: SftpConnectionInstance, reqid: number, extName: string, extData: Buffer)
{
  logger.info('SFTP', 'EXTENDED', `: ${extName}`);
  logger.error('SFTP', 'EXTENDED', `Unsupported EXTENDED: ${extName}`);
  (self.sftpStream as any).status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE ?? SFTP_STATUS_CODE.FAILURE);
}
async function SFTP_READLINK(self: SftpConnectionInstance, reqid: number, path: string)
{
  logger.info('SFTP', 'READLINK', `requested: ${path}`);
  // No symlink support → return NO_SUCH_FILE
  self.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
}
async function SFTP_SYMLINK(self: SftpConnectionInstance, reqid: number, targetPath: string, linkPath: string)
{
  logger.info('SFTP', 'SYMLINK', `requested: ${linkPath} → ${targetPath}`);
  // No symlink support → return OP_UNSUPPORTED
  self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
}
async function SFTP_READY(self: SftpConnectionInstance)
{

}

// #endregion

// #region Creation Functions

function createServerConfig(): ServerConfig
{
  const hostKey = createEphemeralHostKeySync()
  return {
    hostKeys: [hostKey]
  }
}
function createConnectionConfig(): SftpConnectionConfig
{
  return {
    batchSize: config.maxReadBatchSize
  }
}
function createEphemeralHostKeySync(): Buffer
{
  const abs = path.resolve('./../../data/host_rsa.key');

  // If the key already exists, load and return it
  if (fs.existsSync(abs))
  {
    return fs.readFileSync(abs);
  }

  // Otherwise generate a new RSA keypair
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });

  const pem = privateKey.export({
    format: "pem",
    type: "pkcs1",
  }) as Buffer;

  // Ensure directory exists
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  // Persist the key for future runs
  fs.writeFileSync(abs, pem, { mode: 0o600 });

  return pem;
}

// #endregion

// #region Functions

async function processReadDirQueue(entry: SftpHandleEntry, key: string, self: SftpConnectionInstance)
{
  // If another loop is already running, just let it handle the new reqids
  if (entry.dirBusy) return;
  entry.dirBusy = true;

  try
  {
    // One‑time directory load
    if (!entry.files)
    {
      logger.info('SFTP', 'READDIR', `init listing for handle=${key} path='${entry.path}'`);
      const dotEntries: VirtualMetadata[] = [VirtualMetadata.directory_ro('.'), VirtualMetadata.directory_ro('..')];
      const realFiles = await self.fsBackend.listFiles(entry.path);

      // Inject any Phase 1 placeholders that belong to this directory so the
      // client sees the file it just created before sending Phase 2 data.
      const now = Date.now();
      const pendingInDir: VirtualMetadata[] = [];
      for (const [pendingPath, expiry] of self.phaseOnePending)
      {
        if (expiry <= now) { self.phaseOnePending.delete(pendingPath); continue; }
        if (path.posix.dirname(pendingPath) === entry.path)
          pendingInDir.push(VirtualMetadata.file_rw(path.posix.basename(pendingPath), 0, now / 1000));
      }

      entry.files = [...dotEntries, ...realFiles, ...pendingInDir]
      entry.dirIndex = 0;
    }

    if (entry.dirIndex == null) entry.dirIndex = 0;
    if (!entry.dirPendingReqs) entry.dirPendingReqs = [];

    while (entry.dirPendingReqs.length > 0)
    {
      const reqid = entry.dirPendingReqs.shift()!;

      // Handle closed handles gracefully
      if (entry.closed)
      {
        self.sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
        continue;
      }

      if (entry.dirIndex >= entry.files.length)
      {
        self.sftpStream.status(reqid, SFTP_STATUS_CODE.EOF);
        continue;
      }

      const end = Math.min(entry.dirIndex + self.netConfig.batchSize, entry.files.length);
      const batch = entry.files.slice(entry.dirIndex, end);
      const items = batch.map(x => x.convertTo('sftp'))
      entry.dirIndex = end;

      logger.debug('SFTP', 'READDIR', `batch for handle=${key}: ${batch.length} entries`);

      self.sftpStream.name(reqid, items);

      // If there are still pending requests, yield so other I/O can run
      if (entry.dirPendingReqs.length > 0)
      {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  }
  catch (err)
  {
    logger.error('SFTP', 'SERVER', `READDIR error for handle path='${entry.path}':`, err);
    if (entry.dirPendingReqs)
    {
      for (const reqid of entry.dirPendingReqs)
      {
        try { self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE); } catch { /* ignore */ }
      }
      entry.dirPendingReqs = [];
    }
  }
  finally
  {
    entry.dirBusy = false;
  }
}
function getHandleKey(handle: Buffer | string): string // Handles are ASCII hex strings, sent as ASCII buffers
{
  if (Buffer.isBuffer(handle))
  {
    return handle.toString('ascii');
  }
  return handle as string;
}
function normalizePath(p: string): string
{
  const normalized = path.posix.normalize(p);

  // Treat "." and "" as root
  if (normalized === '.' || normalized === '')
  {
    return '/';
  }

  const absPath = normalized.replace(/^\/+|\/+$/g, '');
  return '/' + absPath;
}
function createFileAttributes(size: number): Attributes
{
  const now = DateUtils.getTimestampNow();
  return {
    mode: 0o100644,
    uid: 0,
    gid: 0,
    size: size,
    atime: now,
    mtime: now
  }
}
function createFolderAttributes(): Attributes
{
  const now = DateUtils.getTimestampNow();
  return {
    mode: 0o040755,
    uid: 0,
    gid: 0,
    size: 0,
    mtime: now,
    atime: now
  }
}

// #endregion

// #region Interfaces

export interface SftpConnection extends Connection
{
  fsBackend?: VirtualFileSystem;
  cfg?: SftpConnectionConfig
}

export interface SftpConnectionInstance
{
  fsBackend: VirtualFileSystem;
  sftpStream: SFTPWrapper;
  handleMap: Record<string, SftpHandleEntry>;
  netConfig: SftpConnectionConfig;
  phaseOnePending: Map<string, number>; // path → expiry ms; Phase 1 placeholders
}

export interface SftpConnectionConfig
{
  batchSize: number
}

export interface SftpHandleEntry
{
  path: string;
  intendedName: string;
  directoryEntryRead: boolean | null;

  files?: VirtualMetadata[];
  dirIndex?: number;
  dirPendingReqs?: number[];
  dirBusy?: boolean;
  closed?: boolean;

  readNode?: VirtualContentBuffer;
  writeNode?: VirtualContentBuffer;
  readInitPromise?: Promise<void> | null;
  readSize?: number;        // file size cached after download; avoids per-READ statSync
  sha1?: crypto.Hash;      // running hash for incremental checksum during sequential writes
  sha1Offset?: number;     // next expected write offset; undefined → out-of-order detected
}

// #endregion

// #region Classes

export class SftpProtocolServer implements TransferProtocolServer
{
  readonly name = 'sftp';

  async start(): Promise<void>
  {
    await new Promise<void>((resolve, reject) =>
    {
      server.listen(config.portSFTP, config.serverHost, function ()
      {
        logger.info('SFTP', 'SERVER', `SFTP server listening on ${config.serverHost}:${config.portSFTP}`);
        resolve();
      });
      server.on('error', reject);
    });
  }
}

export class ImmichSftpServer extends Server
{
  constructor(cfg: ServerConfig, listener?: ServerConnectionListener)
  {
    super(cfg, listener)
  }
}

// #endregion

// #region Constants

export const SFTP_STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4
};

export const OPEN_MODE = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREAT: 0x00000008,
  TRUNC: 0x00000010,
  EXCL: 0x00000020
};

// #endregion



const server = new ImmichSftpServer(createServerConfig(), (con: SftpConnection) =>
{
  logger.info('SFTP', 'SERVER', 'Client connected');
  con.on('error', async (err) => { await TCP_Error(con, err) });

  // Initialize the connection backend
  if (con.fsBackend == null) con.fsBackend = new ImmichFileSystem();
  if (con.cfg == null) con.cfg = createConnectionConfig();


  con.on('authentication', async (ctx) => { await TCP_Authentication(con, ctx) });
  con.on('end', async () => { await TCP_End(con) });
  con.on('greeting', (greeting: string) => { TCP_Greeting(con, greeting) });
  con.on('session', (accept, reject) => { TCP_Session(con, accept, reject); });
  con.on('error', (err) => { TCP_Error(con, err) });
});