import fs from 'fs';
import path from 'path';
import { config, UserConfig } from '../config';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { logger } from "../logger";
import { AssetDownloadSource } from '../utils/config-utils';
import { DateUtils } from "../utils/date-utils";
import { ImmichAssetFileType } from "./files/immich-asset-file";
import { ImmichAPI } from './immich-api';
import { ImmichAlbumDirectoryInfo, ImmichAlbumsDirectoryNode, ImmichAsset, ImmichTag, ImmichUser } from "./utils/immich-api-utils";
import { buildAssetMetadataXMP } from './utils/immich-metadata-utils';

const ASSET_CACHE_DIR = '/config/cache';
const SAVE_DEBOUNCE_MS = 5_000;
// Upper bound on how long a debounced save can keep being deferred by continuing
// activity.
const SAVE_MAX_DELAY_MS = 60_000;
// How long a cache entry is trusted without re-validating against the Immich API.
// Within this window all callers return cached data with zero network I/O.
// After the window expires ONE request re-validates (others wait on the in-flight
// dedup map); subsequent callers within the new window skip validation again.
const VALIDATION_TTL_MS = 30_000;

export interface ImmichCachedEntry<T>
{
    data: T;
    updatedAt: string;
    checksum?: string;
    // Epoch-ms timestamp of the last successful validation against the Immich API.
    // undefined = never validated this session (always validate on first access).
    lastValidatedAt?: number;
}

export interface ImmichCacheInvalidationOptions
{
    assetIds?: string[];
    albumIds?: string[];
    directoryPaths?: string[];
    invalidateAllDirectories?: boolean;
}

export interface ImmichAssetCacheFetchArgs
{
    fetchMeta?: () => Promise<{ updatedAt?: string; checksum?: string }>;
    fetchData: () => Promise<ImmichAsset[]>;
    // Called per-connection to produce fresh file nodes bound to the caller's
    // file system. The raw ImmichAsset[] are shared/cached across connections;
    // the VirtualFile wrappers are rebuilt each time so they never embed a
    // stale connection reference.
    buildFiles: (assets: ImmichAsset[], settings: UserConfig) => ImmichAssetFileType[];
}

export interface ImmichTreeCacheFetchArgs
{
    fetchMeta?: () => Promise<{ updatedAt?: string; checksum?: string }>;
    fetchData: () => Promise<ImmichAlbumsDirectoryNode | undefined>;
}

export class ImmichAssetFileSizeCache
{
    original: Map<string, number>
    preview: Map<string, number>

    constructor()
    {
        this.original = new Map()
        this.preview = new Map()
    }

    get(id: string, mode: AssetDownloadSource)
    {
        return mode == 'preview' ? this.preview.get(id) : this.original.get(id)
    }

    set(id: string, value: number, mode: AssetDownloadSource)
    {
        mode == 'preview' ? this.preview.set(id, value) : this.original.set(id, value)
    }

    delete(id: string)
    {
        this.original.delete(id);
        this.preview.delete(id);
    }

    clear()
    {

        this.original.clear();
        this.preview.clear();
    }
}

export class ImmichSessionCache
{
    // Stores raw asset byte data. Unlike ImmichAPI.sharedBufferCache, this map is
    // per-(user,view) and lives for the process lifetime — it is NOT released by the
    // WebDAV session idle-timeout while the session stays active, so it needs its own
    // real byte budget + LRU eviction (see setAssetBuffer below) rather than relying on
    // eventual session eviction to bound it.
    assetFileBuffers: Map<string, VirtualContentBuffer>;
    // The amount of bytes in the asset file buffer
    private assetFileBuffersBytes = 0;
    // Store asset file sizes
    assetFileSizeCache: ImmichAssetFileSizeCache;
    // Stores raw asset data — no connection-specific references.
    assetInfoCache: Map<string, ImmichCachedEntry<ImmichAsset>>;
    // Stores ordered asset ID lists per directory/album key; full data resolved via assetInfoCache.
    assetListCache: Map<string, ImmichCachedEntry<string[]>>;
    // Stores the album directory path by raw album id key;
    albumsPathCache: Map<string, string>
    // Stores album tree data per directory/path key
    albumsTreeCache: Map<string, ImmichCachedEntry<ImmichAlbumsDirectoryNode | undefined>>;
    // Stores rendered XMP sidecar strings keyed by asset ID, valid while updatedAt matches.
    // True LRU (re-inserted on every hit) so a large directory scan cannot evict the
    // entries it is actively re-reading, and persisted to disk so a restart does not
    // re-render the whole library.
    private xmpCache: Map<string, { xmp: string; updatedAt: string }> = new Map();
    private static readonly XMP_CACHE_CAP = config.OPTION_XMP_CACHE_CAP;
    private static readonly XMP_PERSIST_CAP = Math.min(config.OPTION_XMP_CACHE_CAP, 5_000);

    // assetId → tags, resolved in bulk from the tag side rather than per asset.
    // Only built when the Immich server won't return tags with search/metadata.
    private tagIndexCache: Map<string, ImmichTag[]> | null = null;
    private tagIndexBuiltAt = 0;
    private inFlightTagIndexBuild: Promise<Map<string, ImmichTag[]>> | null = null;
    private static readonly TAG_INDEX_TTL_MS = 300_000;

    private tagListCache: ImmichTag[] | null = null;
    private tagListCachedAt = 0;
    private inFlightTagListFetch: Promise<ImmichTag[]> | null = null;

    // Assets known to have no sidecar file in the mounted Immich library
    // (local-files mode only) → epoch-ms at which to re-check.
    private localSidecarMissing: Map<string, number> = new Map();
    private static readonly LOCAL_SIDECAR_MISS_TTL_MS = 300_000;
    private static readonly LOCAL_SIDECAR_MISS_CAP = 50_000;

    // Assets whose tags were just mutated locally — the next sidecar read must go
    // to the API rather than trusting the (now stale) bulk tag index.
    private forceAssetRefetch: Set<string> = new Set();

    // Raw album list cache — the result of GET /api/albums, shared across all
    // connections for the same user.  All FETCH_AlbumVirtualBranch calls derive
    // their tree/branch from this list; caching it here means the full album list
    // is fetched at most once per VALIDATION_TTL_MS, regardless of how many
    // individual album folders are opened.
    private albumsRawListCache: ImmichAlbumDirectoryInfo[] | null = null;
    private albumsRawListCachedAt = 0;
    private inFlightAlbumsListFetch: Promise<ImmichAlbumDirectoryInfo[]> | null = null;
    private _lastPrefetchAt = 0;

    // Deduplication maps: when multiple connections request the same directory
    // simultaneously (e.g. Dolphin thumbnail workers), they all share one in-flight
    // fetch rather than each issuing their own redundant API calls.
    private inFlightAssetFetches: Map<string, Promise<ImmichAsset>> = new Map();
    private inFlightAssetListFetches: Map<string, Promise<string[]>> = new Map();
    private inFlightAlbumTreeFetches: Map<string, Promise<ImmichAlbumsDirectoryNode | undefined>> = new Map();

    private static _instances: Map<string, ImmichSessionCache> = new Map();

    private _userId: string | null = null;
    private _viewId: string = "";
    private _saveTimer: ReturnType<typeof setTimeout> | null = null;
    private _firstDirtyAt = 0;

    constructor()
    {
        this.assetListCache = new Map()
        this.assetInfoCache = new Map()
        this.assetFileSizeCache = new ImmichAssetFileSizeCache()
        this.assetFileBuffers = new Map()

        this.albumsPathCache = new Map()
        this.albumsTreeCache = new Map()
    }

    public static Instance(user: ImmichUser | null, view: string | null): ImmichSessionCache
    {
        if (!user) return new ImmichSessionCache();
        let view_str = view === null ? "" : view
        let instance_id = `${user.id}${view_str}`;

        let instance = this._instances.get(instance_id);
        if (!instance)
        {
            instance = new ImmichSessionCache();
            instance._userId = user.id;
            instance._viewId = view_str
            instance.load();
            this._instances.set(instance_id, instance);
        }
        return instance;
    }

    private filepath(): string
    {
        return path.join(ASSET_CACHE_DIR, `${this._userId}${this._viewId}-assets.json`);
    }
    private load(): void
    {
        const filePath = this.filepath();
        try
        {
            if (!fs.existsSync(filePath)) return;
            const raw = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(raw);

            if (parsed && typeof parsed === 'object' && (parsed as any).v === 2)
            {
                // Versioned format: assets + album lists + albumPaths
                const envelope = parsed as {
                    v: number;
                    assets: Record<string, ImmichCachedEntry<ImmichAsset>>;
                    lists: Record<string, { data: string[]; updatedAt: string }>;
                    albumPaths: Record<string, string>;
                    fileSizes?: { preview?: Record<string, number>; original?: Record<string, number> };
                    xmp?: Record<string, { xmp: string; updatedAt: string }>;
                };
                let assetCount = 0;
                for (const [k, v] of Object.entries(envelope.assets ?? {}))
                {
                    if (k && v?.data && v?.updatedAt)
                    {
                        this.assetInfoCache.set(k, v);
                        assetCount++;
                    }
                }
                let listCount = 0;
                for (const [k, v] of Object.entries(envelope.lists ?? {}))
                {
                    if (k && Array.isArray(v?.data) && v?.updatedAt)
                    {
                        // Omit lastValidatedAt on restore — always re-validate against API on first access after restart.
                        this.assetListCache.set(k, { data: v.data, updatedAt: v.updatedAt });
                        listCount++;
                    }
                }
                for (const [k, v] of Object.entries(envelope.albumPaths ?? {}))
                {
                    if (k && typeof v === 'string') this.albumsPathCache.set(k, v);
                }
                for (const [k, v] of Object.entries(envelope.fileSizes?.preview ?? {}))
                {
                    if (k && typeof v === 'number') this.assetFileSizeCache.set(k, v, 'preview');
                }
                for (const [k, v] of Object.entries(envelope.fileSizes?.original ?? {}))
                {
                    if (k && typeof v === 'number') this.assetFileSizeCache.set(k, v, 'original');
                }
                // Rendered sidecars are validated against the asset's updatedAt on
                // read, so restoring them is safe and saves re-rendering the whole
                // library after a restart.
                let xmpCount = 0;
                for (const [k, v] of Object.entries(envelope.xmp ?? {}))
                {
                    if (xmpCount >= ImmichSessionCache.XMP_CACHE_CAP) break;
                    if (k && typeof v?.xmp === 'string' && typeof v?.updatedAt === 'string')
                    {
                        this.xmpCache.set(k, v);
                        xmpCount++;
                    }
                }
                logger.info('ImmichSessionCache', 'LOAD', `Restored ${assetCount} assets, ${listCount} album lists, ${xmpCount} sidecars from disk`);
            }
            else
            {
                // Legacy format: flat map of asset info entries only
                const assetData = parsed as Record<string, ImmichCachedEntry<ImmichAsset>>;
                let count = 0;
                for (const [k, v] of Object.entries(assetData))
                {
                    if (k && v?.data && v?.updatedAt)
                    {
                        this.assetInfoCache.set(k, v);
                        count++;
                    }
                }
                logger.info('ImmichSessionCache', 'LOAD', `Restored ${count} asset entries from disk (legacy format)`);
            }
        }
        catch (err)
        {
            logger.warn('ImmichSessionCache', 'LOAD', `Failed to restore cache from disk: ${err}`);
        }
    }
    private async save(): Promise<void>
    {
        if (!this._userId) return;
        const filePath = this.filepath();
        try
        {
            fs.mkdirSync(ASSET_CACHE_DIR, { recursive: true });

            // Strip lastValidatedAt from list entries — it's a session-only TTL gate
            // that must always expire on first access after a restart.
            const lists: Record<string, { data: string[]; updatedAt: string }> = {};
            for (const [k, v] of this.assetListCache)
                lists[k] = { data: v.data, updatedAt: v.updatedAt };

            const envelope = {
                v: 2,
                assets: Object.fromEntries(this.assetInfoCache),
                lists,
                albumPaths: Object.fromEntries(this.albumsPathCache),
                fileSizes: {
                    preview: Object.fromEntries(this.assetFileSizeCache.preview),
                    original: Object.fromEntries(this.assetFileSizeCache.original),
                },
                // Only the most-recently-used tail is persisted.  The in-memory cap
                // can be tens of thousands of documents; serialising all of them
                // would turn every flush into a multi-second blocking stringify.
                xmp: Object.fromEntries(
                    [...this.xmpCache].slice(-ImmichSessionCache.XMP_PERSIST_CAP)
                ),
            };
            // Use the async variant so the event loop is not blocked while writing
            // large cache files (can be several MB on a big library).
            await fs.promises.writeFile(filePath, JSON.stringify(envelope), 'utf8');
        }
        catch (err)
        {
            logger.warn('ImmichSessionCache', 'SAVE', `Failed to persist cache to disk: ${err}`);
        }
    }
    private scheduleSave(): void
    {
        if (!this._userId) return;

        // Debouncing alone means a mount under sustained load never reaches a quiet
        // 5 s window and so never persists at all — exactly the case where losing
        // the cache to a restart hurts most.  Cap how long a pending save can be
        // pushed back.
        const now = Date.now();
        if (this._firstDirtyAt === 0) this._firstDirtyAt = now;
        if ((now - this._firstDirtyAt) >= SAVE_MAX_DELAY_MS)
        {
            this.flushSave();
            return;
        }

        if (this._saveTimer !== null) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
    }

    private flushSave(): void
    {
        if (this._saveTimer !== null) { clearTimeout(this._saveTimer); this._saveTimer = null; }
        this._firstDirtyAt = 0;
        this.save().catch(err =>
            logger.warn('ImmichSessionCache', 'SAVE', `Async save failed: ${err}`)
        );
    }

    /**
     * Cache + deduplicate GET /api/albums calls.
     *
     * Every FETCH_AlbumVirtualBranch call needs the full album list to find its
     * branch.  Without this cache, navigating to N album folders triggers N ×
     * GET /api/albums.  With this cache the list is fetched at most once per
     * VALIDATION_TTL_MS, shared across all connections for the same user.
     */
    public async fetchCachedAlbumsList(fetchData: () => Promise<ImmichAlbumDirectoryInfo[]>): Promise<ImmichAlbumDirectoryInfo[]>
    {
        // TTL fast-path — serve from RAM if the list is still fresh.
        if (this.albumsRawListCache !== null &&
            (Date.now() - this.albumsRawListCachedAt) < VALIDATION_TTL_MS)
            return this.albumsRawListCache;

        // In-flight dedup — when multiple connections call FETCH_Albums concurrently,
        // share a single HTTP request rather than issuing one per connection.
        if (!this.inFlightAlbumsListFetch)
        {
            this.inFlightAlbumsListFetch = fetchData()
                .then(data =>
                {
                    this.albumsRawListCache = data;
                    this.albumsRawListCachedAt = Date.now();
                    return data;
                })
                .finally(() => { this.inFlightAlbumsListFetch = null; });
        }
        return this.inFlightAlbumsListFetch;
    }
    /**
     * TTL-cached + deduplicated tag index.  A cold directory of N sidecars calls
     * this N times in parallel; all of them share one build.
     */
    public async fetchCachedTagIndex(build: () => Promise<Map<string, ImmichTag[]>>): Promise<Map<string, ImmichTag[]>>
    {
        if (this.tagIndexCache !== null &&
            (Date.now() - this.tagIndexBuiltAt) < ImmichSessionCache.TAG_INDEX_TTL_MS)
            return this.tagIndexCache;

        if (!this.inFlightTagIndexBuild)
        {
            this.inFlightTagIndexBuild = build()
                .then(index =>
                {
                    this.tagIndexCache = index;
                    this.tagIndexBuiltAt = Date.now();
                    return index;
                })
                .finally(() => { this.inFlightTagIndexBuild = null; });
        }
        return this.inFlightTagIndexBuild;
    }

    /** TTL-cached GET /api/tags — the tag list changes far less often than it is read. */
    public async fetchCachedTagList(fetchData: () => Promise<ImmichTag[]>): Promise<ImmichTag[]>
    {
        if (this.tagListCache !== null && (Date.now() - this.tagListCachedAt) < VALIDATION_TTL_MS)
            return this.tagListCache;

        if (!this.inFlightTagListFetch)
        {
            this.inFlightTagListFetch = fetchData()
                .then(tags =>
                {
                    this.tagListCache = tags;
                    this.tagListCachedAt = Date.now();
                    return tags;
                })
                .finally(() => { this.inFlightTagListFetch = null; });
        }
        return this.inFlightTagListFetch;
    }

    public invalidateTagIndex(): void
    {
        this.tagIndexCache = null;
        this.tagIndexBuiltAt = 0;
        this.tagListCache = null;
        this.tagListCachedAt = 0;
    }

    /**
     * Write resolved tags back onto the cached asset so they survive into the
     * persisted cache and are carried forward by _storeAssetsAndGetIds when the
     * album list is next refreshed.
     */
    public updateAssetTags(assetId: string, tags: ImmichTag[]): void
    {
        const cached = this.assetInfoCache.get(assetId);
        if (!cached) return;
        this.assetInfoCache.set(assetId, { ...cached, data: { ...cached.data, tags } });
        this.scheduleSave();
    }

    public async fetchCachedAsset(assetId: string, { fetchMeta, fetchData }: { fetchMeta?: () => Promise<{ updatedAt?: string }>; fetchData: () => Promise<ImmichAsset> }): Promise<ImmichAsset>
    {
        const inflight = this.inFlightAssetFetches.get(assetId);
        if (inflight) return inflight;

        const promise = (async () =>
        {
            const cached = this.assetInfoCache.get(assetId);

            if (cached && !fetchMeta) return cached.data;

            if (fetchMeta)
            {
                let freshMeta: { updatedAt?: string } | undefined;
                try { freshMeta = await fetchMeta(); } catch (_) { }

                if (cached && freshMeta?.updatedAt && freshMeta.updatedAt === cached.updatedAt)
                    return cached.data;

                const data = await fetchData();
                const updatedAt = freshMeta?.updatedAt ?? data.updatedAt ?? DateUtils.getTimeStringNowISO();
                this.assetInfoCache.set(assetId, { data, updatedAt });
                this.scheduleSave();
                return data;
            }

            const data = await fetchData();
            this.assetInfoCache.set(assetId, { data, updatedAt: data.updatedAt ?? DateUtils.getTimeStringNowISO() });
            this.scheduleSave();
            return data;
        })();

        this.inFlightAssetFetches.set(assetId, promise);
        promise.finally(() => this.inFlightAssetFetches.delete(assetId)).catch(() => { });
        return promise;
    }
    public async fetchCachedAssetLists(cacheKey: string, { fetchMeta, fetchData, buildFiles }: ImmichAssetCacheFetchArgs, settings: UserConfig): Promise<ImmichAssetFileType[]>
    {
        const _storeAssetsAndGetIds = (assets: ImmichAsset[], listUpdatedAt: string): string[] =>
        {
            const ids: string[] = [];
            for (const asset of assets)
            {
                // search/metadata may omit tags.  If we already resolved them for
                // this exact revision of the asset, carry them forward instead of
                // dropping back to undefined — otherwise every album refresh would
                // re-trigger tag resolution for the whole library.
                const previous = this.assetInfoCache.get(asset.id);
                const data = (asset.tags === undefined && previous?.data.tags !== undefined && previous.updatedAt === asset.updatedAt)
                    ? { ...asset, tags: previous.data.tags }
                    : asset;

                this.assetInfoCache.set(asset.id, { data, updatedAt: asset.updatedAt ?? listUpdatedAt });
                ids.push(asset.id);
            }
            this.scheduleSave();
            return ids;
        };

        // ── Validation TTL fast-path ────────────────────────────────────────────
        // fetchMeta always issues an API call (e.g. GET /api/albums/{id}) to check
        // whether the cache is stale.  With rclone or Dolphin, the same directory
        // is opened by 5–10 connections in quick succession; each one would fire its
        // own API request and receive a cache-hit response it already had.
        //
        // Once any request has confirmed the data is fresh we stamp lastValidatedAt.
        // All subsequent requests within VALIDATION_TTL_MS skip fetchMeta entirely
        // and return from RAM.  Only the first request after the TTL expires
        // re-validates (concurrent ones dedup via inFlightAssetListFetches).
        if (fetchMeta)
        {
            const ttlCached = this.assetListCache.get(cacheKey);
            if (ttlCached?.lastValidatedAt !== undefined &&
                (Date.now() - ttlCached.lastValidatedAt) < VALIDATION_TTL_MS)
            {
                const assets = ttlCached.data
                    .map(id => this.assetInfoCache.get(id)?.data)
                    .filter((a): a is ImmichAsset => a !== undefined);
                return buildFiles(assets, settings);
            }
        }

        // Deduplicate concurrent fetches. The promise resolves to asset IDs (stored in
        // assetListCache); full asset data is kept in assetInfoCache to avoid duplication.
        let idPromise = this.inFlightAssetListFetches.get(cacheKey);

        if (!idPromise)
        {
            idPromise = (async (): Promise<string[]> =>
            {
                const cached = this.assetListCache.get(cacheKey);

                // No validator: trust the cached ID list until an explicit invalidation.
                if (cached && !fetchMeta) return cached.data;

                if (fetchMeta)
                {
                    let freshMeta: { updatedAt?: string; checksum?: string } | undefined;
                    try { freshMeta = await fetchMeta(); } catch (_) { }

                    // Cache hit: timestamps match — stamp the TTL so the next
                    // VALIDATION_TTL_MS of requests skip this round-trip.
                    logger.debug("ImmichSessionCache", "ASSETS", `Cache Check Meta: new=${freshMeta?.updatedAt} old=${cached?.updatedAt}`)
                    if (cached && freshMeta?.updatedAt && freshMeta.updatedAt === cached.updatedAt)
                    {
                        cached.lastValidatedAt = Date.now();
                        return cached.data;
                    }

                    // Cache stale or missing — fetch, populate assetInfoCache, store IDs.
                    const assets = await fetchData();
                    const updatedAt = freshMeta?.updatedAt ?? DateUtils.getTimeStringNowISO();
                    const ids = _storeAssetsAndGetIds(assets, updatedAt);
                    this.assetListCache.set(cacheKey, { data: ids, updatedAt, lastValidatedAt: Date.now() });
                    return ids;
                }

                // No cached entry and no validator.
                const assets = await fetchData();
                const updatedAt = DateUtils.getTimeStringNowISO();
                const ids = _storeAssetsAndGetIds(assets, updatedAt);
                this.assetListCache.set(cacheKey, { data: ids, updatedAt });
                return ids;
            })();

            this.inFlightAssetListFetches.set(cacheKey, idPromise);
            idPromise.finally(() => this.inFlightAssetListFetches.delete(cacheKey)).catch(() => { });
        }

        // Resolve IDs → assets from assetInfoCache, then build per-connection file nodes.
        const ids = await idPromise;
        const assets = ids.map(id => this.assetInfoCache.get(id)?.data).filter((a): a is ImmichAsset => a !== undefined);
        return buildFiles(assets, settings);
    }
    public async fetchCachedAlbumTree(cacheKey: string, { fetchMeta, fetchData }: ImmichTreeCacheFetchArgs): Promise<ImmichAlbumsDirectoryNode | undefined>
    {
        // ── Validation TTL fast-path (same logic as fetchCachedAssetLists) ──────
        // FETCH_AlbumVirtualTree / FETCH_AlbumVirtualBranch both supply fetchMeta,
        // which calls GET /api/albums to detect stale data.  Without a TTL every
        // directory navigation to an album folder re-fetches the full album list.
        if (fetchMeta)
        {
            const ttlCached = this.albumsTreeCache.get(cacheKey);
            if (ttlCached?.lastValidatedAt !== undefined &&
                (Date.now() - ttlCached.lastValidatedAt) < VALIDATION_TTL_MS)
                return ttlCached.data;
        }

        const inflight = this.inFlightAlbumTreeFetches.get(cacheKey);
        if (inflight) return inflight;

        const promise = (async () =>
        {
            const cached = this.albumsTreeCache.get(cacheKey);

            // No validator: trust the cached tree until an explicit invalidation.
            if (cached && !fetchMeta) return cached.data;

            if (fetchMeta)
            {
                let freshMeta: { updatedAt?: string; checksum?: string } | undefined;
                try { freshMeta = await fetchMeta(); } catch (_) { }

                // Cache hit: stamp the TTL so subsequent navigations skip this call.
                if (cached && freshMeta?.updatedAt && freshMeta.updatedAt === cached.updatedAt)
                {
                    cached.lastValidatedAt = Date.now();
                    return cached.data;
                }

                // Cache stale or missing — fetch data and store with the API timestamp.
                const data = await fetchData();
                const updatedAt = freshMeta?.updatedAt ?? DateUtils.getTimeStringNowISO();
                this.albumsTreeCache.set(cacheKey, { data, updatedAt, lastValidatedAt: Date.now() });

                const album = data?.album ?? undefined;
                if (album) this.albumsPathCache.set(album.id, cacheKey);

                return data;
            }

            // No cached entry and no validator.
            const data = await fetchData();
            this.albumsTreeCache.set(cacheKey, { data, updatedAt: DateUtils.getTimeStringNowISO() });

            const album = data?.album ?? undefined;
            if (album) this.albumsPathCache.set(album.id, cacheKey);

            return data;
        })();

        this.inFlightAlbumTreeFetches.set(cacheKey, promise);
        promise.finally(() => this.inFlightAlbumTreeFetches.delete(cacheKey)).catch(() => { });
        return promise;
    }
    public async fetchCachedAssetXMP(assetId: string, api: ImmichAPI)
    {
        // Resolving tags is what makes this expensive.  In order of cost:
        //   1. the asset already carries tags (search returned them, or a previous
        //      hydration wrote them back) — free;
        //   2. HYDRATE_AssetTags resolves them from the shared tag index — one
        //      bulk build amortised across the entire library;
        //   3. only if there is no cached asset at all do we pay for a
        //      GET /api/assets/{id}.
        const cachedEntry = this.assetInfoCache.get(assetId);
        const needsAuthoritative = this.forceAssetRefetch.delete(assetId) || !cachedEntry?.data;
        const actual_asset = needsAuthoritative
            ? await api.FETCH_AssetWithTags(assetId)
            : await api.HYDRATE_AssetTags(cachedEntry!.data);
        const updatedAt = actual_asset.updatedAt ?? '';

        // Return already-rendered XMP if the asset hasn't changed.
        const entry = this.xmpCache.get(assetId);
        if (entry?.updatedAt === updatedAt)
        {
            // Promote to most-recently-used so an active scan can't evict the
            // entries it is still working through.
            this.xmpCache.delete(assetId);
            this.xmpCache.set(assetId, entry);
            return entry.xmp;
        }

        // The on-disk sidecar is merged in so XMP fields Immich doesn't model
        // survive a round-trip.  Most assets have no sidecar on disk, so the
        // read is skipped entirely once we've established that.
        const existing_xmp = config.OPTION_ENABLE_LOCAL_FILES
            ? await this.readLocalSidecar(actual_asset)
            : null;

        let xmp: string;
        try { xmp = buildAssetMetadataXMP(actual_asset, existing_xmp); }
        catch { xmp = buildAssetMetadataXMP(actual_asset, null); }

        while (this.xmpCache.size >= ImmichSessionCache.XMP_CACHE_CAP)
        {
            const oldest = this.xmpCache.keys().next().value;
            if (oldest === undefined) break;
            this.xmpCache.delete(oldest);
        }
        this.xmpCache.set(assetId, { xmp, updatedAt });
        this.scheduleSave();
        return xmp;
    }

    /**
     * Read the asset's sidecar from the mounted Immich library, or null when it
     * has none.
     *
     * Assets without a sidecar are the common case, and the old code discovered
     * that by letting readFile throw ENOENT on every single render.  Remember the
     * misses instead — a short TTL is enough, since a sidecar appearing on disk
     * is only observable through this path after the asset's updatedAt changes
     * anyway (which is what invalidates the rendered-XMP cache above).
     */
    private async readLocalSidecar(asset: ImmichAsset): Promise<string | null>
    {
        const missingUntil = this.localSidecarMissing.get(asset.id);
        if (missingUntil !== undefined && Date.now() < missingUntil) return null;

        const filepath = asset.sidecarPath
            ? config.PATH_IMMICH_MOUNT + asset.sidecarPath
            : config.PATH_IMMICH_MOUNT + asset.originalPath + ".xmp";

        try
        {
            const contents = await fs.promises.readFile(filepath, 'utf8');
            this.localSidecarMissing.delete(asset.id);
            return contents;
        }
        catch (err)
        {
            if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT')
                logger.warn('ImmichSessionCache', 'XMP', `Failed to read local sidecar ${filepath}: ${err}`);

            if (this.localSidecarMissing.size >= ImmichSessionCache.LOCAL_SIDECAR_MISS_CAP)
                this.localSidecarMissing.clear();
            this.localSidecarMissing.set(asset.id, Date.now() + ImmichSessionCache.LOCAL_SIDECAR_MISS_TTL_MS);
            return null;
        }
    }

    // Called after an XMP sidecar write: keeps the asset in assetInfoCache (so
    // directory listings stay intact) but marks tags as stale so the next XMP read
    // forces a fresh GET /api/assets/{id} that includes the updated tags.
    //
    // The tag index cannot serve this: the write is what changed the tags, so a
    // bulk index built up to TAG_INDEX_TTL_MS ago would hand back the old set.
    // Mark the asset for an authoritative refetch and drop the index, which the
    // write has just invalidated for every other asset sharing those tags too.
    public invalidateAssetXMP(assetId: string): void
    {
        const cached = this.assetInfoCache.get(assetId);
        if (cached)
            this.assetInfoCache.set(assetId, { ...cached, data: { ...cached.data, tags: undefined } });
        this.forceAssetRefetch.add(assetId);
        this.invalidateTagIndex();
        this.xmpCache.delete(assetId);
        // A sidecar write may have just created the on-disk file we previously
        // recorded as absent.
        this.localSidecarMissing.delete(assetId);
    }
    public invalidateAssets(assetIds: string[])
    {
        for (const id of assetIds)
        {
            this.assetInfoCache.delete(id);
            this.assetFileSizeCache.delete(id);
            this.xmpCache.delete(id);
            this.forceAssetRefetch.delete(id);
            this.localSidecarMissing.delete(id);
            this.evictAssetBuffer(id);
        }
        this.scheduleSave();
    }
    public invalidateAlbums()
    {
        // Also flush the raw album list so the next FETCH_Albums call re-fetches.
        this.albumsRawListCache = null;
        this.albumsRawListCachedAt = 0;
        this.albumsPathCache.clear()
        this.albumsTreeCache.clear()
    }
    public invalidateAlbumContents(albumIds: string[])
    {
        for (const id of albumIds)
        {
            this.assetListCache.delete(id);
            const path = this.albumsPathCache.get(id)
            if (path) this.albumsTreeCache.delete(path)
        }
    }
    public invalidateAssetList(fullpath: string)
    {
        this.assetListCache.delete(fullpath);
    }
    public invalidateTree()
    {
        this.assetListCache.clear();
        this.invalidateAlbums();
    }
    public invalidateAll()
    {
        for (const buf of this.assetFileBuffers.values())
            if (buf.isTmp) buf.removeCallback();

        this.assetListCache.clear();
        this.assetFileBuffers.clear();
        this.assetFileBuffersBytes = 0;
        this.assetFileSizeCache.clear();
        this.assetInfoCache.clear();

        this.albumsRawListCache = null;
        this.albumsRawListCachedAt = 0;
        this.albumsPathCache.clear()
        this.albumsTreeCache.clear()

        this.xmpCache.clear();
        this.forceAssetRefetch.clear();
        this.localSidecarMissing.clear();
        this.invalidateTagIndex();
    }

    // Only buffer-backed nodes are ever inserted (callers gate on node.isBuffer /
    // OPTION_MAX_CACHE_BUFFER before calling this), so every entry counts toward the
    // byte budget below.``
    public setAssetBuffer(id: string, node: VirtualContentBuffer): void
    {
        this.evictAssetBuffer(id); // re-promote existing entry to MRU if present

        this.assetFileBuffers.set(id, node);
        this.assetFileBuffersBytes += node.size;

        while (this.assetFileBuffersBytes > config.OPTION_SESSION_BUFFER_CACHE_MAX_BYTES)
        {
            const oldest = this.assetFileBuffers.keys().next().value;
            if (oldest === undefined || oldest === id) break; // don't evict the entry we just inserted
            this.evictAssetBuffer(oldest);
        }
    }
    private evictAssetBuffer(id: string): void
    {
        const buf = this.assetFileBuffers.get(id);
        if (buf === undefined) return;
        if (buf.isTmp) buf.removeCallback();
        this.assetFileBuffers.delete(id);
        this.assetFileBuffersBytes -= buf.size;
    }
    public tryMarkPrefetch(): boolean
    {
        const now = Date.now();
        if (now - this._lastPrefetchAt < VALIDATION_TTL_MS) return false;
        this._lastPrefetchAt = now;
        return true;
    }

}


