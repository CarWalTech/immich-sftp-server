// Runtime patch adding gzip Content-Encoding to webdav-server v2's XML/JSON responses.
//
// Every multistatus body (PROPFIND above all, also PROPPATCH/LOCK) is written by
// HTTPRequestContext#writeBody as plain text.  A Depth:1 PROPFIND on a big album is
// several MB of highly repetitive XML — over a remote link that dominates the time to
// open a folder, and it compresses roughly 10×.
//
// Fix: replace writeBody with an equivalent that gzips the body when the client
// advertises gzip and the body is big enough to be worth it.  File bodies (GET) don't
// go through writeBody and are left alone — photos and videos are already compressed.
//
// Compression is synchronous because writeBody is: every caller ends the response
// right after it returns.  At the level used here a multi-MB listing compresses in a
// few milliseconds, far less than the transfer time it saves.

import zlib from 'zlib';

const { HTTPRequestContext } = require('webdav-server/lib/server/v2/WebDAVRequest') as {
  HTTPRequestContext: { prototype: any };
};
const { XML } = require('xml-js-builder') as {
  XML: { toXML(xml: unknown): string; toJSON(xml: string): string };
};

// Below this, the gzip header/CPU overhead isn't worth it.
const MIN_COMPRESS_BYTES = 1024;
// Fast levels already capture almost all of the gain on repetitive XML.
const GZIP_LEVEL = 4;

// True unless gzip is absent or explicitly refused (gzip;q=0).
function acceptsGzip(header: string | null): boolean
{
  if (!header) return false;
  return header.split(',').some(part =>
  {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding.trim() !== 'gzip' && coding.trim() !== '*') return false;
    const q = params.map(p => p.trim()).find(p => p.startsWith('q='));
    return !q || parseFloat(q.slice(2)) > 0;
  });
}

HTTPRequestContext.prototype.writeBody = function (this: any, xmlObject: unknown): void
{
  let content = XML.toXML(xmlObject);
  let contentType = 'application/xml;charset=utf-8';
  if (this.headers.findBestAccept() === 'json')
  {
    content = XML.toJSON(content);
    contentType = 'application/json;charset=utf-8';
  }

  let body = Buffer.from(content, 'utf8');
  this.response.setHeader('Content-Type', contentType);
  this.response.setHeader('Vary', 'Accept-Encoding');
  if (body.length >= MIN_COMPRESS_BYTES && acceptsGzip(this.headers.find('Accept-Encoding')))
  {
    body = zlib.gzipSync(body, { level: GZIP_LEVEL });
    this.response.setHeader('Content-Encoding', 'gzip');
  }
  this.response.setHeader('Content-Length', body.length.toString());
  this.response.write(body);
  this.responseBody = content;
};
