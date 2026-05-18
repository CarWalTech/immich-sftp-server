import { ImmichVirtualAssetFile } from "./collections/immich-virtual-asset-file";
import { ImmichAlbumDirectoryInfo, ImmichAlbumsDirectoryNode, ImmichUser } from "./utils/immich-api-utils";
import { ImmichAsset } from "./utils/immich-asset-utils";
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";

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
    buildFiles: (assets: ImmichAsset[]) => ImmichVirtualAssetFile[];
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
    assetTree: Map<string, ImmichCachedEntry<ImmichAsset[]>>;
    albumsTree: Map<string, ImmichCachedEntry<ImmichAlbumsDirectoryNode | undefined>>;

    // Deduplication maps: when multiple connections request the same directory
    // simultaneously (e.g. Dolphin thumbnail workers), they all share one in-flight
    // fetch rather than each issuing their own redundant API calls.
    private inFlightListFetches: Map<string, Promise<ImmichAsset[]>> = new Map();
    private inFlightTreeFetches: Map<string, Promise<ImmichAlbumsDirectoryNode | undefined>> = new Map();

    private static _instances: Map<string, ImmichSessionCache> = new Map();

    constructor()
    {
        this.assetTree = new Map()
        this.assetFileSizes = new Map()
        this.assetPreviewSizes = new Map()
        this.assetFileBuffers = new Map()

        this.albumsMap = new Map()
        this.albumsTree = new Map()
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

    public async fetchedCachedAssetLists(cacheKey: string, { fetchMeta, fetchData, buildFiles }: ImmichAssetCacheFetchArgs): Promise<ImmichVirtualAssetFile[]>
    {
        // Deduplicate concurrent fetches so all connections share one in-flight
        // API request. The promise resolves to raw ImmichAsset[] (no connection
        // references), then each caller runs buildFiles() independently.
        let assetPromise = this.inFlightListFetches.get(cacheKey);

        if (!assetPromise)
        {
            assetPromise = (async () =>
            {
                const cached = this.assetTree.get(cacheKey);

                // No validator: trust the cached data until an explicit invalidation.
                if (cached && !fetchMeta) return cached.data;

                if (fetchMeta)
                {
                    let freshMeta: { updatedAt?: string; checksum?: string } | undefined;
                    try { freshMeta = await fetchMeta(); } catch (_) { }

                    // Cache hit: API timestamp matches what we stored.
                    if (cached && freshMeta?.updatedAt && freshMeta.updatedAt === cached.updatedAt)
                        return cached.data;

                    // Cache stale or missing — fetch and store with the API timestamp.
                    const data = await fetchData();
                    const updatedAt = freshMeta?.updatedAt ?? Date.now().toString();
                    this.assetTree.set(cacheKey, { data, updatedAt });
                    return data;
                }

                // No cached entry and no validator.
                const data = await fetchData();
                this.assetTree.set(cacheKey, { data, updatedAt: Date.now().toString() });
                return data;
            })();

            this.inFlightListFetches.set(cacheKey, assetPromise);
            assetPromise.finally(() => this.inFlightListFetches.delete(cacheKey));
        }

        // Build fresh file nodes for this connection from the shared raw assets.
        const assets = await assetPromise;
        return buildFiles(assets);
    }

    public async fetchCachedAlbumTree(cacheKey: string, { fetchMeta, fetchData }: ImmichTreeCacheFetchArgs): Promise<ImmichAlbumsDirectoryNode | undefined>
    {
        const inflight = this.inFlightTreeFetches.get(cacheKey);
        if (inflight) return inflight;

        const promise = (async () =>
        {
            const cached = this.albumsTree.get(cacheKey);

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
                const updatedAt = freshMeta?.updatedAt ?? Date.now().toString();
                this.albumsTree.set(cacheKey, { data, updatedAt });

                const album = data?.album ?? undefined;
                if (album) this.albumsMap.set(album.id, cacheKey);

                return data;
            }

            // No cached entry and no validator.
            const data = await fetchData();
            this.albumsTree.set(cacheKey, { data, updatedAt: Date.now().toString() });

            const album = data?.album ?? undefined;
            if (album) this.albumsMap.set(album.id, cacheKey);

            return data;
        })();

        this.inFlightTreeFetches.set(cacheKey, promise);
        promise.finally(() => this.inFlightTreeFetches.delete(cacheKey));
        return promise;
    }

    public invalidateAssets(assetIds: string[])
    {
        for (const id of assetIds)
        {
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
        this.albumsTree.clear()
    }
    public invalidateAlbumContents(albumIds: string[])
    {
        for (const id of albumIds)
        {
            const path = this.albumsMap.get(id)
            if (path)
            {
                this.albumsTree.delete(path)
                this.assetTree.delete(path)
            }
        }
    }
    public invalidateAssetList(fullpath: string)
    {
        this.assetTree.delete(fullpath);
    }
    public invalidateTree()
    {
        this.assetTree.clear();
        this.invalidateAlbums();
    }
    public invalidateAll()
    {
        for (const buf of this.assetFileBuffers.values())
        {
            if (buf.isTmp) buf.removeCallback();
        }
        this.assetTree.clear();
        this.assetFileBuffers.clear();
        this.assetFileSizes.clear();
        this.assetPreviewSizes.clear();
        this.albumsMap.clear()
        this.albumsTree.clear()
    }

}


