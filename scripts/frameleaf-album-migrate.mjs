#!/usr/bin/env node
// Convert separator-style album names ("Artists / Samuel H / Sequence") into
// Frameleaf's real hierarchy: each album gets its leaf name ("Sequence") and a
// parentId pointing at the album above it. Missing middle levels
// (e.g. "My Stuff / Toon / Kink") are created as albums.
//
// --convert-collections turns every collection into an ordinary album, so the
// whole library uses one kind of folder: albums, which can hold photos and
// sub-albums alike. (Frameleaf can't change an album's kind, so each collection
// is replaced: a same-named album is created in its place, or an existing empty
// same-named album inside it is reused, the children move over, and the empty
// collection is deleted.)
//
// --nest-with-collections is the opposite: every album that has sub-albums
// becomes a collection, and only the innermost folders stay albums. Collections
// can hold photos too, so a parent's photos are copied into its new collection
// (verified by count before anything is deleted). Folder paths don't change.
//
// Safe to re-run: albums already nested correctly are left alone.
//
// Usage (API key from Frameleaf > Account settings > API keys, needs album read/update/create):
//   FRAMELEAF_URL=http://host:2283 FRAMELEAF_API_KEY=... node scripts/frameleaf-album-migrate.mjs            # dry run
//   FRAMELEAF_URL=... FRAMELEAF_API_KEY=... node scripts/frameleaf-album-migrate.mjs --apply                 # do it
//   FRAMELEAF_URL=... FRAMELEAF_API_KEY=... node scripts/frameleaf-album-migrate.mjs --convert-collections [--apply]
//   FRAMELEAF_URL=... FRAMELEAF_API_KEY=... node scripts/frameleaf-album-migrate.mjs --nest-with-collections [--apply]
//   FRAMELEAF_URL=... FRAMELEAF_API_KEY=... node scripts/frameleaf-album-migrate.mjs --rollback <file.json>  # undo either
//   node scripts/frameleaf-album-migrate.mjs --albums-json albums.json                                       # offline dry run
//
// Options: --separator " / " (default), --out <dir> for the rollback file (default: cwd).

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback; };

const SEPARATOR = opt('--separator', ' / ');
const APPLY = flag('--apply');
const ROLLBACK = opt('--rollback');
const CONVERT = flag('--convert-collections');
const NEST = flag('--nest-with-collections');
const OFFLINE = opt('--albums-json');
const OUT_DIR = opt('--out', process.cwd());
const BASE = (process.env.FRAMELEAF_URL ?? '').replace(/\/+$/, '');
const KEY = process.env.FRAMELEAF_API_KEY ?? '';

async function api(method, endpoint, body)
{
    const res = await fetch(`${BASE}/api/${endpoint}`, {
        method,
        headers: { 'x-api-key': KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${endpoint} -> ${res.status}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

const split = (name) => name.split(SEPARATOR).map(s => s.trim()).filter(Boolean);
const keyOf = (segs) => segs.map(s => s.toLowerCase()).join('\u0000');
const show = (segs) => segs.join(' / ') || '(top level)';

/** Pure planning step: albums in, list of creates/updates out. */
function plan(albums)
{
    const byId = new Map(albums.map(a => [a.id, a]));

    // Intended full path of each album. A name that already repeats its
    // parent's path ("Artists / X" inside "Artists") is taken as-is; a leaf name
    // inside a parent ("X" inside "Artists") is appended to the parent's path.
    const pathCache = new Map();
    const pathOf = (album, depth = 0) =>
    {
        if (pathCache.has(album.id)) return pathCache.get(album.id);
        const segs = split(album.albumName);
        let result = segs;
        const parent = album.parentId ? byId.get(album.parentId) : undefined;
        if (parent && depth < 64)
        {
            const pp = pathOf(parent, depth + 1);
            const alreadyFull = pp.length <= segs.length && keyOf(segs.slice(0, pp.length)) === keyOf(pp);
            result = alreadyFull ? segs : [...pp, ...segs];
        }
        pathCache.set(album.id, result);
        return result;
    };

    // One owner per path. Collections win (they are what Frameleaf groups by);
    // otherwise the oldest album wins. Losers are left untouched and reported.
    const rank = (a) => (a.kind === 'collection' ? 0 : 1);
    const sorted = albums.slice().sort((a, b) => rank(a) - rank(b) || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
    const owner = new Map();
    const skipped = [];
    for (const album of sorted)
    {
        const segs = pathOf(album);
        if (segs.length === 0) { skipped.push({ album, reason: 'empty name' }); continue; }
        const k = keyOf(segs);
        if (owner.has(k)) { skipped.push({ album, reason: `same path as ${owner.get(k).kind ?? 'album'} "${owner.get(k).albumName}" (${owner.get(k).id})` }); continue; }
        owner.set(k, album);
    }

    // Collections to create for missing middle levels, shallowest first.
    const creates = [];
    const pending = new Map(); // key -> create entry
    for (const album of owner.values())
    {
        const segs = pathOf(album);
        for (let i = 1; i < segs.length; i++)
        {
            const prefix = segs.slice(0, i);
            const k = keyOf(prefix);
            if (owner.has(k) || pending.has(k)) continue;
            const entry = { tempId: `new:${creates.length}`, segs: prefix, name: prefix[prefix.length - 1], parentKey: i > 1 ? keyOf(prefix.slice(0, -1)) : null };
            pending.set(k, entry);
            creates.push(entry);
        }
    }
    creates.sort((a, b) => a.segs.length - b.segs.length);

    const idForKey = (k) => (k === null ? null : owner.get(k)?.id ?? pending.get(k)?.tempId ?? null);
    for (const c of creates) c.parentId = idForKey(c.parentKey);

    const updates = [];
    for (const album of owner.values())
    {
        const segs = pathOf(album);
        const name = segs[segs.length - 1];
        const parentId = idForKey(segs.length > 1 ? keyOf(segs.slice(0, -1)) : null);
        const change = {};
        if (album.albumName !== name) change.albumName = name;
        if ((album.parentId ?? null) !== parentId) change.parentId = parentId;
        if (Object.keys(change).length) updates.push({ album, segs, change });
    }
    updates.sort((a, b) => a.segs.length - b.segs.length || show(a.segs).localeCompare(show(b.segs)));
    return { creates, updates, skipped };
}

function printPlan({ creates, updates, skipped })
{
    console.log(`\nMiddle-level albums to create (${creates.length}):`);
    for (const c of creates) console.log(`  + ${show(c.segs)}`);
    console.log(`\nAlbums to update (${updates.length}):`);
    for (const u of updates)
    {
        const bits = [];
        if (u.change.albumName !== undefined) bits.push(`name "${u.album.albumName}" -> "${u.change.albumName}"`);
        if (u.change.parentId !== undefined) bits.push(`parent -> ${show(u.segs.slice(0, -1))}`);
        console.log(`  * ${show(u.segs)}: ${bits.join(', ')}`);
    }
    if (skipped.length)
    {
        console.log(`\nLeft alone (${skipped.length}):`);
        for (const s of skipped) console.log(`  - "${s.album.albumName}" (${s.album.kind ?? 'album'}, ${s.album.id}): ${s.reason}`);
    }
}

async function loadOwnAlbums(quiet = false)
{
    const me = await api('GET', 'users/me');
    const all = await api('GET', 'albums');
    const own = all.filter(a => (a.albumUsers?.[0]?.user?.id ?? a.ownerId ?? a.owner?.id) === me.id && a.kind !== 'space');
    if (!quiet) console.log(`Signed in as ${me.email}. ${own.length} of ${all.length} visible albums are yours.`);
    return own;
}

async function rollback(file)
{
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data.kind === 'convert-collections') return rollbackConversion(data);
    if (data.kind === 'nest-with-collections') return rollbackNesting(data);
    console.log(`Rolling back ${data.albums.length} albums and ${data.created.length} created collections from ${file}`);
    // Put everything back at its old parent/name first, then remove the
    // (now empty) collections the migration created.
    for (const a of data.albums)
    {
        await api('PATCH', `albums/${a.id}`, { albumName: a.albumName, parentId: a.parentId ?? null });
        console.log(`  restored "${a.albumName}"`);
    }
    for (const id of data.created.slice().reverse())
    {
        await api('DELETE', `albums/${id}`);
        console.log(`  deleted created album ${id}`);
    }
}

// ---- --convert-collections ------------------------------------------------

const isEmptyAlbum = (a) => a.kind !== 'collection' && (a.assetCount ?? 0) === 0;

function planConversion(albums)
{
    const collections = albums.filter(a => a.kind === 'collection');
    const childrenOf = (id) => albums.filter(a => a.parentId === id);
    return collections.map(c =>
    {
        const kids = childrenOf(c.id);
        const reuse = kids.find(k => isEmptyAlbum(k) && k.albumName.trim().toLowerCase() === c.albumName.trim().toLowerCase() && childrenOf(k.id).length === 0);
        return { collection: c, reuse, children: kids.filter(k => k !== reuse) };
    });
}

async function convertCollections()
{
    let albums = await loadOwnAlbums();
    const steps = planConversion(albums);
    console.log(`\nCollections to turn into albums (${steps.length}):`);
    for (const s of steps)
        console.log(`  ~ "${s.collection.albumName}" (${s.children.length} children)${s.reuse ? ` - reusing the empty album "${s.reuse.albumName}" already inside it` : ''}`);
    if (!APPLY) { console.log('\nDry run only. Re-run with --apply to make these changes.'); return; }
    if (steps.length === 0) { console.log('\nNothing to do.'); return; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rollbackFile = path.join(OUT_DIR, `frameleaf-collections-to-albums-rollback-${stamp}.json`);
    const record = { server: BASE, kind: 'convert-collections', conversions: [] };
    const save = () => fs.writeFileSync(rollbackFile, JSON.stringify(record, null, 2));
    save();
    console.log(`\nRollback file: ${rollbackFile}`);

    // One collection at a time, re-reading albums in between: converting a
    // parent moves child collections, so their current parent must be fresh.
    for (const { collection } of steps)
    {
        albums = await loadOwnAlbums(true);
        const c = albums.find(a => a.id === collection.id);
        if (!c) continue;
        const { reuse, children } = planConversion(albums).find(s => s.collection.id === c.id);

        const entry = { name: c.albumName, parentId: c.parentId ?? null, description: c.description ?? '', replacementId: null, reused: Boolean(reuse), childIds: children.map(k => k.id), deleted: false };
        record.conversions.push(entry);

        let replacementId;
        if (reuse)
        {
            await api('PATCH', `albums/${reuse.id}`, { parentId: c.parentId ?? null });
            replacementId = reuse.id;
        }
        else
        {
            const body = { albumName: c.albumName };
            if (c.parentId) body.parentId = c.parentId;
            if (c.description) body.description = c.description;
            replacementId = (await api('POST', 'albums', body)).id;
        }
        entry.replacementId = replacementId;
        save();

        for (const k of children) await api('PATCH', `albums/${k.id}`, { parentId: replacementId });
        await api('DELETE', `albums/${c.id}`);
        entry.deleted = true;
        save();
        console.log(`  ~ "${c.albumName}" is now an album (${children.length} children moved)`);
    }
    console.log(`\nDone. Undo with: --rollback ${rollbackFile}`);
}

// ---- --nest-with-collections ---------------------------------------------

/** Every asset id in an album, across the visibilities search can see. */
async function albumAssetIds(albumId)
{
    const ids = new Set();
    for (const visibility of ['timeline', 'archive', 'hidden'])
    {
        let page = 1;
        while (page)
        {
            const res = await api('POST', 'search/metadata', { albumIds: [albumId], visibility, size: 1000, page });
            for (const a of res?.assets?.items ?? []) ids.add(a.id);
            page = res?.assets?.nextPage ? Number(res.assets.nextPage) : null;
        }
    }
    return [...ids];
}

async function addAssets(albumId, ids)
{
    for (let i = 0; i < ids.length; i += 500)
        await api('PUT', `albums/${albumId}/assets`, { ids: ids.slice(i, i + 500) });
}

async function nestWithCollections()
{
    let albums = await loadOwnAlbums();
    const hasKids = (id, list) => list.some(a => a.parentId === id);
    const targets = albums.filter(a => a.kind !== 'collection' && hasKids(a.id, albums));

    console.log(`\nAlbums with sub-albums to turn into collections (${targets.length}):`);
    for (const a of targets)
    {
        const ids = await albumAssetIds(a.id);
        a._ids = ids;
        const ok = ids.length === (a.assetCount ?? 0);
        console.log(`  ~ "${a.albumName}": ${a.assetCount ?? 0} photos${ok ? '' : ` - SEARCH FOUND ${ids.length}, will be skipped`}`);
    }
    if (!APPLY) { console.log('\nDry run only. Re-run with --apply to make these changes.'); return; }
    if (targets.length === 0) { console.log('\nNothing to do.'); return; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rollbackFile = path.join(OUT_DIR, `frameleaf-nest-with-collections-rollback-${stamp}.json`);
    const record = { server: BASE, kind: 'nest-with-collections', conversions: [] };
    const save = () => fs.writeFileSync(rollbackFile, JSON.stringify(record, null, 2));
    save();
    console.log(`\nRollback file: ${rollbackFile}`);

    for (const target of targets)
    {
        // Fresh state each step: converting one album re-parents others.
        albums = await loadOwnAlbums(true);
        const a = albums.find(x => x.id === target.id);
        if (!a) continue;
        const detail = await api('GET', `albums/${a.id}?withoutAssets=true`);
        const ids = await albumAssetIds(a.id);
        if (ids.length !== (detail.assetCount ?? 0))
        {
            console.log(`  ! skipped "${a.albumName}": search found ${ids.length} of ${detail.assetCount} photos`);
            continue;
        }
        const children = albums.filter(x => x.parentId === a.id).map(x => x.id);
        const entry = { name: a.albumName, parentId: a.parentId ?? null, description: detail.description ?? '', cover: detail.albumThumbnailAssetId ?? null, assetIds: ids, childIds: children, collectionId: null, deleted: false };
        record.conversions.push(entry);
        save();

        const body = { albumName: a.albumName, kind: 'collection' };
        if (a.parentId) body.parentId = a.parentId;
        if (entry.description) body.description = entry.description;
        const collectionId = (await api('POST', 'albums', body)).id;
        entry.collectionId = collectionId;
        save();

        await addAssets(collectionId, ids);
        if (entry.cover && ids.includes(entry.cover)) await api('PATCH', `albums/${collectionId}`, { albumThumbnailAssetId: entry.cover });

        const check = await api('GET', `albums/${collectionId}?withoutAssets=true`);
        if ((check.assetCount ?? 0) !== ids.length)
        {
            console.log(`  ! stopped at "${a.albumName}": the new collection has ${check.assetCount} of ${ids.length} photos. The original album is untouched.`);
            break;
        }
        for (const id of children) await api('PATCH', `albums/${id}`, { parentId: collectionId });
        await api('DELETE', `albums/${a.id}`);
        entry.deleted = true;
        save();
        console.log(`  ~ "${a.albumName}" is now a collection (${ids.length} photos, ${children.length} sub-albums)`);
    }
    console.log(`\nDone. Undo with: --rollback ${rollbackFile}`);
}

async function rollbackNesting(data)
{
    for (const e of data.conversions.slice().reverse())
    {
        if (!e.collectionId) continue;
        if (!e.deleted) { await api('DELETE', `albums/${e.collectionId}`); console.log(`  removed unfinished collection "${e.name}"`); continue; }
        const current = await api('GET', `albums/${e.collectionId}?withoutAssets=true`);
        const body = { albumName: e.name };
        if (current.parentId) body.parentId = current.parentId;
        if (e.description) body.description = e.description;
        const albumId = (await api('POST', 'albums', body)).id;
        await addAssets(albumId, e.assetIds);
        if (e.cover) await api('PATCH', `albums/${albumId}`, { albumThumbnailAssetId: e.cover });
        // Move whatever is inside the collection now. Running newest-first means
        // children converted after this one have already been restored here.
        const kids = (await api('GET', 'albums')).filter(x => x.parentId === e.collectionId);
        for (const k of kids) await api('PATCH', `albums/${k.id}`, { parentId: albumId });
        await api('DELETE', `albums/${e.collectionId}`);
        console.log(`  restored album "${e.name}"`);
    }
}

async function rollbackConversion(data)
{
    // Newest first, so a nested collection is rebuilt after its parent is.
    for (const e of data.conversions.slice().reverse())
    {
        if (!e.replacementId) continue;
        const current = await api('GET', `albums/${e.replacementId}`);
        const body = { albumName: e.name, kind: 'collection' };
        if (current.parentId) body.parentId = current.parentId;
        const restored = (await api('POST', 'albums', body)).id;
        for (const id of e.childIds) await api('PATCH', `albums/${id}`, { parentId: restored });
        if (e.reused) await api('PATCH', `albums/${e.replacementId}`, { parentId: restored });
        else await api('DELETE', `albums/${e.replacementId}`);
        console.log(`  restored collection "${e.name}"`);
    }
}

async function main()
{
    if (ROLLBACK) { requireServer(); return rollback(ROLLBACK); }
    if (CONVERT) { requireServer(); return convertCollections(); }
    if (NEST) { requireServer(); return nestWithCollections(); }

    let albums;
    if (OFFLINE) albums = JSON.parse(fs.readFileSync(OFFLINE, 'utf8'));
    else { requireServer(); albums = await loadOwnAlbums(); }

    const p = plan(albums);
    printPlan(p);

    if (!APPLY || OFFLINE)
    {
        console.log(`\nDry run only. Re-run with --apply${OFFLINE ? ' against the server' : ''} to make these changes.`);
        return;
    }
    if (p.creates.length === 0 && p.updates.length === 0) { console.log('\nNothing to do.'); return; }

    // Rollback file first, updated as collections get created, so a failure
    // part-way through is still fully undoable.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rollbackFile = path.join(OUT_DIR, `frameleaf-album-migrate-rollback-${stamp}.json`);
    const record = { server: BASE, separator: SEPARATOR, albums: p.updates.map(u => ({ id: u.album.id, albumName: u.album.albumName, parentId: u.album.parentId ?? null })), created: [] };
    const save = () => fs.writeFileSync(rollbackFile, JSON.stringify(record, null, 2));
    save();
    console.log(`\nRollback file: ${rollbackFile}`);

    const realId = new Map();
    const resolve = (id) => (id && id.startsWith('new:') ? realId.get(id) : id);

    for (const c of p.creates)
    {
        const body = { albumName: c.name };
        const parentId = resolve(c.parentId);
        if (parentId) body.parentId = parentId;
        const created = await api('POST', 'albums', body);
        realId.set(c.tempId, created.id);
        record.created.push(created.id);
        save();
        console.log(`  + created album ${show(c.segs)}`);
    }
    let done = 0;
    for (const u of p.updates)
    {
        const body = { ...u.change };
        if ('parentId' in body) body.parentId = resolve(body.parentId) ?? null;
        await api('PATCH', `albums/${u.album.id}`, body);
        done++;
        console.log(`  * [${done}/${p.updates.length}] ${show(u.segs)}`);
    }
    console.log(`\nDone. Undo with: --rollback ${rollbackFile}`);
}

function requireServer()
{
    if (!BASE || !KEY) { console.error('Set FRAMELEAF_URL and FRAMELEAF_API_KEY.'); process.exit(2); }
}

main().catch(err => { console.error(`\nFailed: ${err.message}`); process.exit(1); });
