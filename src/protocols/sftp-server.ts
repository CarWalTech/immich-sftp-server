import fs from 'fs';
import { Attributes, Server, Connection } from 'ssh2';
import path from 'path';
import crypto from 'crypto';
import tmp from 'tmp';
import { VirtualFileSystem } from '../filesystem/virtual-file-system';
import { JsonFileSystem } from '../filesystem/json-file-system';
import { ImmichFileSystem } from '../filesystem/immich/immich-file-system';
import { config } from '../config';
import { TransferProtocolServer } from './transfer-protocol-server';

// SFTP Statuscodes
const STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4
};

//Set backend filesystem
interface ImmichSftpConnection extends Connection
{
  fsBackend?: VirtualFileSystem;
}

function createEphemeralHostKeySync(): Buffer
{
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return Buffer.from(privateKey.export({ format: 'pem', type: 'pkcs1' }));
}

const hostKey = createEphemeralHostKeySync();

//Create the SFT Server
const server = new Server({
  hostKeys: [hostKey]
}, (con: ImmichSftpConnection) =>
{
  console.log('Client connected');

  con.on('authentication', async (ctx) =>
  {
    console.log(`Authenticating connection (method: ${ctx.method})`);

    if (ctx.method === 'password')
    {

      // Initialize the file system backend 
      if (con.fsBackend == null)
      {
        con.fsBackend = new ImmichFileSystem();
        //con.fsBackend = new JsonFileSystem('./data/sftp-data.json');
      }

      //Login
      try
      {
        await con.fsBackend.login(ctx.username, ctx.password);
      } catch (err)
      {
        console.error('Authentication failed:', err);
        return ctx.reject();
      }

      console.log('User authenticated successfully');
      ctx.accept();
    }
    else
    {
      // Return supported authentication methods
      return ctx.reject(['password']);
    }
  });

  con.on('end', async () =>
  {
    // Close the file system backend if it exists
    if (con.fsBackend)
    {
      await con.fsBackend.logout();
    }

    console.log('Client disconnected');
  });

  con.on('ready', () =>
  {
    console.log('Client is ready');

    con.on('session', (accept, reject) =>
    {
      const session = accept();
      console.log('Session started');


      session.on('sftp', (accept, reject) =>
      {
        //Accept SFTP session
        const sftpStream = accept();
        console.log('SFTP session started');


        sftpStream.on('error', (err: Error) =>
        {
          console.error('SFTP stream error:', err);
        });



        //Find backend or close connection
        const fsBackend = con.fsBackend;
        if (!fsBackend)
        {
          console.error('File system backend is not initialized. Closing connection.');
          return con.end();
        }

        //Handle map
        const handleMap: Record<string, HandleEntry> = {};

        sftpStream.on('REALPATH', (reqid, givenPath) =>
        {
          try
          {
            const normalized = normalizePath(givenPath);
            console.log(`REALPATH reqid=${reqid} path=${givenPath} → ${normalized}`);

            const now = Math.floor(Date.now() / 1000);

            console.log(`REALPATH RESPOND name reqid=${reqid}`);
            sftpStream.name(reqid, [{
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
            }]);
          } catch (e)
          {
            console.error('REALPATH error:', e);
            console.log(`REALPATH RESPOND failure reqid=${reqid}`);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });



        sftpStream.on('OPENDIR', (reqid, rawPath) =>
        {
          try
          {
            const normalized = normalizePath(rawPath);
            const handle = crypto.randomBytes(4);
            const handleHex = handle.toString('hex');

            console.log(`OPENDIR reqid=${reqid} path='${rawPath}' → '${normalized}', handle=${handleHex}`);

            handleMap[handleHex] = {
              path: normalized,
              directoryEntryRead: false,
              writeTmpFile: null,
              readInitPromise: null,
              readTmpFile: null,
              readSize: null
            };

            console.log(`OPENDIR RESPOND handle reqid=${reqid} handle=${handleHex}`);
            sftpStream.handle(reqid, handle);
          } catch (e)
          {
            console.error('OPENDIR error:', e);
            console.log(`OPENDIR RESPOND failure reqid=${reqid}`);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });


        sftpStream.on('READDIR', (reqid, handle) =>
        {
          const key = handle.toString('hex');
          const entry = handleMap[key] as HandleEntry | undefined;

          console.log(`READDIR reqid=${reqid} handle=${key}`);

          if (!entry)
          {
            console.error(`READDIR on unknown handle ${key}`);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
            return;
          }

          // Initialize queue
          if (!entry.dirPendingReqs)
          {
            entry.dirPendingReqs = [];
          }

          // Enqueue this reqid
          entry.dirPendingReqs.push(reqid);

          // Kick the worker if not already running
          if (!entry.dirBusy)
          {
            processReadDirQueue(entry, key, sftpStream, fsBackend);
          }
        });

        async function processReadDirQueue(
          entry: HandleEntry,
          handleKey: string,
          sftpStream: any,
          fsBackend: VirtualFileSystem
        )
        {
          entry.dirBusy = true;

          try
          {
            // Initialize directory listing once
            if (!entry.dirEntries)
            {
              console.log(`READDIR init listing for handle=${handleKey} path='${entry.path}'`);
              const files = await fsBackend.listFiles(entry.path);

              entry.dirEntries = files.map(file =>
              {
                const perms = file.isDir ? 'drwxr-xr-x' : '-rw-r--r--';
                const date = new Date(file.mtime * 1000);
                const dateStr = date.toISOString().split('T')[0];

                return {
                  filename: file.name,
                  longname: `${perms} 1 user group ${file.size} ${dateStr} ${file.name}`,
                  attrs: {
                    size: file.size,
                    mtime: file.mtime,
                    atime: file.mtime,
                    mode: file.isDir ? 0o040755 : 0o100644,
                    uid: 0,
                    gid: 0
                  }
                };
              });

              entry.dirIndex = 0;
            }

            while (entry.dirPendingReqs && entry.dirPendingReqs.length > 0)
            {
              const reqid = entry.dirPendingReqs.shift()!;

              if (!entry.dirEntries || entry.dirIndex == null)
              {
                console.error(`READDIR: dirEntries/dirIndex missing for handle=${handleKey}`);
                console.log(`READDIR RESPOND failure reqid=${reqid}`);
                sftpStream.status(reqid, STATUS_CODE.FAILURE);
                continue;
              }

              if (entry.dirIndex >= entry.dirEntries.length)
              {
                console.log(`READDIR RESPOND EOF reqid=${reqid} handle=${handleKey}`);
                sftpStream.status(reqid, STATUS_CODE.EOF);
                continue;
              }

              const nextEntry = entry.dirEntries[entry.dirIndex++];
              console.log(`READDIR RESPOND name reqid=${reqid} handle=${handleKey} filename='${nextEntry.filename}'`);
              sftpStream.name(reqid, [nextEntry]);
            }
          } catch (err)
          {
            console.error(`READDIR error for handle=${handleKey}:`, err);
            if (entry.dirPendingReqs)
            {
              for (const reqid of entry.dirPendingReqs)
              {
                sftpStream.status(reqid, STATUS_CODE.FAILURE);
              }
              entry.dirPendingReqs = [];
            }
          } finally
          {
            entry.dirBusy = false;
          }
        }



        sftpStream.on('OPEN', async (reqid, filename, flags, attrs) =>
        {
          try
          {
            const normalized = normalizePath(filename);
            const handle = crypto.randomBytes(4);
            const handleHex = handle.toString('hex');
            console.log(`OPEN for: '${normalized}', handle: ${handleHex}`);

            handleMap[handleHex] = {
              path: filename,

              //Directory Handling
              directoryEntryRead: null,

              //Write files
              writeTmpFile: null,

              //Read files content
              readInitPromise: null,
              readTmpFile: null,
              readSize: null
            };

            sftpStream.handle(reqid, handle);
          } catch (e)
          {
            console.error('OPEN error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('READ', async (reqid, handle, offset, length) =>
        {
          try
          {
            const key = handle.toString('hex');
            const entry = handleMap[key];

            console.log(`READ reqid=${reqid} handle=${key} offset=${offset} length=${length}`);

            if (!entry)
            {
              console.error(`READ on unknown handle ${key}`);
              console.log(`READ RESPOND failure reqid=${reqid}`);
              return sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }

            if (!entry.readInitPromise)
            {
              console.log(`READ init file for handle=${key} path='${entry.path}'`);
              entry.readInitPromise = (async () =>
              {
                entry.readTmpFile = await fsBackend.readFile(entry.path);
                const stats = fs.statSync(entry.readTmpFile.name);
                entry.readSize = stats.size;
                console.log(`READ init done handle=${key} size=${entry.readSize}`);
              })();
            }

            await entry.readInitPromise;

            if (entry.readTmpFile == null || entry.readSize == null)
            {
              console.error(`READ failed: readTmpFile or readSize missing for handle ${key}`);
              console.log(`READ RESPOND failure reqid=${reqid}`);
              return sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }

            if (offset >= entry.readSize)
            {
              console.log(`READ RESPOND EOF reqid=${reqid} handle=${key}`);
              return sftpStream.status(reqid, STATUS_CODE.EOF);
            }

            const buffer = Buffer.alloc(length);
            const bytesRead = fs.readSync(entry.readTmpFile.fd, buffer, 0, length, offset);

            if (bytesRead === 0)
            {
              console.log(`READ RESPOND EOF (0 bytes) reqid=${reqid} handle=${key}`);
              return sftpStream.status(reqid, STATUS_CODE.EOF);
            }

            console.log(`READ RESPOND data reqid=${reqid} handle=${key} bytes=${bytesRead}`);
            sftpStream.data(reqid, buffer.slice(0, bytesRead));
          } catch (e)
          {
            console.error('READ error:', e);
            console.log(`READ RESPOND failure reqid=${reqid}`);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });


        sftpStream.on('WRITE', async (reqid, handle, offset, data) =>
        {
          try
          {
            const key = handle.toString('hex');
            const entry = handleMap[key];

            console.log(`WRITE reqid=${reqid} handle=${key} offset=${offset} length=${data.length}`);

            if (!entry)
            {
              console.error(`WRITE on unknown handle ${key}`);
              console.log(`WRITE RESPOND failure reqid=${reqid}`);
              return sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }

            if (entry.writeTmpFile == null)
            {
              console.log(`WRITE init tmp file for handle=${key}`);
              entry.writeTmpFile = tmp.fileSync();
            }

            fs.writeSync(entry.writeTmpFile.fd, data, 0, data.length, offset);
            console.log(`WRITE RESPOND OK reqid=${reqid} handle=${key}`);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e)
          {
            console.error('WRITE error:', e);
            console.log(`WRITE RESPOND failure reqid=${reqid}`);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });


        sftpStream.on('CLOSE', async (reqid, handle) =>
        {
          try
          {
            const key = handle.toString('hex');
            const entry = handleMap[key];

            console.log(`CLOSE reqid=${reqid} handle=${key}`);

            if (!entry)
            {
              console.error(`CLOSE on unknown handle ${key}`);
              console.log(`CLOSE RESPOND OK (already closed) reqid=${reqid}`);
              return sftpStream.status(reqid, STATUS_CODE.OK);
            }

            if (entry.readTmpFile != null)
            {
              console.log(`CLOSE removing read tmp file for handle=${key}`);
              entry.readTmpFile.removeCallback();
            }

            if (entry.writeTmpFile != null)
            {
              console.log(`CLOSE writing backend file for handle=${key} path='${entry.path}'`);
              await fsBackend.writeFile(entry.path, entry.writeTmpFile);
            }

            delete handleMap[key];
            console.log(`CLOSE RESPOND OK reqid=${reqid} handle=${key}`);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e)
          {
            console.error('CLOSE error:', e);
            console.log(`CLOSE RESPOND failure reqid=${reqid}`);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });


        sftpStream.on('STAT', async (reqid, filePath) =>
        {
          try
          {
            const normalized = normalizePath(filePath)
            console.log(`STAT reqid=${reqid} path=${filePath} → ${normalized}`);

            if (normalized === '/')
            {
              console.log(`STAT RESPOND attrs (root) reqid=${reqid}`);
              return sftpStream.attrs(reqid, {
                mode: 0o040755,
                uid: 0,
                gid: 0,
                size: 0,
                mtime: Date.now() / 1000,
                atime: Date.now() / 1000
              });
            }

            const stat = await fsBackend.stat(normalized);
            if (!stat)
            {
              console.log(`STAT RESPOND NO_SUCH_FILE reqid=${reqid}`);
              return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }

            console.log(`STAT RESPOND attrs reqid=${reqid} size=${stat.size} isDir=${stat.isDir}`);
            sftpStream.attrs(reqid, {
              mode: stat.isDir ? 0o040755 : 0o100644,
              uid: 0,
              gid: 0,
              size: stat.size,
              mtime: stat.mtime,
              atime: stat.mtime
            });
          } catch (e)
          {
            console.error('STAT error:', e);
            console.log(`STAT RESPOND failure reqid=${reqid}`);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });


        sftpStream.on('SETSTAT', async (reqid, filePath, attrs: Attributes) =>
        {
          try
          {
            const normalized = normalizePath(filePath);
            console.log(`SETSTAT: ${normalized}`, attrs);

            await fsBackend.setAttributes(normalized, attrs.mtime);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e)
          {
            console.error('SETSTAT error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('RENAME', async (reqid, oldPath, newPath) =>
        {
          try
          {
            const oldName = normalizePath(oldPath);
            const newName = normalizePath(newPath);
            console.log(`RENAME requested: ${oldName} → ${newName}`);

            await fsBackend.rename(oldName, newName);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e)
          {
            console.error('RENAME error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('REMOVE', async (reqid, filePath) =>
        {
          try
          {
            const normalized = normalizePath(filePath);
            console.log(`REMOVE requested: ${normalized}`);

            await fsBackend.remove(normalized);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e)
          {
            console.error('REMOVE error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('MKDIR', async (reqid, dirPath, attrs) =>
        {
          try
          {
            const normalized = normalizePath(dirPath);
            console.log(`MKDIR: ${normalized}`);

            await fsBackend.mkdir(normalized);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e)
          {
            console.error('MKDIR error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('RMDIR', async (reqid, dirPath) =>
        {
          try
          {
            const normalized = normalizePath(dirPath);
            console.log(`RMDIR: ${normalized}`);

            await fsBackend.remove(normalized);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e)
          {
            console.error('RMDIR error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

      });
    });
  });
});

export class SftpProtocolServer implements TransferProtocolServer
{
  readonly name = 'sftp';

  async start(): Promise<void>
  {
    await new Promise<void>((resolve, reject) =>
    {
      server.listen(config.sftpPort, config.listenHost, function ()
      {
        console.log(`SFTP server listening on ${config.listenHost}:${config.sftpPort}`);
        resolve();
      });
      server.on('error', reject);
    });
  }
}


//Helper
function normalizePath(p: string): string
{
  const normalized = path.posix.normalize(p);  // Pfade auflösen: z.B. 'foo//bar/../baz' → 'foo/baz'
  const absPath = normalized.replace(/^\/+|\/+$/g, ''); // führende und abschließende Slashes entfernen
  return "/" + absPath;
}

//Data classes
interface SftpDirEntry
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

interface HandleEntry
{
  path: string;

  // Directory handling
  directoryEntryRead: boolean | null;

  // New directory state
  dirEntries?: SftpDirEntry[];
  dirIndex?: number;

  // NEW: queue + lock for READDIR
  dirPendingReqs?: number[];
  dirBusy?: boolean;

  // Write files
  writeTmpFile: tmp.FileResult | null;

  // Read files content
  readInitPromise: Promise<void> | null;
  readTmpFile: tmp.FileResult | null;
  readSize: number | null;
}


