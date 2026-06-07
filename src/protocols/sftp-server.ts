import crypto from 'crypto';
import fs from 'fs';
import path, { basename } from 'path';
import { AcceptConnection, Attributes, AuthContext, Connection, RejectConnection, Server, ServerConfig, ServerConnectionListener, Session, SFTPWrapper } from 'ssh2';
import tmp from 'tmp';
import { config } from '../config';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { VirtualFileSystem } from '../filesystem/virtual-file-system';
import { VirtualMetadata } from '../filesystem/virtual-metadata';
import { ImmichFileSystem } from '../immich/immich-file-system';
import { logger } from '../logger';
import { DateUtils } from '../utils/date-utils';
import { TransferProtocolServer } from './transfer-protocol-server';

// #region TCP Receivers

async function TCP_Authentication(con: SftpConnection, ctx: AuthContext)
{
  logger.info('SFTP', 'Authentication', `Authenticating connection (method: ${ctx.method})`);

  if (ctx.method === 'password')
  {
    if (!con.session_data) throw new Error("Backend not Initalized");

    //Login
    try
    {
      await con.session_data.fsBackend.login(ctx.username, ctx.password);
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
  if (con.session_data)
  {
    await con.session_data.fsBackend.logout();
    await SFTP_CLEANUP(con.session_data)
  }

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
  if (!con.session_data)
  {
    logger.warn('SFTP', 'SESSION', 'Session requested without initalization — rejecting.');
    reject();
    return;
  }

  // Reject the session if the user has not completed login on this connection.
  if (!con.session_data.fsBackend.isAuthenticated())
  {
    logger.warn('SFTP', 'SESSION', 'Session requested without authenticated user — rejecting.');
    reject();
    return;
  }

  const session = accept();
  logger.info('SFTP', 'SOCKET', 'Session started');
  session.on('sftp', (accept, reject) =>
  {


    if (!con.session_data)
    {
      logger.warn('SFTP', 'SOCKET', 'SFTP subsystem requested without initalization — rejecting.');
      reject();
      return;
    }

    const fsBackend = con.session_data.fsBackend;
    const netConfig = con.session_data.cfg;
    const session_data = con.session_data

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

    sftpStream.on('ready', async () => { await SFTP_READY(session_data) });
    sftpStream.on('OPEN', async (reqid: number, filename: string, flags: number, attrs: Attributes) => { await SFTP_OPEN(session_data, sftpStream, reqid, filename, flags, attrs) });
    sftpStream.on('READ', async (reqid: number, handle: Buffer, offset: number, len: number) => { await SFTP_READ(session_data, sftpStream, reqid, handle, offset, len) });
    sftpStream.on('WRITE', async (reqid: number, handle: Buffer, offset: number, data: Buffer) => { await SFTP_WRITE(session_data, sftpStream, reqid, handle, offset, data) });
    sftpStream.on('FSTAT', async (reqid: number, handle: Buffer) => { await SFTP_FSTAT(session_data, sftpStream, reqid, handle) });
    sftpStream.on('FSETSTAT', async (reqid: number, handle: Buffer, attrs: Attributes) => { await SFTP_FSETSTAT(session_data, sftpStream, reqid, handle, attrs) });
    sftpStream.on('CLOSE', async (reqid: number, handle: Buffer) => { await SFTP_CLOSE(session_data, sftpStream, reqid, handle) });
    sftpStream.on('OPENDIR', async (reqid: number, rawPath) => { await SFTP_OPENDIR(session_data, sftpStream, reqid, rawPath) });
    sftpStream.on('READDIR', async (reqid: number, handle) => { await SFTP_READDIR(session_data, sftpStream, reqid, handle) });
    sftpStream.on("LSTAT", async (reqid: number, path: string) => { await SFTP_LSTAT(session_data, sftpStream, reqid, path) });
    sftpStream.on('STAT', async (reqid: number, filePath) => { await SFTP_STAT(session_data, sftpStream, reqid, filePath) });
    sftpStream.on('REMOVE', async (reqid: number, filePath) => { await SFTP_REMOVE(session_data, sftpStream, reqid, filePath) });
    sftpStream.on('RMDIR', async (reqid, dirPath) => { await SFTP_RMDIR(session_data, sftpStream, reqid, dirPath) });
    sftpStream.on('REALPATH', async (reqid: number, givenPath) => { await SFTP_REALPATH(session_data, sftpStream, reqid, givenPath) });
    sftpStream.on('READLINK', async (reqid: number, path: string) => { await SFTP_READLINK(session_data, sftpStream, reqid, path) });
    sftpStream.on('SETSTAT', async (reqid: number, filePath, attrs: Attributes) => { await SFTP_SETSTAT(session_data, sftpStream, reqid, filePath, attrs) });
    sftpStream.on('MKDIR', async (reqid: number, dirPath, attrs) => { await SFTP_MKDIR(session_data, sftpStream, reqid, dirPath, attrs) });
    sftpStream.on('RENAME', async (reqid: number, oldPath, newPath) => { await SFTP_RENAME(session_data, sftpStream, reqid, oldPath, newPath) });
    sftpStream.on('SYMLINK', async (reqid: number, targetPath: string, linkPath: string) => { await SFTP_SYMLINK(session_data, sftpStream, reqid, targetPath, linkPath) });
    sftpStream.on('EXTENDED', async (reqid: number, extName: string, extData: Buffer) => { await SFTP_EXTENDED(session_data, sftpStream, reqid, extName, extData) });
  });
}

// #endregion

// #region SFTP Functions: DIR

async function SFTP_REALPATH(self: SftpSession, stream: SFTPWrapper, reqid: number, givenPath: string)
{
  try
  {
    const normalized = normalizePath(givenPath);
    logger.info('SFTP', 'REALPATH', `reqid=${reqid} path=${givenPath} → ${normalized}`);
    stream.name(reqid, [
      {
        filename: normalized,
        longname: `drwxr-xr-x 1 user group 0 0 Jan 1 00:00 ${normalized}`,
        attrs: createFolderAttributes()
      }
    ]);
  } catch (e)
  {
    logger.error('SFTP', 'REALPATH', `reqid=${reqid} error=${e}`);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_OPENDIR(self: SftpSession, stream: SFTPWrapper, reqid: number, rawPath: string)
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
    stream.handle(reqid, handle);
  } catch (e)
  {
    logger.error('SFTP', 'OPENDIR', `reqid=${reqid} error=${e}`);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_READDIR(self: SftpSession, stream: SFTPWrapper, reqid: number, handle: Buffer)
{
  const key = getHandleKey(handle);
  const entry = self.handleMap[key] as SftpHandleEntry | undefined;

  // AeroFTP may send READDIR after CLOSE → respond EOF
  if (!entry || entry.closed)
  {
    stream.status(reqid, SFTP_STATUS_CODE.EOF);
    return;
  }

  if (!entry.dirPendingReqs)
  {
    entry.dirPendingReqs = [];
  }

  entry.dirPendingReqs.push(reqid);

  if (!entry.dirBusy)
  {
    processReadDirQueue(entry, key, self, stream).catch(err =>
    {
      logger.error('SFTP', 'READDIR', `Unhandled error in processReadDirQueue for handle=${key}:`, err);
    });
  }
}
async function SFTP_MKDIR(self: SftpSession, stream: SFTPWrapper, reqid: number, dirPath: string, attrs: Attributes)
{
  try
  {
    const normalized = normalizePath(dirPath);
    logger.info('SFTP', 'MKDIR', `: ${normalized}`);

    await self.fsBackend.mkdir(normalized);
    stream.status(reqid, SFTP_STATUS_CODE.OK);
  } catch (e)
  {
    logger.error('SFTP', 'MKDIR', 'error:', e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_RMDIR(self: SftpSession, stream: SFTPWrapper, reqid: number, dirPath: string)
{
  try
  {
    const normalized = normalizePath(dirPath);
    logger.info('SFTP', 'RMDIR', `: ${normalized}`);

    await self.fsBackend.remove(normalized);
    stream.status(reqid, SFTP_STATUS_CODE.OK);
  } catch (e)
  {
    logger.error('SFTP', 'RMDIR', 'error:', e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}

// #endregion

// #region SFTP Functions: INPUT/OUTPUT

async function SFTP_OPEN(self: SftpSession, stream: SFTPWrapper, reqid: number, filename: string, flags: number, attrs: Attributes)
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
      // Deduplicate: if another handle already started (or finished) downloading this
      // path, reuse that result instead of issuing a second Immich request.
      // Dolphin opens the same file 40+ times simultaneously for thumbnail workers;
      // without this, each OPEN would trigger an independent full download.
      let sharedPromise = self.sharedReads.get(normalized);
      if (!sharedPromise)
      {
        logger.debug('SFTP', 'OPEN', `sharedReads MISS for '${normalized}' — starting fetch`);
        sharedPromise = (async () =>
        {
          try
          {
            const backendResult = await self.fsBackend.readFile(normalized);
            let vcb: VirtualContentBuffer;
            if (backendResult instanceof VirtualContentBuffer) vcb = backendResult;
            else if (Buffer.isBuffer(backendResult)) vcb = new VirtualContentBuffer(undefined, backendResult);
            else vcb = new VirtualContentBuffer(backendResult);
            const backing = vcb.isTmp ? 'tmp' : vcb.isBuffer ? 'buffer' : 'filepath';
            logger.debug('SFTP', 'OPEN', `sharedReads resolved '${normalized}' backing=${backing} size=${vcb.size}`);
            return vcb;
          }
          catch (e)
          {
            logger.warn('SFTP', 'OPEN', `sharedReads fetch FAILED for '${normalized}':`, e);
            self.sharedReads.delete(normalized);
            return null;
          }
        })();
        self.sharedReads.set(normalized, sharedPromise);
      }
      else
      {
        logger.debug('SFTP', 'OPEN', `sharedReads HIT for '${normalized}' — reusing in-flight/cached fetch`);
      }

      entry.readInitPromise = (async () =>
      {
        const node = await sharedPromise;
        if (!node) throw new Error(`Download failed: ${normalized}`);
        entry.readNode = node;
        entry.readSize = node.size;
      })();
      void entry.readInitPromise.catch(() => { });
    }

    self.handleMap[key] = entry;
    stream.handle(reqid, handle);
  }
  catch (e)
  {
    logger.error('SFTP', 'OPEN', 'error:', e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_READ(self: SftpSession, stream: SFTPWrapper, reqid: number, handle: Buffer, offset: number, length: number)
{
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry || entry.closed)
    {
      logger.debug('SFTP', 'READ', `reqid=${reqid} handle=${key.slice(0, 8)} — EOF (no entry or closed)`);
      return stream.status(reqid, SFTP_STATUS_CODE.EOF);
    }

    if (!entry.readInitPromise)
    {
      logger.debug('SFTP', 'READ', `reqid=${reqid} path='${entry.path}' — no readInitPromise, falling back to direct readFile`);
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
        entry.readSize = entry.readNode!.size;
      })();
    }

    await entry.readInitPromise;

    // Re-check closed: a SFTP_CLOSE can arrive while we were awaiting the download.
    // Sending data on a closed handle confuses clients and can corrupt their read state.
    if (entry.closed)
    {
      logger.debug('SFTP', 'READ', `reqid=${reqid} path='${entry.path}' — handle closed during download, returning EOF`);
      return stream.status(reqid, SFTP_STATUS_CODE.EOF);
    }

    const node = entry.readNode!;
    if (!node)
    {
      logger.error('SFTP', 'READ', `reqid=${reqid} path='${entry.path}' — readInitPromise resolved but readNode is null`);
      return stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
    }

    // Prefer the size cached on OPEN to avoid a statSync on every READ request
    const fileSize = entry.readSize ?? node.size;
    if (offset >= fileSize)
    {
      logger.debug('SFTP', 'READ', `reqid=${reqid} path='${entry.path}' — EOF at offset=${offset} fileSize=${fileSize}`);
      return stream.status(reqid, SFTP_STATUS_CODE.EOF);
    }

    const backing = node.isTmp ? 'tmp' : node.isBuffer ? 'buffer' : 'filepath';
    logger.debug('SFTP', 'READ', `reqid=${reqid} path='${entry.path}' offset=${offset} len=${length} backing=${backing} fileSize=${fileSize}`);

    const chunk = node.read(offset, length);
    stream.data(reqid, chunk);
  }
  catch (e)
  {
    logger.error('SFTP', 'READ', `reqid=${reqid} error:`, e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_WRITE(self: SftpSession, stream: SFTPWrapper, reqid: number, handle: Buffer, offset: number, data: Buffer)
{
  logger.debug('SFTP', 'WRITE', `handle=${handle.toString('hex').slice(0, 8)} offset=${offset} len=${data.length}`);

  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry || entry.closed)
    {
      logger.warn('SFTP', 'WRITE', `no entry or closed for handle=${handle.toString('hex').slice(0, 8)}`);
      return stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
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

    stream.status(reqid, SFTP_STATUS_CODE.OK);
  }
  catch (e)
  {
    logger.error('SFTP', 'WRITE', 'error:', e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_REMOVE(self: SftpSession, stream: SFTPWrapper, reqid: number, filePath: string)
{
  try
  {
    const normalized = normalizePath(filePath);
    logger.info('SFTP', 'REMOVE', `requested: ${normalized}`);

    const result = await self.fsBackend.remove(normalized);
    if (result) stream.status(reqid, SFTP_STATUS_CODE.OK);
    else stream.status(reqid, SFTP_STATUS_CODE.PERMISSION_DENIED);
  } catch (e)
  {
    logger.error('SFTP', 'REMOVE', 'error:', e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_RENAME(self: SftpSession, stream: SFTPWrapper, reqid: number, oldPath: string, newPath: string)
{
  try
  {
    const oldName = normalizePath(oldPath);
    const newName = normalizePath(newPath);
    logger.info('SFTP', 'RENAME', `requested: ${oldName} → ${newName}`);

    await self.fsBackend.rename(oldName, newName);
    stream.status(reqid, SFTP_STATUS_CODE.OK);
  } catch (e)
  {
    logger.error('SFTP', 'RENAME', 'error:', e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_CLOSE(self: SftpSession, stream: SFTPWrapper, reqid: number, handle: Buffer)
{
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry)
    {
      return stream.status(reqid, SFTP_STATUS_CODE.OK);
    }

    entry.closed = true;

    // Read nodes are owned by sharedReads and cleaned up on session close.
    // Suppress any in-flight rejection to avoid unhandled-rejection warnings.
    if (entry.readInitPromise && !entry.readNode)
      entry.readInitPromise.catch(() => { });

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

    stream.status(reqid, SFTP_STATUS_CODE.OK);

    setTimeout(() =>
    {
      delete self.handleMap[key];
    }, 1000);
  }
  catch (e)
  {
    logger.error('SFTP', 'CLOSE', 'error:', e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}

// #endregion

// #region SFTP Functions: STAT
async function SFTP_STAT(self: SftpSession, stream: SFTPWrapper, reqid: number, filePath: string, mode: string = 'STAT')
{
  try
  {
    const normalized = normalizePath(filePath);

    if (normalized === '/')
    {
      logger.info('SFTP', mode, `RESPOND attrs (root) reqid=${reqid}`);
      return stream.attrs(reqid, createFolderAttributes());
    }

    const stat_response = await self.fsBackend.stat(normalized);
    if (!stat_response.success || !stat_response.contents)
    {
      const expiry = self.phaseOnePending.get(normalized);
      if (expiry && Date.now() < expiry)
      {
        logger.info('SFTP', mode, `RESPOND Phase 1 placeholder attrs: ${normalized} reqid=${reqid}`);
        return stream.attrs(reqid, createFileAttributes(0));
      }
      return stream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    }
    const stat = stat_response.contents;

    const typeLabel = stat.isDir ? 'dir' : 'file';
    logger.debug('SFTP', mode, `RESPOND attrs reqid=${reqid} path='${normalized}' type=${typeLabel} size=${stat.size} mode=${stat.mode.toString(8)}`);

    stream.attrs(reqid, {
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
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_LSTAT(self: SftpSession, stream: SFTPWrapper, reqid: number, path: string)
{
  // No symlink support — LSTAT and STAT are equivalent.
  return SFTP_STAT(self, stream, reqid, path, 'LSTAT');
}
async function SFTP_FSTAT(self: SftpSession, stream: SFTPWrapper, reqid: number, handle: Buffer)
{
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry)
    {
      logger.info('SFTP', 'FSTAT', `RESPOND NO_SUCH_FILE reqid=${reqid}`);
      return stream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    }

    if (entry.writeNode)
    {
      logger.info('SFTP', 'FSTAT', `RESPOND attrs ${entry.path} reqid=${reqid}`);
      return stream.attrs(reqid, createFileAttributes(entry.writeNode.size));
    }

    if (entry.readInitPromise)
    {
      // Download already finished — return the exact byte count that will be served.
      if (entry.readSize !== undefined)
      {

        logger.info('SFTP', 'FSTAT', `RESPOND attrs ${entry.path} reqid=${reqid}`);
        return stream.attrs(reqid, createFileAttributes(entry.readSize));
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
        return stream.attrs(reqid, createFileAttributes(stat.contents.size));
      }

      // Size unknown — wait for the download so the response is always accurate.
      await entry.readInitPromise;
      logger.info('SFTP', 'FSTAT', `RESPOND unknown-size ${entry.path} reqid=${reqid}`);
      return stream.attrs(reqid, createFileAttributes(entry.readSize ?? entry.readNode?.size ?? 0));
    }

    // No handle-specific state — delegate to path-based STAT.
    return SFTP_STAT(self, stream, reqid, entry.path, 'FSTAT');
  }
  catch (e)
  {
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
// #endregion

// #region SFTP Functions: SETSTAT

async function SFTP_SETSTAT(self: SftpSession, stream: SFTPWrapper, reqid: number, filePath: string, attrs: Attributes, mode: string = 'SETSTAT')
{
  try
  {
    const normalized = normalizePath(filePath);
    logger.info('SFTP', `${mode}`, `RESPOND reqid=${reqid} path=${normalized}`, attrs);

    await self.fsBackend.setAttributes(normalized, attrs.mtime);
    stream.status(reqid, SFTP_STATUS_CODE.OK);
  } catch (e)
  {
    logger.error('SFTP', mode, 'error:', e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_FSETSTAT(self: SftpSession, stream: SFTPWrapper, reqid: number, handle: Buffer, attrs: Attributes)
{
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry)
    {
      logger.info('SFTP', 'FSETSTAT', `RESPOND NO_SUCH_FILE reqid=${reqid}`);
      return stream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
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
      return stream.status(reqid, SFTP_STATUS_CODE.OK);
    }

    // Otherwise delegate to SETSTAT using the handle's resolved path.
    return SFTP_SETSTAT(self, stream, reqid, entry.path, attrs, 'FSETSTAT');
  }
  catch (e)
  {
    logger.error('SFTP', 'FSETSTAT', 'error:', e);
    stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
// #endregion

// #region SFTP Functions: MISC

async function SFTP_EXTENDED(self: SftpSession, stream: SFTPWrapper, reqid: number, extName: string, extData: Buffer)
{
  logger.info('SFTP', 'EXTENDED', `: ${extName}`);
  logger.error('SFTP', 'EXTENDED', `Unsupported EXTENDED: ${extName}`);
  (stream as any).status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE ?? SFTP_STATUS_CODE.FAILURE);
}
async function SFTP_READLINK(self: SftpSession, stream: SFTPWrapper, reqid: number, path: string)
{
  logger.info('SFTP', 'READLINK', `requested: ${path}`);
  // No symlink support → return NO_SUCH_FILE
  stream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
}
async function SFTP_SYMLINK(self: SftpSession, stream: SFTPWrapper, reqid: number, targetPath: string, linkPath: string)
{
  logger.info('SFTP', 'SYMLINK', `requested: ${linkPath} → ${targetPath}`);
  // No symlink support → return OP_UNSUPPORTED
  stream.status(reqid, SFTP_STATUS_CODE.FAILURE);
}
async function SFTP_READY(self: SftpSession)
{

}
async function SFTP_CLEANUP(self: SftpSession)
{
  if (!self.handleMap) return
  if (!self.sharedReads) return
  if (!self.phaseOnePending) return

  for (const key of Object.keys(self.handleMap))
  {
    const entry = self.handleMap[key];
    if (!entry.closed && entry.writeNode)
    {
      logger.warn('SFTP', 'CLEANUP', `Connection dropped with open write handle: ${entry.path}`);
      try { entry.writeNode.removeCallback(); } catch { }
    }
  }
  // Snapshot sharedReads before clearing — the async .then() callbacks
  // must hold their own references so removeCallback() fires correctly
  // even after the map is cleared.
  const pendingCleanup = Array.from(self.sharedReads.values());
  self.sharedReads.clear();
  self.phaseOnePending.clear();

  for (const nodePromise of pendingCleanup)
  {
    nodePromise
      .then(node =>
      {
        if (!node) return;
        logger.debug('SFTP', 'CLEANUP', `session-close removeCallback backing=${node.isTmp ? 'tmp' : node.isBuffer ? 'buffer' : 'filepath'}`);
        try { node.removeCallback(); } catch { }
      })
      .catch(() => { });
  }
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
function createConnectionConfig(): SftpSessionConfig
{
  return {
    batchSize: config.OPTION_MAX_READ_BATCH_SIZE
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

async function processReadDirQueue(entry: SftpHandleEntry, key: string, self: SftpSession, stream: SFTPWrapper)
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
        stream.status(reqid, SFTP_STATUS_CODE.EOF);
        continue;
      }

      if (entry.dirIndex >= entry.files.length)
      {
        stream.status(reqid, SFTP_STATUS_CODE.EOF);
        continue;
      }

      const end = Math.min(entry.dirIndex + self.cfg.batchSize, entry.files.length);
      const batch = entry.files.slice(entry.dirIndex, end);
      const items = batch.map(x => x.convertTo('sftp'))
      entry.dirIndex = end;

      const fileSizeSummary = batch.filter(f => !f.isDir).map(f => `${f.name}:${f.size}`).join(', ');
      if (fileSizeSummary) logger.debug('SFTP', 'READDIR', `file sizes in batch (path='${entry.path}'): ${fileSizeSummary}`);
      logger.debug('SFTP', 'READDIR', `batch for handle=${key}: ${batch.length} entries (${batch.filter(f => !f.isDir).length} files, ${batch.filter(f => f.isDir).length} dirs)`);

      stream.name(reqid, items);

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
        try { stream.status(reqid, SFTP_STATUS_CODE.FAILURE); } catch { /* ignore */ }
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
  session_data?: SftpSession
}

export interface SftpSession
{
  fsBackend: VirtualFileSystem;
  cfg: SftpSessionConfig
  handleMap: Record<string, SftpHandleEntry>;
  phaseOnePending: Map<string, number>; // path → expiry ms; Phase 1 placeholders
  sharedReads: Map<string, Promise<VirtualContentBuffer | null>>; // path → deduplicated download
}

export interface SftpSessionConfig
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
      server.listen(config.PROTOCOL_PORTS_SFTP, config.PROTOCOL_HOST, function ()
      {
        logger.info('SFTP', 'SERVER', `SFTP server listening on ${config.PROTOCOL_HOST}:${config.PROTOCOL_PORTS_SFTP}`);
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
  // Initialize the connection backend




  if (con.session_data == null)
  {
    con.session_data = {
      fsBackend: new ImmichFileSystem(),
      cfg: createConnectionConfig(),
      handleMap: {},
      phaseOnePending: new Map<string, number>(), // path → expiry ms
      sharedReads: new Map<string, Promise<VirtualContentBuffer | null>>() // path → shared download
    }
  }


  con.on('authentication', async (ctx) => { await TCP_Authentication(con, ctx) });
  con.on('end', async () => { await TCP_End(con) });
  con.on('greeting', (greeting: string) => { TCP_Greeting(con, greeting) });
  con.on('session', (accept, reject) => { TCP_Session(con, accept, reject); });
  con.on('error', (err) => { TCP_Error(con, err) });
});