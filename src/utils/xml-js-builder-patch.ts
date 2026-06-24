// Runtime patch for xml-js-builder namespace bugs.
//
// Bug 1 — mutateNodeNS (parse phase, XMLElementUtil.js):
//   Namespace URI and local name are concatenated without a separator:
//   "http://owncloud.org/ns" + "permissions" → "http://owncloud.org/nspermissions"
//   Fix: insert '/' when URI doesn't already end with '/' or ':'
//
// Bug 2 — setFreeNamespaceName (serialize phase, unexported closure in XMLElementBuilder.js):
//   Appends a trailing ':' to HTTP namespace URIs in xmlns declarations:
//   xmlns:a="http://owncloud.org/ns:" (wrong) → should be xmlns:a="http://owncloud.org/ns"
//   Fix: post-process xmlns attribute values in XMLElementBuilder.prototype.add
//
// Patching live module exports rather than node_modules files means the fix
// survives `npm install`.

type NSMap = Record<string, string>;
type AnyNode = Record<string, unknown>;

function seekForNS(node: AnyNode, parentNS: NSMap): NSMap {
  if (!node.attributes) return parentNS;
  const ns: NSMap = { ...parentNS };
  const attrs = node.attributes as Record<string, string>;
  for (const name in attrs) {
    if (name.indexOf('xmlns:') === 0 || name === 'xmlns') {
      if (name === 'xmlns') ns['_default'] = attrs[name];
      else ns[name.substring('xmlns:'.length)] = attrs[name];
    }
  }
  return ns;
}

function patchedMutateNodeNS(node: AnyNode, parentNS: NSMap = {}): unknown {
  if (!node) return undefined;
  if (node['find']) return node;

  const nss = seekForNS(node, parentNS);
  if (node.name) {
    for (const ns in nss) {
      if (ns === '_default' && (node.name as string).indexOf(':') === -1) {
        node.name = nss[ns] + node.name;
        break;
      } else if ((node.name as string).indexOf(ns + ':') === 0) {
        const nsUri = nss[ns];
        const localName = (node.name as string).substring((ns + ':').length);
        // Insert separator when URI doesn't already end with '/' or ':'
        const sep = (nsUri.endsWith('/') || nsUri.endsWith(':')) ? '' : '/';
        node.name = nsUri + sep + localName;
        break;
      }
    }
  }

  const elements: unknown[] = (node.elements as unknown[]) ?? [];
  node['findIndex'] = (name: string): number => {
    for (let i = 0; i < elements.length; ++i)
      if ((elements[i] as AnyNode)?.name === name) return i;
    return -1;
  };
  node['find'] = (name: string): unknown => {
    for (const e of elements)
      if ((e as AnyNode)?.name === name) return e;
    throw new Error('Cannot find the XML element : ' + name);
  };
  node['findMany'] = (name: string): unknown[] =>
    elements.filter(e => (e as AnyNode)?.name === name);
  node['findText'] = (): string => {
    for (const e of elements)
      if ((e as AnyNode)?.type === 'text') return (e as AnyNode).text as string;
    return '';
  };
  node['findTexts'] = (): string[] =>
    elements.filter(e => (e as AnyNode)?.type === 'text').map(e => (e as AnyNode).text as string);

  if (node.elements)
    (node.elements as AnyNode[]).forEach(n => patchedMutateNodeNS(n, nss));
  else
    node.elements = [];

  return node;
}

// ── Fix 1: parse phase ──────────────────────────────────────────────────────
// XML.js captures the XMLElementUtil exports object by reference, so
// replacing mutateNodeNS here affects all subsequent XML.parseXML calls.
const xmlUtil = require('xml-js-builder/lib/XMLElementUtil') as { mutateNodeNS: unknown };
xmlUtil.mutateNodeNS = patchedMutateNodeNS;

// ── Fix 2: serialize phase ──────────────────────────────────────────────────
// setFreeNamespaceName is an unexported closure, so we can't replace it.
// Instead we wrap XMLElementBuilder.prototype.add to strip the trailing ':'
// that the function incorrectly appends to HTTP namespace URIs.
const { XMLElementBuilder } = require('xml-js-builder/lib/XMLElementBuilder') as {
  XMLElementBuilder: { prototype: { add(el: unknown): unknown } };
};
const origAdd = XMLElementBuilder.prototype.add;
XMLElementBuilder.prototype.add = function (element: unknown): unknown {
  const result = origAdd.call(this, element);
  function fixXmlns(el: unknown): void {
    if (!el || (el as AnyNode).type !== 'element') return;
    const node = el as AnyNode;
    if (node.attributes) {
      const attrs = node.attributes as Record<string, string>;
      for (const key of Object.keys(attrs)) {
        if (key.startsWith('xmlns:') && typeof attrs[key] === 'string') {
          const val = attrs[key];
          // Strip trailing ':' that setFreeNamespaceName incorrectly adds to HTTP URIs
          if (/^https?:\/\//.test(val) && val.endsWith(':'))
            attrs[key] = val.slice(0, -1);
        }
      }
    }
    if (node.elements) (node.elements as unknown[]).forEach(fixXmlns);
  }
  if (result) fixXmlns(result);
  return result;
};
