import { ImmichVirtualAssetFile } from "../collections/immich-virtual-asset-file";
import { ImmichAlbumDirectoryInfo, ImmichAlbumsDirectoryNode, ImmichUser } from "../utils/immich-api-utils";
import { ImmichAsset } from "../utils/immich-api-utils";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { DateUtils } from "../../utils/date-utils";
import { logger } from "../../logger";
import { ImmichVirtualAssetItem } from "../collections/immich-virtual-directory";

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

export class ImmichSessionCache
{
    albumsMap: Map<string, string>
    assetFileSizes: Map<string, number>;
    assetPreviewSizes: Map<string, number>;
    assetFileBuffers: Map<string, VirtualContentBuffer>;

    // Stores raw asset data — no connection-specific references.
    assetInfoCache: Map<string, ImmichCachedEntry<ImmichAsset>>;
    assetListCache: Map<string, ImmichCachedEntry<ImmichAsset[]>>;
    albumsTreeCache: Map<string, ImmichCachedEntry<ImmichAlbumsDirectoryNode | undefined>>;

    // Deduplication maps: when multiple connections request the same directory
    // simultaneously (e.g. Dolphin thumbnail workers), they all share one in-flight
    // fetch rather than each issuing their own redundant API calls.
    private inFlightAssetFetches: Map<string, Promise<ImmichAsset>> = new Map();
    private inFlightAssetListFetches: Map<string, Promise<ImmichAsset[]>> = new Map();
    private inFlightAlbumTreeFetches: Map<string, Promise<ImmichAlbumsDirectoryNode | undefined>> = new Map();

    // Lightweight updatedAt hints seeded from bulk asset list fetches.
    // Used by sidecar nodes to skip FETCH_Asset when the asset hasn't changed.
    // Never stores full asset data — only updatedAt strings — so it cannot
    // corrupt the full-asset assetInfoCache entries.
    private assetUpdatedAtHints: Map<string, string> = new Map();

    private static _instances: Map<string, ImmichSessionCache> = new Map();

    constructor()
    {
        this.assetListCache = new Map()
        this.assetInfoCache = new Map()
        this.assetFileSizes = new Map()
        this.assetPreviewSizes = new Map()
        this.assetFileBuffers = new Map()

        this.albumsMap = new Map()
        this.albumsTreeCache = new Map()
    }

    public static Instance(user: ImmichUser | null): ImmichSessionCache
    {
        if (!user) return new ImmichSessionCache();

        let instance = this._instances.get(user.id);
        if (!instance)
        {
            instance = new ImmichSessionCache();
            this._instances.set(user.id, instance);
        }
        return instance;
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
                return data;
            }

            const data = await fetchData();
            this.assetInfoCache.set(assetId, { data, updatedAt: data.updatedAt ?? DateUtils.getTimeStringNowISO() });
            return data;
        })();

        this.inFlightAssetFetches.set(assetId, promise);
        promise.finally(() => this.inFlightAssetFetches.delete(assetId)).catch(() => { });
        return promise;
    }
    public async fetchedCachedAssetLists(cacheKey: string, { fetchMeta, fetchData, buildFiles }: ImmichAssetCacheFetchArgs): Promise<ImmichVirtualAssetItem[]>
    {
        // Deduplicate concurrent fetches so all connections share one in-flight
        // API request. The promise resolves to raw ImmichAsset[] (no connection
        // references), then each caller runs buildFiles() independently.
        let assetPromise = this.inFlightAssetListFetches.get(cacheKey);

        if (!assetPromise)
        {
            assetPromise = (async () =>
            {
                const cached = this.assetListCache.get(cacheKey);

                // No validator: trust the cached data until an explicit invalidation.
                if (cached && !fetchMeta) return cached.data;

                if (fetchMeta)
                {
                    let freshMeta: { updatedAt?: string; checksum?: string } | undefined;
                    try { freshMeta = await fetchMeta(); } catch (_) { }

                    // Cache hit: API timestamp matches what we stored.
                    logger.explicit("ImmichSessionCache", "ASSETS", `Cache Check Meta: new=${freshMeta?.updatedAt} old=${cached?.updatedAt}`)
                    if (cached && freshMeta?.updatedAt && freshMeta.updatedAt === cached.updatedAt)
                        return cached.data;

                    // Cache stale or missing — fetch and store with the API timestamp.
                    const data = await fetchData();
                    const updatedAt = freshMeta?.updatedAt ?? DateUtils.getTimeStringNowISO();
                    this.assetListCache.set(cacheKey, { data, updatedAt });
                    data.forEach(a => { if (a.updatedAt) this.assetUpdatedAtHints.set(a.id, a.updatedAt); });
                    return data;
                }

                // No cached entry and no validator.
                const data = await fetchData();
                this.assetListCache.set(cacheKey, { data, updatedAt: DateUtils.getTimeStringNowISO() });
                data.forEach(a => { if (a.updatedAt) this.assetUpdatedAtHints.set(a.id, a.updatedAt); });
                return data;
            })();

            this.inFlightAssetListFetches.set(cacheKey, assetPromise);
            assetPromise.finally(() => this.inFlightAssetListFetches.delete(cacheKey)).catch(() => { });
        }

        // Build fresh file nodes for this connection from the shared raw assets.
        const assets = await assetPromise;
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
                if (album) this.albumsMap.set(album.id, cacheKey);

                return data;
            }

            // No cached entry and no validator.
            const data = await fetchData();
            this.albumsTreeCache.set(cacheKey, { data, updatedAt: DateUtils.getTimeStringNowISO() });

            const album = data?.album ?? undefined;
            if (album) this.albumsMap.set(album.id, cacheKey);

            return data;
        })();

        this.inFlightAlbumTreeFetches.set(cacheKey, promise);
        promise.finally(() => this.inFlightAlbumTreeFetches.delete(cacheKey)).catch(() => { });
        return promise;
    }
    public seedAssetUpdatedAt(assetId: string, updatedAt: string): void
    {
        this.assetUpdatedAtHints.set(assetId, updatedAt);
    }
    public getAssetUpdatedAt(assetId: string): string | undefined
    {
        return this.assetInfoCache.get(assetId)?.updatedAt ?? this.assetUpdatedAtHints.get(assetId);
    }

    public invalidateAssets(assetIds: string[])
    {
        for (const id of assetIds)
        {
            this.assetInfoCache.delete(id);
            this.assetUpdatedAtHints.delete(id);
            this.assetFileSizes.delete(id);
            this.assetPreviewSizes.delete(id);
            const buf = this.assetFileBuffers.get(id);
            if (buf?.isTmp) buf.removeCallback();
            this.assetFileBuffers.delete(id);
        }
    }
    public invalidateAlbums()
    {
        this.albumsMap.clear()
        this.albumsTreeCache.clear()
    }
    public invalidateAlbumContents(albumIds: string[])
    {
        for (const id of albumIds)
        {
            const path = this.albumsMap.get(id)
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
        this.assetInfoCache.clear();
        this.assetUpdatedAtHints.clear();
        this.assetFileBuffers.clear();
        this.assetFileSizes.clear();
        this.assetPreviewSizes.clear();
        this.albumsMap.clear()
        this.albumsTreeCache.clear()
    }

}


