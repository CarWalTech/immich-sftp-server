// Runtime patch adding true byte-range pass-through to webdav-server v2's GET handler.
//
// Bug (by design, not really a bug in the library, just wrong for us) — Get.js always
// calls Resource#openReadStream() for the FULL asset regardless of an incoming Range
// header, then slices the result in memory with its own RangedStream transform:
//   https://github.com/OpenMarshal/npm-WebDAV-Server/blob/master/src/server/v2/commands/Get.ts
// For this bridge that means every partial read — video seeking, resumed downloads,
// some clients' partial image fetches — pulls the ENTIRE asset through Immich and
// buffers it first, just to throw away everything but a small slice.
//
// Fix: when a single-range Range header is present and the resolved FileSystem exposes
// an `openRangeReadStream` method (see ImmichWebdavFileSystem in webdav-server.ts), use
// it to stream only the requested bytes directly. Falls back to the original full-read
// behavior for multi-range requests, or whenever the range-aware path can't help (e.g.
// XMP-embedding is enabled, so byte offsets in the original can't be trusted).
//
// Patching live module exports rather than node_modules files means the fix survives
// `npm install`.

const GetModule = require('webdav-server/lib/server/v2/commands/Get') as {
  default: new () => { unchunked: (ctx: any, data: string, callback: () => void) => void };
};
const { HTTPCodes } = require('webdav-server/lib/server/v2/WebDAVRequest') as {
  HTTPCodes: Record<string, number>;
};

const originalUnchunked = GetModule.default.prototype.unchunked;

interface ParsedRange
{
  start?: number;
  end?: number;
  suffixLength?: number;
}

function parseSingleRange(header: string): ParsedRange | null
{
  const value = header.replace(/^bytes=/, '');
  if (value.includes(',')) return null; // multi-range — let the original handler deal with it

  const suffixMatch = /^-(\d+)$/.exec(value);
  if (suffixMatch) return { suffixLength: parseInt(suffixMatch[1], 10) };

  const rangeMatch = /^(\d+)-(\d*)$/.exec(value);
  if (!rangeMatch) return null;
  return {
    start: parseInt(rangeMatch[1], 10),
    end: rangeMatch[2] ? parseInt(rangeMatch[2], 10) : undefined,
  };
}

function patchedUnchunked(this: unknown, ctx: any, data: string, callback: () => void): void
{
  const rangeHeader = ctx.headers.find('Range');
  const spec = rangeHeader ? parseSingleRange(rangeHeader) : null;
  if (!spec)
  {
    originalUnchunked.call(this, ctx, data, callback);
    return;
  }

  ctx.noBodyExpected(() =>
  {
    ctx.getResource((e: unknown, r: any) =>
    {
      if (e)
      {
        if (!ctx.setCodeFromError(e)) ctx.setCode(HTTPCodes.InternalServerError);
        callback();
        return;
      }
      ctx.checkIfHeader(r, () =>
      {
        if (typeof r.fs.openRangeReadStream !== 'function')
        {
          originalUnchunked.call(this, ctx, data, callback);
          return;
        }

        const targetSource = ctx.headers.isSource;
        r.type((e2: unknown, type: any) =>
        {
          if (e2)
          {
            if (!ctx.setCodeFromError(e2)) ctx.setCode(HTTPCodes.InternalServerError);
            callback();
            return;
          }
          if (!type.isFile)
          {
            ctx.setCode(HTTPCodes.MethodNotAllowed);
            callback();
            return;
          }

          r.mimeType(targetSource, (e3: unknown, mimeType: string) =>
          {
            if (e3)
            {
              if (!ctx.setCodeFromError(e3)) ctx.setCode(HTTPCodes.InternalServerError);
              callback();
              return;
            }

            r.fs.openRangeReadStream(r.context, r.path, spec, (e4: unknown, result: any) =>
            {
              if (e4 || !result)
              {
                // Range unsupported for this asset right now (e.g. embedded-metadata
                // mode) or a real error — either way, fall back to a full read.
                originalUnchunked.call(this, ctx, data, callback);
                return;
              }

              const { stream, start, end, total } = result;
              stream.on('error', (e5: unknown) =>
              {
                if (!ctx.setCodeFromError(e5)) ctx.setCode(HTTPCodes.InternalServerError);
                callback();
              });
              ctx.setCode(HTTPCodes.PartialContent);
              ctx.response.setHeader('Accept-Ranges', 'bytes');
              ctx.response.setHeader('Content-Type', mimeType);
              ctx.response.setHeader('Content-Length', String(end - start + 1));
              ctx.response.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
              stream.on('end', callback);
              stream.pipe(ctx.response);
            });
          });
        });
      });
    });
  });
}

GetModule.default.prototype.unchunked = patchedUnchunked;
