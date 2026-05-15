import fs from 'fs';
import { Attributes, AuthContext, Connection, Server, ServerConfig, ServerConnectionListener, SFTPWrapper } from 'ssh2';
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
import { ImmichAPI } from '../immich/immich-api';
import { ImmichSessionCache } from '../immich/immich-session-cache';

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

function TCP_Ready(con: SftpConnection)
{

  logger.info('SFTP', 'SOCKET', 'Client is ready');
  con.on('session', (accept, reject) =>
  {
    const session = accept();
    logger.info('SFTP', 'SOCKET', 'Session started');




    //session.on('signal', (accept, reject, info) => Session_Signal(con, accept, reject, info));
    //session.on('exec', (accept, reject, info) => Session_Exec(con, accept, reject, info));
    session.on('sftp', (accept, reject) =>
    {
      //Accept SFTP session
      const sftpStream = accept();
      logger.info('SFTP', 'SOCKET', 'SFTP session started');

      //Find backend or close connection
      const fsBackend = con.fsBackend;
      if (!fsBackend)
      {
        logger.error('SFTP', 'SOCKET', 'File system backend is not initialized. Closing connection.');
        return con.end();
      }

      //Handle map
      const handleMap: Record<string, SftpHandleEntry> = {};

      // Connection config
      const netConfig = con.cfg
      if (!netConfig)
      {
        logger.error('SFTP', 'SOCKET', 'Connection Config is not initialized. Closing connection.');
        return con.end();
      }

      const service: SftpConnectionInstance = {
        fsBackend,
        handleMap,
        sftpStream,
        netConfig
      }

      sftpStream.on('ready', async () => { await SFTP_Ready(service) });
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
    });
  });

  con.on('error', (err) =>
  {
    logger.error('SFTP', 'SOCKET', `Socket error: ${err.message}`);
    con.end();
  });
}

// #endregion

// #region SFTP Functions

async function SFTP_Ready(self: SftpConnectionInstance)
{

}
async function SFTP_REALPATH(self: SftpConnectionInstance, reqid: number, givenPath: string)
{
  try
  {
    const normalized = normalizePath(givenPath);
    logger.info('SFTP', 'REALPATH', `reqid=${reqid} path=${givenPath} → ${normalized}`);

    const now = Math.floor(Date.now() / 1000);

    logger.info('SFTP', 'REALPATH', `RESPOND name reqid=${reqid}`);
    self.sftpStream.name(reqid, [
      {
        filename: normalized,
        longname: `drwxr-xr-x 1 user group 0 0 Jan 1 00:00 ${normalized}`,
        attrs: {
          mode: 0o040755,
          uid: 0,
          gid: 0,
          size: 0,
          atime: now,
          mtime: now
        }
      }
    ]);
  } catch (e)
  {
    logger.error('SFTP', 'REALPATH', 'error:', e);
    logger.info('SFTP', 'REALPATH', `RESPOND failure reqid=${reqid}`);
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

    logger.info('SFTP', 'OPENDIR', `RESPOND handle reqid=${reqid} handle=${key}`);
    self.sftpStream.handle(reqid, handle);
  } catch (e)
  {
    logger.error('SFTP', 'OPENDIR', 'error:', e);
    logger.info('SFTP', 'OPENDIR', `RESPOND failure reqid=${reqid}`);
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
async function SFTP_OPEN(self: SftpConnectionInstance, reqid: number, filename: string, flags: number, attrs: Attributes)
{
  try
  {
    const normalized = normalizePath(filename);

    const key = crypto.randomBytes(16).toString('hex');
    const handle = Buffer.from(key, 'ascii');

    logger.info('SFTP', 'OPEN', `for: '${normalized}' (${filename}), handle: ${key}`);

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
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry || entry.closed)
    {
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
      entry.readNode.removeCallback();
    }

    if (entry.writeNode)
    {
      // Attach the pre-computed checksum so the upload path can skip re-hashing
      if (entry.sha1)
      {
        entry.writeNode.checksum = entry.sha1.digest('base64');
      }
      await self.fsBackend.writeFile(entry.path, entry.writeNode);
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
async function SFTP_STAT(self: SftpConnectionInstance, reqid: number, filePath: string)
{
  try
  {
    const normalized = normalizePath(filePath);

    if (normalized === '/')
    {
      logger.info('SFTP', 'STAT', `RESPOND attrs (root) reqid=${reqid}`);
      return self.sftpStream.attrs(reqid, {
        mode: 0o040755,
        uid: 0,
        gid: 0,
        size: 0,
        mtime: Date.now() / 1000,
        atime: Date.now() / 1000
      });
    }

    const stat = await self.fsBackend.stat(normalized);
    if (!stat)
    {
      logger.info('SFTP', 'STAT', `RESPOND NO_SUCH_FILE reqid=${reqid}`);
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    }

    self.sftpStream.attrs(reqid, {
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      mtime: stat.mtime,
      atime: stat.mtime
    });
  } catch (e)
  {
    logger.error('SFTP', 'STAT', 'error:', e);
    logger.info('SFTP', 'STAT', `RESPOND failure reqid=${reqid}`);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_SETSTAT(self: SftpConnectionInstance, reqid: number, filePath: string, attrs: Attributes)
{
  try
  {
    const normalized = normalizePath(filePath);
    logger.info('SFTP', 'SERVER', `SETSTAT: ${normalized}`, attrs);

    await self.fsBackend.setAttributes(normalized, attrs.mtime);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  } catch (e)
  {
    logger.error('SFTP', 'SETSTAT', 'error:', e);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_LSTAT(self: SftpConnectionInstance, reqid: number, path: string)
{
  try
  {
    const normalized = normalizePath(path);

    if (normalized === '/')
    {
      logger.info('SFTP', 'LSTAT', `RESPOND attrs (root) reqid=${reqid}`);
      return self.sftpStream.attrs(reqid, {
        mode: 0o040755,
        uid: 0,
        gid: 0,
        size: 0,
        mtime: Date.now() / 1000,
        atime: Date.now() / 1000
      });
    }

    const stat = await self.fsBackend.stat(normalized);
    if (!stat)
    {
      logger.info('SFTP', 'LSTAT', `RESPOND NO_SUCH_FILE reqid=${reqid}`);
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    }


    self.sftpStream.attrs(reqid, {
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      mtime: stat.mtime,
      atime: stat.mtime
    });
  } catch (e)
  {
    logger.error('SFTP', 'LSTAT', 'error:', e);
    logger.info('SFTP', 'LSTAT', `RESPOND failure reqid=${reqid}`);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.FAILURE);
  }
}
async function SFTP_FSTAT(self: SftpConnectionInstance, reqid: number, handle: Buffer)
{
  try
  {
    const key = getHandleKey(handle);
    const entry = self.handleMap[key];

    if (!entry)
    {
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    }

    if (entry.writeNode)
    {
      return self.sftpStream.attrs(reqid, {
        mode: 0o100644,
        uid: 0,
        gid: 0,
        size: entry.writeNode.size,
        atime: Date.now() / 1000,
        mtime: Date.now() / 1000
      });
    }

    const stat = await self.fsBackend.stat(entry.path);

    return self.sftpStream.attrs(reqid, {
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      atime: stat.mtime,
      mtime: stat.mtime
    });
  }
  catch (e)
  {
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
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.NO_SUCH_FILE);
    }

    // If writing, apply to the in‑progress node when possible
    if (entry.writeNode)
    {
      if (attrs.mtime && entry.writeNode.isTmp)
      {
        // Only tmp-backed nodes have a real path we can utime
        fs.utimesSync(entry.writeNode.name, attrs.mtime, attrs.mtime);
      }
      return self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
    }

    // Otherwise apply directly to backend
    await self.fsBackend.setAttributes(entry.path, attrs.mtime);
    self.sftpStream.status(reqid, SFTP_STATUS_CODE.OK);
  }
  catch (e)
  {
    logger.error('SFTP', 'FSETSTAT', 'error:', e);
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
    batchSize: config.readBatchSize
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

      const now = Math.floor(Date.now() / 1000);

      const dotEntries: VirtualMetadata[] = [
        VirtualMetadata.directory_ro('.', now),
        VirtualMetadata.directory_ro('..', now),
      ];

      const realFiles = await self.fsBackend.listFiles(entry.path);

      entry.files = [...dotEntries, ...realFiles].map((file) =>
      {
        const perms = file.isDir ? 'drwxr-xr-x' : '-rw-r--r--';
        const d = new Date(file.mtime * 1000);
        const dateStr = `${d.getFullYear()}-${(d.getMonth() + 1)
          .toString()
          .padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;

        return {
          filename: file.name,
          longname: `${perms} 1 user group ${file.size} ${dateStr} ${file.name}`,
          attrs: {
            size: file.size,
            mtime: file.mtime,
            atime: file.atime,
            mode: file.mode,
            uid: file.uid,
            gid: file.gid,
          },
        };
      });

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
      entry.dirIndex = end;

      logger.info('SFTP', 'READDIR', `batch for handle=${key}: ${batch.length} entries`);

      self.sftpStream.name(reqid, batch);

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
  netConfig: SftpConnectionConfig
}

export interface SftpConnectionConfig
{
  batchSize: number
}

export interface SftpItemEntry
{
  filename: string;
  longname: string;
  attrs: {
    size: number;
    mtime: number;
    atime: number;
    mode: number;
    uid: number;
    gid: number;
  };
}

export interface SftpHandleEntry
{
  path: string;
  intendedName: string;
  directoryEntryRead: boolean | null;

  files?: SftpItemEntry[];
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
      server.listen(config.sftpPort, config.listenHost, function ()
      {
        logger.info('SFTP', 'SERVER', `SFTP server listening on ${config.listenHost}:${config.sftpPort}`);
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
  con.on('ready', () => { TCP_Ready(con) });
});