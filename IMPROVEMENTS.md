# Improvement Log

Identified issues and implementation notes. Grouped by category.

---

## Actual Bugs

### 1. FTP passive ports never assigned
**File:** `src/config.ts:71-72`

Lines 71-72 just read the class properties as expressions — they never assign the local
constructor variables to `this`.

```typescript
// Current (broken)
this.ftpPassivePortMin;
this.ftpPassivePortMax;

// Fix
this.ftpPassivePortMin = ftpPassivePortMin ?? undefined;
this.ftpPassivePortMax = ftpPassivePortMax ?? undefined;
```

---

### 2. `FETCH_AssetsForTag` fetches archive visibility twice
**File:** `src/immich/immich-api.ts:331-333`

The first call uses `"archive"` when it should be `"timeline"`. Timeline-visible assets
in tagged folders are completely missing from results.

```typescript
// Current (broken)
const normal_items   = await this.FETCH_AssetsByMetadata({ tagIds: [tag.id], visibility: "archive" })
const archived_items = await this.FETCH_AssetsByMetadata({ tagIds: [tag.id], visibility: "archive" })

// Fix
const normal_items   = await this.FETCH_AssetsByMetadata({ tagIds: [tag.id], visibility: "timeline" })
const archived_items = await this.FETCH_AssetsByMetadata({ tagIds: [tag.id], visibility: "archive" })
```

---

### 3. `mapTagFromApi` maps wrong fields for `color` and `createdAt`
**File:** `src/immich/utils/immich-api-utils.ts:465-466`

`color` is assigned `tag.parentId` instead of `tag.color`. The `createdAt` guard checks
`typeof tag.updatedAt` instead of `typeof tag.createdAt`.

```typescript
// Current (broken)
color:     tag.color && typeof tag.color === 'string' ? tag.parentId : undefined,
createdAt: typeof tag.updatedAt === 'string' ? tag.createdAt : undefined,

// Fix
color:     tag.color && typeof tag.color === 'string' ? tag.color : undefined,
createdAt: typeof tag.createdAt === 'string' ? tag.createdAt : undefined,
```

---

### 4. `get_album_path()` type cast never differentiates parent types
**File:** `src/immich/collections/immich-album-folder.ts:52-59`

TypeScript casts do not affect runtime values. `(this.parent as ImmichAlbumsDirectory) !== undefined`
is always `true` because `this.parent` is `VirtualNode | null`, never `undefined`. The
`else if` branch is unreachable, so sub-album rename always returns only the leaf segment,
breaking multi-level album renames entirely.

```typescript
// Current (broken)
if ((this.parent as ImmichAlbumsDirectory) !== undefined)         // always true
    return [this.get_album_realname()]
else if ((this.parent as ImmichAlbumFolder) !== undefined)        // unreachable
    return [...(this.parent as ImmichAlbumFolder).get_album_path(), this.get_album_realname()]

// Fix — use instanceof for runtime type discrimination
if (this.parent instanceof ImmichAlbumFolder)
    return [...this.parent.get_album_path(), this.get_album_realname()]
else
    return [this.get_album_realname()]
```

---

### 5. `ImmichWritableMemory.rename()` has unreachable dead code
**File:** `src/immich/immich-writable-memory.ts:159-165`

An unconditional `throw` on line 159 makes the `if (!entry)` block immediately below it
unreachable. Remove the dead block.

```typescript
// Current
const entry = this.find(oldName);
if (!entry) throw new Error('File not found');

if (!entry)   // unreachable
{
    logger.error(...)
    return false;
}

// Fix — remove the dead block entirely
const entry = this.find(oldName);
if (!entry) throw new Error('File not found');
```

---

## Performance Issues

### 6. No axios timeout on any API call
**File:** `src/immich/immich-api.ts:176`

All `axios.request()` calls have no `timeout` option. A slow or hung Immich server will
block a request indefinitely. Because no abort signal is propagated when an SFTP client
disconnects, in-flight requests keep running after the connection drops.

```typescript
// Fix — add a configurable timeout to callApi
const response = await axios.request({
    method,
    url: `${this.baseUrl}/api/${endpoint}`,
    timeout: 30_000,   // 30 s; expose via config if needed
    ...
});
```

A sensible approach is to read the timeout from an env var (e.g. `API_TIMEOUT_MS`,
defaulting to `30000`) so it can be tuned for slow self-hosted instances.

---

### 7. Arbitrary 200 ms delay on every cache miss
**File:** `src/filesystem/virtual-directory.ts:53`

```typescript
await new Promise(resolve => setTimeout(resolve, this.getRefreshDelay()));
```

This fires unconditionally before every `event_rebuild()` call, adding 200 ms of latency
to every cold listing. It appears intended as a debounce but has no effect as one — it
does not coalesce concurrent callers. Remove it, or replace with a proper in-flight
deduplication guard (see note below).

**Proper fix** — deduplicate concurrent rebuilds with a shared promise:

```typescript
private _rebuildPromise: Promise<Map<string, VirtualNode>> | null = null;

async nodes_map(refresh?: boolean): Promise<Map<string, VirtualNode>>
{
    if (this._child_nodes !== null && !this._force_child_node_refresh && !this.needsRefresh() && !refresh)
        return this._child_nodes;

    if (!this._rebuildPromise)
    {
        this._rebuildPromise = this.event_rebuild().then(result =>
        {
            this._child_nodes = result;
            this._force_child_node_refresh = false;
            this._rebuildPromise = null;
            return result;
        });
    }

    return this._rebuildPromise;
}
```

This ensures concurrent READDIR requests for the same directory share a single Immich API
call rather than each waiting 200 ms and then each triggering their own rebuild.

---

### 8. `ImmichAlbumFolder.event_rebuild()` re-fetches all albums to get one branch
**File:** `src/immich/collections/immich-album-folder.ts:125`

`FETCH_VirtualAlbumBranch` internally calls `FETCH_Albums()` (two API requests — own and
shared albums), builds the full virtual tree, then discards everything except the one
matching node. For large libraries this is expensive just to refresh a single folder.

**Options:**
- Cache the full album tree at the `ImmichFileSystem` level with a short TTL and share it
  across all album folders. Each folder then queries the shared cache rather than triggering
  independent fetches.
- Alternatively, expose a direct `GET /api/albums/{id}` call and use that to refresh only
  the album this folder is bound to, bypassing the full tree rebuild.

---

## Side-Effect Bug

### 9. `ImmichWritableMemory.stat()` triggers the actual upload
**File:** `src/immich/immich-writable-memory.ts:139-144`

```typescript
async stat(filename: string) {
    if (entry.type === "queue") {
        await this.immich_fs.getApi().QUEUE_UploadFile(...)  // upload happens here
```

`stat()` is a read operation by contract. Any client that stats a file mid-transfer (common)
will prematurely trigger the upload. If called more than once before the queue entry is
removed, it will attempt to upload the same tmp file twice.

**Fix** — separate the "trigger upload" responsibility from stat. Move the upload trigger
to `ImmichFileSystem.writeFile()` or a dedicated finalize step that fires once on SFTP
`CLOSE`. `stat()` should return metadata only, reading the tmp file size from disk if
needed.

---

## Code Duplication

### 10. Four near-identical asset collector functions
**File:** `src/immich/utils/immich-api-utils.ts:109-291`

`collectAlbumAssets`, `collectUnsortedAssets`, `collectTrashedAssets`, and
`collectTaggedAssets` copy the same ~40-line filename deduplication block verbatim. Any
fix to that logic (see issue 11) must currently be applied four times.

**Fix** — extract a shared helper:

```typescript
function buildAssetFiles(
    assets: ImmichAsset[],
    parent: ImmichVirtualDirectory,
    reserved_names: Set<string>
): ImmichVirtualAssetFile[]
{
    // single dedup implementation here
}

// Each collector then calls:
return buildAssetFiles(assets, source_folder, reserved_names);
```

---

### 11. Asset filename dedup loop only checks `reserved_names`, not already-used names
**File:** `src/immich/utils/immich-api-utils.ts` (all four collectors)

```typescript
do { count++; finalName = `${base} (${count})`; }
while (reserved_names.has(finalName));   // never checks nameCount
```

If two assets share a base name and none of the generated suffixed names appear in
`reserved_names`, the loop exits immediately and does not verify the suffixed name is
unique among assets. A third asset with `originalFileName = "photo (2)"` will collide with
the one generated for the second `"photo"` asset.

**Fix** — check both `reserved_names` and a set of already-emitted names:

```typescript
const usedNames = new Set<string>();

// inside the loop, after determining finalName:
while (reserved_names.has(finalName) || usedNames.has(finalName)) {
    count++;
    finalName = `${base} (${count})`;
}
usedNames.add(finalName);
```

---

### 12. `SFTP_STAT` and `SFTP_LSTAT` are near-identical
**File:** `src/protocols/sftp-server.ts:395-541`

Both handlers share the same root short-circuit, `fsBackend.stat()` call, and response
formatting. STAT vs LSTAT only differ in symlink-following semantics, which is irrelevant
here since there are no symlinks.

**Fix** — extract a shared handler:

```typescript
async function SFTP_StatCommon(self: SftpConnectionInstance, reqid: number, filePath: string, label: string)
{
    // shared implementation
}

async function SFTP_STAT(self, reqid, filePath) { await SFTP_StatCommon(self, reqid, filePath, 'STAT'); }
async function SFTP_LSTAT(self, reqid, filePath) { await SFTP_StatCommon(self, reqid, filePath, 'LSTAT'); }
```

---

## Design Observations

### 13. No cache TTL or expiry
**File:** `src/filesystem/virtual-directory.ts`

`_child_nodes` is invalidated only when `refresh()` is called after a mutation, or when
`needsRefresh()` returns true (which always returns `false`). Albums or assets added or
removed in Immich externally will never appear in an ongoing SFTP session unless the client
itself triggers a mutation.

**Options:**
- Override `needsRefresh()` in the Immich collection classes to return `true` after a
  configurable TTL (e.g. 60 seconds).
- Expose a TTL env var (`CACHE_TTL_SECONDS`) and check `Date.now() - lastBuiltAt > ttl`
  inside `needsRefresh()`.

---

### 14. No tmp file cleanup on upload failure
**File:** `src/immich/immich-writable-memory.ts`, `src/immich/immich-api.ts:502`

If `QUEUE_UploadFile` throws, the `ImmichUploadQueueItem` holding the `tmp.FileResult`
remains in the queue in a partially-processed state and the tmp file is never deleted,
leaking disk space for the lifetime of the process.

**Fix** — wrap the upload in a try/finally:

```typescript
try {
    await this.QUEUE_UploadFile(entry, mtime);
} finally {
    entry.tmpFile.removeCallback();   // always clean up
    this.QUEUE_Splice(index, 1);      // always remove from queue
}
```

Ensure the splice index is captured before the async upload so it is still valid if the
queue is modified concurrently.
