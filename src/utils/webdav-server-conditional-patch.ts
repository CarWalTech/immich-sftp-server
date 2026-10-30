// Runtime patch adding HTTP conditional-request support to webdav-server v2's GET/HEAD.
//
// The library never sends ETag or Last-Modified on GET/HEAD and ignores If-None-Match,
// If-Modified-Since and If-Range entirely, so a client re-opening a file it already
// has cached (Finder, Explorer, rclone/VFS caches, browsers) re-downloads the whole
// original every time — over a remote link that's the full RAW/video again.
//
// Fix: wrap GET and HEAD so that, before the normal handler runs, we
//   - emit ETag + Last-Modified (the ETag is the same _etag() PROPFIND reports, so
//     a client may revalidate with either),
//   - answer 304 Not Modified when If-None-Match / If-Modified-Since say the
//     client's copy is current,
//   - drop the Range header when If-Range doesn't match, so a resumed download of a
//     file that changed underneath gets the full new body instead of a spliced one.
// Anything we can't resolve (missing resource, stat error) just falls through to the
// original handler unchanged.

// Must be applied first: this wraps whatever GET handler is current, and the range
// patch replaces it — importing it here pins the order (range inside, us outside).
import './webdav-server-range-patch';

const GetModule = require('webdav-server/lib/server/v2/commands/Get') as {
  default: new () => { unchunked: (ctx: any, data: string, callback: () => void) => void };
};
const HeadModule = require('webdav-server/lib/server/v2/commands/Head') as {
  default: new () => { unchunked: (ctx: any, data: string, callback: () => void) => void };
};
const { HTTPCodes } = require('webdav-server/lib/server/v2/WebDAVRequest') as {
  HTTPCodes: Record<string, number>;
};

type Unchunked = (this: unknown, ctx: any, data: string, callback: () => void) => void;

// Weak comparison (RFC 9110 §13.1.2) — W/ prefixes are ignored for If-None-Match.
function etagListMatches(header: string, etag: string): boolean
{
  if (header.trim() === '*') return true;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some(tag => tag.trim().replace(/^W\//, '') === bare);
}

function withConditionalHeaders(original: Unchunked): Unchunked
{
  return function (this: unknown, ctx: any, data: string, callback: () => void): void
  {
    ctx.getResource((e: unknown, r: any) =>
    {
      if (e || !r) { original.call(this, ctx, data, callback); return; }

      r.etag((e1: unknown, etag?: string) =>
      {
        r.lastModifiedDate((e2: unknown, mtimeMs?: number) =>
        {
          const hasEtag = !e1 && !!etag;
          const hasMtime = !e2 && typeof mtimeMs === 'number' && mtimeMs > 0;
          if (hasEtag) ctx.response.setHeader('ETag', etag);
          if (hasMtime) ctx.response.setHeader('Last-Modified', new Date(mtimeMs!).toUTCString());

          // If-None-Match takes precedence; If-Modified-Since is only consulted without it.
          const ifNoneMatch = ctx.headers.find('If-None-Match');
          const ifModifiedSince = ctx.headers.find('If-Modified-Since');
          let notModified = false;
          if (ifNoneMatch)
            notModified = hasEtag && etagListMatches(ifNoneMatch, etag!);
          else if (ifModifiedSince && hasMtime)
          {
            const since = Date.parse(ifModifiedSince);
            // HTTP dates have 1 s resolution — compare at that granularity.
            notModified = !isNaN(since) && Math.floor(mtimeMs! / 1000) <= Math.floor(since / 1000);
          }

          if (notModified)
          {
            ctx.setCode(HTTPCodes.NotModified);
            callback();
            return;
          }

          // If-Range carries either an ETag (strong match required) or an HTTP date.
          const ifRange = ctx.headers.find('If-Range');
          if (ifRange && ctx.headers.find('Range'))
          {
            const matches = ifRange.startsWith('"') || ifRange.startsWith('W/')
              ? hasEtag && !ifRange.startsWith('W/') && ifRange === etag
              : hasMtime && Math.floor(mtimeMs! / 1000) <= Math.floor(Date.parse(ifRange) / 1000);
            if (!matches)
              for (const k of Object.keys(ctx.headers.headers))
                if (k.toLowerCase() === 'range') delete ctx.headers.headers[k];
          }

          original.call(this, ctx, data, callback);
        });
      });
    });
  };
}

GetModule.default.prototype.unchunked = withConditionalHeaders(GetModule.default.prototype.unchunked);
HeadModule.default.prototype.unchunked = withConditionalHeaders(HeadModule.default.prototype.unchunked);
