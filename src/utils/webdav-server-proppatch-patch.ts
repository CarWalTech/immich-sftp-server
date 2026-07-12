// Runtime patch for a webdav-server v2 PROPPATCH bug.
//
// Bug — Proppatch.js unconditionally rejects any `DAV:set` whose property name
// is in the `DAV:` namespace (e.g. `{DAV:}lastmodified`), always responding 403
// regardless of what the FileSystem's PropertyManager would otherwise allow:
//   https://github.com/OpenMarshal/npm-WebDAV-Server/blob/master/src/server/v2/commands/Proppatch.ts
//
// NextCloud's DAV storage backend calls touch() after every PUT/MOVE to set
// `{DAV:}lastmodified` on the uploaded file. Getting back a 403 makes NextCloud
// throw a StorageNotAvailableException from that touch() call, which is exactly
// what OC\Files\Storage\Wrapper\Availability uses to flag the whole external
// storage mount as unavailable — so every single upload (and, transitively,
// anything that touches a parent directory's mtime) knocks the mount offline
// until an admin manually re-checks it.
//
// Fix: treat `DAV:` namespaced property sets the same as any other property —
// hand them to the FileSystem's PropertyManager instead of always failing.
// Patching live module exports rather than node_modules files means the fix
// survives `npm install`.

import { XML, XMLElementBuilder } from 'xml-js-builder';

const ProppatchModule = require('webdav-server/lib/server/v2/commands/Proppatch') as { default: new () => { unchunked: unknown } };
const { HTTPRequestContext, HTTPCodes } = require('webdav-server/lib/server/v2/WebDAVRequest') as {
  HTTPRequestContext: { encodeURL(url: string): string };
  HTTPCodes: Record<string, number>;
};
const { STATUS_CODES } = require('http') as { STATUS_CODES: Record<number, string> };
const { Workflow } = require('webdav-server/lib/helper/Workflow') as { Workflow: new (...args: unknown[]) => any };
const { Errors } = require('webdav-server/lib/Errors') as { Errors: Record<string, unknown> };

type Callback = (err?: unknown) => void;
type AnyObj = Record<string, any>;

function patchedUnchunked(ctx: AnyObj, data: string, callback: () => void): void {
  ctx.getResource((_e: unknown, r: AnyObj) => {
    ctx.checkIfHeader(r, () => {
      const multistatus = new XMLElementBuilder('D:multistatus', { 'xmlns:D': 'DAV:' });
      const response = multistatus.ele('D:response');
      response.ele('D:href', undefined, true).add(HTTPRequestContext.encodeURL(ctx.fullUri()));

      try {
        const xml = XML.parse(data);
        const root = xml.find('DAV:propertyupdate');
        const notifications: Record<number, string[]> = {};
        const reverse: Array<(cb: Callback) => void> = [];

        let finalize = () => {
          finalize = () => { /* no-op after first call */ };
          const next = () => {
            for (const code of Object.keys(notifications)) {
              const propstat = response.ele('D:propstat');
              const prop = propstat.ele('D:prop');
              notifications[Number(code)].forEach(name => prop.add(new XMLElementBuilder(name)));
              propstat.ele('D:status').add('HTTP/1.1 ' + code + ' ' + STATUS_CODES[Number(code)]);
            }
            ctx.setCode(HTTPCodes.MultiStatus);
            ctx.writeBody(multistatus);
            callback();
          };
          if (Object.keys(notifications).length > 1) {
            new Workflow()
              .each(reverse, (action: (cb: Callback) => void, cb: Callback) => action(cb))
              .error((e: unknown) => {
                if (!ctx.setCodeFromError(e)) ctx.setCode(HTTPCodes.InternalServerError);
                callback();
              })
              .done(() => {
                if (notifications[HTTPCodes.OK]) {
                  notifications[HTTPCodes.FailedDependency] = notifications[HTTPCodes.OK];
                  delete notifications[HTTPCodes.OK];
                }
                next();
              });
          }
          else next();
        };

        const notify = (el: AnyObj, error: unknown) => {
          const code = error ? HTTPCodes.Forbidden : HTTPCodes.OK;
          if (!notifications[code]) notifications[code] = [];
          notifications[code].push(el.name);
        };

        const execute = (name: string, _eventName: string, fnProp: (el: AnyObj, cb: Callback) => void) => {
          const list = root.findMany(name);
          if (list.length === 0) { finalize(); return; }
          list.forEach((el: AnyObj) => {
            const els = el.find('DAV:prop').elements;
            new Workflow(false)
              .each(els, (x: AnyObj, cb: Callback) => {
                if (x.type !== 'element') return cb();
                fnProp(x, cb);
              })
              .intermediate((el2: AnyObj, e: unknown) => {
                if (el2.type === 'element') notify(el2, e);
              })
              .done((_: unknown) => finalize());
          });
        };

        r.fs.checkPrivilege(ctx, r.path, 'canWriteProperties', (e: unknown, can: boolean) => {
          if (e || !can) {
            if (e) { if (!ctx.setCodeFromError(e)) ctx.setCode(HTTPCodes.InternalServerError); }
            else if (!can) ctx.setCodeFromError((Errors as AnyObj).NotEnoughPrivilege);
            return callback();
          }
          r.fs.isLocked(ctx, r.path, (e2: unknown, locked: boolean) => {
            if (e2 || locked) {
              if (e2) { if (!ctx.setCodeFromError(e2)) ctx.setCode(HTTPCodes.InternalServerError); }
              else if (locked) ctx.setCode(HTTPCodes.Locked);
              return callback();
            }
            r.propertyManager((e3: unknown, pm: AnyObj) => {
              if (e3) {
                if (!ctx.setCodeFromError(e3)) ctx.setCode(HTTPCodes.InternalServerError);
                return callback();
              }
              pm.getProperties((e4: unknown, props: AnyObj) => {
                if (e4) {
                  if (!ctx.setCodeFromError(e4)) ctx.setCode(HTTPCodes.InternalServerError);
                  return callback();
                }
                const properties = JSON.parse(JSON.stringify(props));
                const pushSetReverseAction = (el: AnyObj) => {
                  const prop = properties[el.name];
                  if (prop) reverse.push((cb: Callback) => pm.setProperty(el.name, prop.value, prop.attributes, cb));
                  else reverse.push((cb: Callback) => pm.removeProperty(el.name, cb));
                };
                const pushRemoveReverseAction = (el: AnyObj) => {
                  const prop = properties[el.name];
                  reverse.push((cb: Callback) => pm.setProperty(el.name, prop.value, prop.attributes, cb));
                };

                // Fixed branch: DAV:-namespaced properties (e.g. lastmodified, used by
                // NextCloud's touch()) are stored like any other property instead of
                // being unconditionally rejected with 403.
                execute('DAV:set', 'setProperty', (el: AnyObj, cb: Callback) => {
                  pm.setProperty(el.name, el.elements, el.attributes, (e5: unknown) => {
                    if (!e5) pushSetReverseAction(el);
                    cb(e5);
                  });
                });
                execute('DAV:remove', 'removeProperty', (el: AnyObj, cb: Callback) => {
                  pm.removeProperty(el.name, (e5: unknown) => {
                    if (!e5) pushRemoveReverseAction(el);
                    cb(e5);
                  });
                });
              }, false);
            });
          });
        });
      }
      catch {
        ctx.setCode(HTTPCodes.BadRequest);
        callback();
      }
    });
  });
}

ProppatchModule.default.prototype.unchunked = patchedUnchunked;
