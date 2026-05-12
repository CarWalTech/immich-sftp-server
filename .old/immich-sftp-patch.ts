// @ts-nocheck

import { EventEmitter } from "stream";

const SFTP = require('ssh2/lib/protocol/SFTP');
const {
    bufferCopy,
    bufferSlice,
    makeBufferParser,
    writeUInt32BE,
} = require('ssh2/lib/protocol/utils.js');

function drainBuffer()
{
    // @ts-ignore
    this._chunkcb = undefined;
    // @ts-ignore
    const buffer = this._buffer;
    let i = 0;
    while (i < buffer.length)
    {
        const payload = buffer[i];
        // @ts-ignore
        const ret = tryWritePayload(this, payload);
        if (ret !== undefined)
        {
            if (ret !== payload)
                buffer[i] = ret;
            if (i > 0)
                this._buffer = buffer.slice(i);
            return;
        }
        ++i;
    }
    if (i > 0)
        this._buffer = [];
}

function tryWritePayload(sftp, payload)
{
    const outgoing = sftp.outgoing;
    if (outgoing.state !== 'open')
        return;

    if (outgoing.window === 0)
    {
        sftp._waitWindow = true;
        sftp._chunkcb = drainBuffer;
        return payload;
    }

    let ret;
    const len = payload.length;
    let p = 0;

    while (len - p > 0 && outgoing.window > 0)
    {
        const actualLen = Math.min(len - p, outgoing.window, outgoing.packetSize);
        outgoing.window -= actualLen;
        if (outgoing.window === 0)
        {
            sftp._waitWindow = true;
            sftp._chunkcb = drainBuffer;
        }

        if (p === 0 && actualLen === len)
        {
            sftp._protocol.channelData(sftp.outgoing.id, payload);
        } else
        {
            sftp._protocol.channelData(sftp.outgoing.id,
                bufferSlice(payload, p, p + actualLen));
        }

        p += actualLen;
    }

    if (len - p > 0)
    {
        if (p > 0)
            ret = bufferSlice(payload, p, len);
        else
            ret = payload; // XXX: should never get here?
    }

    return ret;
}

function sendOrBuffer(sftp, payload)
{
    const ret = tryWritePayload(sftp, payload);
    if (ret !== undefined)
    {
        sftp._buffer.push(ret);
        return false;
    }
    return true;
}

const SERVER_VERSION_BUFFER = Buffer.from([
    0, 0, 0, 5 /* length */,
    2,
    0, 0, 0, 3 /* version */
]);

function cleanupRequests(sftp)
{
    const keys = Object.keys(sftp._requests);
    if (keys.length === 0)
        return;

    const reqs = sftp._requests;
    sftp._requests = {};
    const err = new Error('No response from server');
    for (let i = 0; i < keys.length; ++i)
    {
        const req = reqs[keys[i]];
        if (typeof req.cb === 'function')
            req.cb(err);
    }
}

function doFatalSFTPError(sftp, msg, noDebug)
{
    const err = new Error(msg);
    err.level = 'sftp-protocol';
    if (!noDebug && sftp._debug)
        sftp._debug(`SFTP: Inbound: ${msg}`);
    sftp.emit('error', err);
    sftp.destroy();
    cleanupRequests(sftp);
    return false;
}

const SERVER_EXTENSIONS = {
    'posix-rename@openssh.com': '1',
    'statvfs@openssh.com': '1',
    'fsync@openssh.com': '1'
};

function buildServerVersionBuffer(extensions)
{
    // SFTP protocol: uint32 version, then repeated: string name, string data
    const version = 3; // ssh2’s SFTP implementation is v3

    const entries = Object.entries(extensions || {});
    let payloadLen = 4; // version

    for (const [name, data] of entries)
    {
        const nameLen = Buffer.byteLength(name);
        const dataLen = Buffer.byteLength(data);
        payloadLen += 4 + nameLen + 4 + dataLen;
    }

    const buf = Buffer.allocUnsafe(4 + 1 + payloadLen);
    let p = 0;

    // uint32 length (type + payload)
    const pktLen = 1 + payloadLen;
    buf.writeUInt32BE(pktLen, p); p += 4;

    // byte type = SSH_FXP_VERSION (2)
    buf[p++] = 2;

    // uint32 version
    buf.writeUInt32BE(version, p); p += 4;

    // extensions: string name, string data
    for (const [name, data] of entries)
    {
        //console.log(`Extension Loaded: ${name} (version:${data})`)
        const nameLen = Buffer.byteLength(name);
        const dataLen = Buffer.byteLength(data);

        buf.writeUInt32BE(nameLen, p); p += 4;
        buf.utf8Write(name, p, nameLen); p += nameLen;

        buf.writeUInt32BE(dataLen, p); p += 4;
        buf.utf8Write(data, p, dataLen); p += dataLen;
    }

    return buf;
}

// Source - https://stackoverflow.com/a/40031979
// Posted by Freyja, modified by community. See post 'Timeline' for change history
// Retrieved 2026-05-07, License - CC BY-SA 4.0

function buf2hex(buffer)
{ // buffer is an ArrayBuffer
    return [...new Uint8Array(buffer)]
        .map(x => x.toString(16).padStart(2, '0'))
        .join('');
}


const bufferParser = makeBufferParser();




const enablePatch = false;
if (enablePatch === true)
{
    const originalPush = SFTP.SFTP.prototype.push;
    SFTP.SFTP.prototype.push = function patchedPush(data: Buffer) 
    {
        // Peek at packet type before original logic runs
        if (data && data.length > 4)
        {
            const type = data[4]; // byte after length
            const REQUEST_INIT = 1; // SFTP INIT opcode
            const RESPONSE_VERSION = 2

            if (this.server && type === REQUEST_INIT)
            {
                if (this._version !== -1)
                    return doFatalSFTPError(this, 'Duplicate INIT packet');

                const extensions = {};

                /*
                uint32 version
                <extension data>
                */
                bufferParser.init(data, 5);
                const version = bufferParser.readUInt32BE();

                for (const [extName, extData] of Object.entries(SERVER_EXTENSIONS))
                {
                    extensions[extName] = extData
                }

                bufferParser.clear();
                //console.log(`Client Version: ${version}`)
                if (version === undefined)
                    return doFatalSFTPError(this, 'Malformed INIT packet');

                if (this._debug)
                {
                    const names = Object.keys(extensions);
                    if (names.length)
                    {
                        this._debug(
                            `SFTP: Inbound: Received INIT (v${version}, exts:${names})`
                        );
                    } else
                    {
                        this._debug(`SFTP: Inbound: Received INIT (v${version})`);
                    }
                }

                sendOrBuffer(this, buildServerVersionBuffer(extensions));

                this._version = version;
                this._extensions = extensions;
                this.emit('ready');
                return
            }
            else
            {
                // Default behavior
                return originalPush.call(this, data);
            }
        }
    };
}

const enableConstructorPatch = false;
if (enableConstructorPatch === true)
{
    const originalPush2 = SFTP.SFTP.prototype.push;
    SFTP.SFTP.prototype.push = function patchedPush2(data: Buffer)
    {
        if (typeof this._immich_mod_loaded == 'undefined')
        {
            this._immich_mod_loaded = true;
        }
        return originalPush2.call(this, data);
    };
}

