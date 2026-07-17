const path = require('path');
const http = require('http');
const repoRoot = '/omv/apps-compose/immich-file-bridge/repo';
process.chdir(repoRoot);
const { v2: webdav } = require(path.join(repoRoot, 'node_modules/webdav-server'));

// Apply the same patches the app applies (compiled JS equivalents via ts-node not needed;
// we re-implement patch loading using ts-node/register so the actual .ts patch files run).
require('ts-node').register({ transpileOnly: true, project: path.join(repoRoot, 'tsconfig.json') });
require(path.join(repoRoot, 'src/utils/webdav-server-proppatch-patch.ts'));
require(path.join(repoRoot, 'src/utils/xml-js-builder-patch.ts'));

const tmp = require('tmp');
const dir = tmp.dirSync();
console.log('serving', dir.name);

const server = new webdav.WebDAVServer({ port: 0, requireAuthentification: false });
server.setFileSystem('/', new webdav.PhysicalFileSystem(dir.name), () => {
  server.start(httpServer => {
    const port = httpServer.address().port;
    console.log('listening on', port);
    run(port).then(() => process.exit(0)).catch(e => { console.error('FAILED', e); process.exit(1); });
  });
});

function req(port, method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ port, method, path, headers: { 'Content-Type': 'application/xml', ...headers } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function run(port) {
  // 1. Create a file
  let r = await req(port, 'PUT', '/photo.jpg', 'hello world');
  console.log('PUT ->', r.status);

  // 2. touch() simulation: PROPPATCH DAV:lastmodified (already-fixed scenario)
  const touchBody = `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:">
  <D:set><D:prop><D:lastmodified>Mon, 13 Jul 2026 00:00:00 GMT</D:lastmodified></D:prop></D:set>
</D:propertyupdate>`;
  r = await req(port, 'PROPPATCH', '/photo.jpg', touchBody);
  console.log('PROPPATCH lastmodified ->', r.status, r.body.slice(0, 300));

  // 3. favorite/rating-style custom property, oc namespace
  const favBody = `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns">
  <D:set><D:prop><oc:favorite>1</oc:favorite></D:prop></D:set>
</D:propertyupdate>`;
  r = await req(port, 'PROPPATCH', '/photo.jpg', favBody);
  console.log('PROPPATCH oc:favorite ->', r.status, r.body.slice(0, 500));

  // 4. nc:rating style custom property
  const ratingBody = `<?xml version="1.0"?>
<D:propertyupdate xmlns:D="DAV:" xmlns:nc="http://nextcloud.org/ns">
  <D:set><D:prop><nc:rating>4</nc:rating></D:prop></D:set>
</D:propertyupdate>`;
  r = await req(port, 'PROPPATCH', '/photo.jpg', ratingBody);
  console.log('PROPPATCH nc:rating ->', r.status, r.body.slice(0, 500));

  // 5. PROPFIND requesting these props back (as Nextcloud's client would, to refresh the row)
  const propfindBody = `<?xml version="1.0"?>
<D:propfind xmlns:D="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <D:prop>
    <D:getlastmodified/>
    <oc:favorite/>
    <nc:rating/>
  </D:prop>
</D:propfind>`;
  r = await req(port, 'PROPFIND', '/photo.jpg', propfindBody, { Depth: '0' });
  console.log('PROPFIND ->', r.status);
  console.log(r.body);

  // 6. Another touch() after the custom props were set -- the real-world sequence:
  //    PUT -> PROPPATCH lastmodified -> (favorite/rating change) -> PROPPATCH lastmodified again
  r = await req(port, 'PROPPATCH', '/photo.jpg', touchBody);
  console.log('PROPPATCH lastmodified (2nd) ->', r.status, r.body.slice(0, 300));
}
