import fs from 'fs';
import path from 'path';
import { ImmichVirtualAssetFile } from "../collections/immich-virtual-asset-file";
import { ImmichAlbumDirectoryInfo, ImmichAlbumsDirectoryNode, ImmichUser } from "../utils/immich-api-utils";
import { ImmichAsset } from "../utils/immich-api-utils";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { DateUtils } from "../../utils/date-utils";
import { logger } from "../../logger";
import { ImmichVirtualAssetItem } from "../collections/immich-virtual-directory";
import { AssetDownloadSource, config } from '../../config';
import { ImmichAPI } from '../immich-api';
import { buildAssetMetadataXMP } from '../utils/immich-metadata-utils';

const ASSET_CACHE_DIR = '/config/cache';
const SAVE_DEBOUNCE_MS = 5_000;

export interface ImmichCachedEntry<T>
{
    data: T;
    updatedAt: string;
    checksum?: string;
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
    buildFiles: (assets: ImmichAsset[]) => ImmichVirtualAssetItem[];
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

    // Deduplication maps: when multiple connections request the same directory
    // simultaneously (e.g. Dolphin thumbnail workers), they all share one in-flight
    // fetch rather than each issuing their own redundant API calls.
    private inFlightAssetFetches: Map<string, Promise<ImmichAsset>> = new Map();
    private inFlightAssetListFetches: Map<string, Promise<string[]>> = new Map();
    private inFlightAlbumTreeFetches: Map<string, Promise<ImmichAlbumsDirectoryNode | undefined>> = new Map();

    private static _instances: Map<string, ImmichSessionCache> = new Map();

    private _userId: string | null = null;
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

    public static Instance(user: ImmichUser | null): ImmichSessionCache
    {
        if (!user) return new ImmichSessionCache();

        let instance = this._instances.get(user.id);
        if (!instance)
        {
            instance = new ImmichSessionCache();
            instance._userId = user.id;
            instance.load();
            this._instances.set(user.id, instance);
        }
        return instance;
    }

    private filepath(): string
    {
        return path.join(ASSET_CACHE_DIR, `${this._userId}-assets.json`);
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
    private save(): void
    {
        if (!this._userId) return;
        const filePath = this.filepath();
        try
        {
            fs.mkdirSync(ASSET_CACHE_DIR, { recursive: true });
            const data: Record<string, ImmichCachedEntry<ImmichAsset>> = Object.fromEntries(this.assetInfoCache);
            fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
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
            this.save();
        }, SAVE_DEBOUNCE_MS);
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
    public async fetchCachedAssetLists(cacheKey: string, { fetchMeta, fetchData, buildFiles }: ImmichAssetCacheFetchArgs): Promise<ImmichVirtualAssetItem[]>
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

                    // Cache hit: API timestamp matches what we stored.
                    logger.explicit("ImmichSessionCache", "ASSETS", `Cache Check Meta: new=${freshMeta?.updatedAt} old=${cached?.updatedAt}`)
                    if (cached && freshMeta?.updatedAt && freshMeta.updatedAt === cached.updatedAt)
                        return cached.data;

                    // Cache stale or missing — fetch, populate assetInfoCache, store IDs.
                    const assets = await fetchData();
                    const updatedAt = freshMeta?.updatedAt ?? DateUtils.getTimeStringNowISO();
                    const ids = _storeAssetsAndGetIds(assets, updatedAt);
                    this.assetListCache.set(cacheKey, { data: ids, updatedAt });
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
        return buildFiles(assets);
    }
    public async fetchCachedAlbumTree(cacheKey: string, { fetchMeta, fetchData }: ImmichTreeCacheFetchArgs): Promise<ImmichAlbumsDirectoryNode | undefined>
    {
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

                // Cache hit: API timestamp matches what we stored.
                if (cached && freshMeta?.updatedAt && freshMeta.updatedAt === cached.updatedAt)
                    return cached.data;

                // Cache stale or missing — fetch data and store with the API timestamp.
                const data = await fetchData();
                const updatedAt = freshMeta?.updatedAt ?? DateUtils.getTimeStringNowISO();
                this.albumsTreeCache.set(cacheKey, { data, updatedAt });

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
            if (config.enableLocalFiles)
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
        // assetInfoCache and assetUpdatedAtHints are intentionally preserved:
        // per-asset metadata survives full invalidations and persists across restarts.
        this.assetFileBuffers.clear();
        this.assetFileSizeCache.clear();
        this.albumsPathCache.clear()
        this.albumsTreeCache.clear()
    }

}


