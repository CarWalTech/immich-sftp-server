import fs from 'fs';
import path from 'path';
import { config, UserConfig } from '../config';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { logger } from "../logger";
import { AssetDownloadSource } from '../utils/config-utils';
import { DateUtils } from "../utils/date-utils";
import { ImmichAssetFileType } from "./files/immich-asset-file";
import { ImmichAPI } from './immich-api';
import { ImmichAlbumDirectoryInfo, ImmichAlbumsDirectoryNode, ImmichAsset, ImmichUser } from "./utils/immich-api-utils";
import { buildAssetMetadataXMP } from './utils/immich-metadata-utils';

const ASSET_CACHE_DIR = '/config/cache';
const SAVE_DEBOUNCE_MS = 5_000;
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
    // Stores raw asset byte data
    assetFileBuffers: Map<string, VirtualContentBuffer>;
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
    private xmpCache: Map<string, { xmp: string; updatedAt: string }> = new Map();

    // Raw album list cache — the result of GET /api/albums, shared across all
    // connections for the same user.  All FETCH_AlbumVirtualBranch calls derive
    // their tree/branch from this list; caching it here means the full album list
    // is fetched at most once per VALIDATION_TTL_MS, regardless of how many
    // individual album folders are opened.
    private albumsRawListCache: ImmichAlbumDirectoryInfo[] | null = null;
    private albumsRawListCachedAt = 0;
    private inFlightAlbumsListFetch: Promise<ImmichAlbumDirectoryInfo[]> | null = null;

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
            const parsed = JSON.parse(raw) as Record<string, ImmichCachedEntry<ImmichAsset>>;
            let count = 0;
            for (const [k, v] of Object.entries(parsed))
            {
                if (k && v?.data && v?.updatedAt)
                {
                    this.assetInfoCache.set(k, v);
                    count++;
                }
            }
            logger.info('ImmichSessionCache', 'LOAD', `Restored ${count} asset entries from disk`);
        }
        catch (err)
        {
            logger.warn('ImmichSessionCache', 'LOAD', `Failed to restore asset cache from disk: ${err}`);
        }
    }
    private async save(): Promise<void>
    {
        if (!this._userId) return;
        const filePath = this.filepath();
        try
        {
            fs.mkdirSync(ASSET_CACHE_DIR, { recursive: true });
            const data: Record<string, ImmichCachedEntry<ImmichAsset>> = Object.fromEntries(this.assetInfoCache);
            // Use the async variant so the event loop is not blocked while writing
            // large cache files (can be several MB on a big library).
            await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf8');
        }
        catch (err)
        {
            logger.warn('ImmichSessionCache', 'SAVE', `Failed to persist asset cache to disk: ${err}`);
        }
    }
    private scheduleSave(): void
    {
        if (!this._userId) return;
        if (this._saveTimer !== null) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() =>
        {
            this._saveTimer = null;
            this.save().catch(err =>
                logger.warn('ImmichSessionCache', 'SAVE', `Async save failed: ${err}`)
            );
        }, SAVE_DEBOUNCE_MS);
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
                this.assetInfoCache.set(asset.id, { data: asset, updatedAt: asset.updatedAt ?? listUpdatedAt });
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
        // Fast path: if assetInfoCache already has fresh data, skip FETCH_Asset entirely.
        const cachedEntry = this.assetInfoCache.get(assetId);
        const actual_asset = cachedEntry?.data ?? await api.FETCH_Asset(assetId);
        const updatedAt = actual_asset.updatedAt ?? '';

        // Return already-rendered XMP if the asset hasn't changed.

        const entry = this.xmpCache.get(assetId);
        const cached_xmp = entry?.updatedAt === updatedAt ? entry.xmp : undefined;
        if (cached_xmp !== undefined) return cached_xmp;

        let xmp: string;
        try
        {
            if (config.OPTION_ENABLE_LOCAL_FILES)
            {
                const filepath = "/immich" + actual_asset.originalPath + ".xmp";
                const xmp_data = await fs.promises.readFile(filepath, 'utf8');
                xmp = buildAssetMetadataXMP(actual_asset, xmp_data);
            }
            else
            {
                xmp = buildAssetMetadataXMP(actual_asset, null);
            }
        }
        catch
        {
            xmp = buildAssetMetadataXMP(actual_asset, null);
        }

        this.xmpCache.set(assetId, { xmp, updatedAt });
        return xmp;
    }

    public invalidateAssets(assetIds: string[])
    {
        for (const id of assetIds)
        {
            this.assetInfoCache.delete(id);
            this.assetFileSizeCache.delete(id);
            this.xmpCache.delete(id);
            const buf = this.assetFileBuffers.get(id);
            if (buf?.isTmp) buf.removeCallback();
            this.assetFileBuffers.delete(id);
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
            const path = this.albumsPathCache.get(id)
            if (path)
            {
                this.albumsTreeCache.delete(path)
                this.assetListCache.delete(path)
            }
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
        this.assetFileSizeCache.clear();
        this.assetInfoCache.clear();

        this.albumsRawListCache = null;
        this.albumsRawListCachedAt = 0;
        this.albumsPathCache.clear()
        this.albumsTreeCache.clear()

        this.xmpCache.clear();
    }

}


