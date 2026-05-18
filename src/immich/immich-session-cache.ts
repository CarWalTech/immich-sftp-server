import { ImmichVirtualAssetFile } from "./collections/immich-virtual-asset-file";
import { ImmichAlbumDirectoryInfo, ImmichAlbumsDirectoryNode, ImmichUser } from "./utils/immich-api-utils";
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
    fetchData: () => Promise<ImmichVirtualAssetFile[]>;
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
    assetFileBuffers: Map<string, VirtualContentBuffer>;

    assetTree: Map<string, ImmichCachedEntry<ImmichVirtualAssetFile[]>>;
    albumsTree: Map<string, ImmichCachedEntry<ImmichAlbumsDirectoryNode | undefined>>;

    // Deduplication maps: when multiple connections request the same directory
    // simultaneously (e.g. Dolphin thumbnail workers), they all share one in-flight
    // fetch rather than each issuing their own redundant API calls.
    private inFlightListFetches: Map<string, Promise<ImmichVirtualAssetFile[]>> = new Map();
    private inFlightTreeFetches: Map<string, Promise<ImmichAlbumsDirectoryNode | undefined>> = new Map();

    private static _instances: Map<string, ImmichSessionCache> = new Map();

    constructor()
    {
        this.assetTree = new Map()
        this.assetFileSizes = new Map()
        this.assetFileBuffers = new Map()

        this.albumsMap = new Map()
        this.albumsTree = new Map()
    }

    public static Instance(user: ImmichUser | null): ImmichSessionCache
    {
        if (!user) throw new Error("User not loaded!");

        if (!this._instances.has(user.id))
        {
            var new_session = new ImmichSessionCache()
            this._instances.set(user.id, new_session)
            return new_session
        }
        else
        {
            var cached_session = this._instances.get(user.id);
            if (cached_session) return cached_session;
            else throw new Error("Cache Map has reached an invalid state!");
        }

    }

    public async fetchedCachedAssetLists(cacheKey: string, { fetchMeta, fetchData }: ImmichAssetCacheFetchArgs): Promise<ImmichVirtualAssetFile[]>
    {
        // If another connection is already fetching this directory, join that
        // promise rather than firing a redundant parallel API call.
        const inflight = this.inFlightListFetches.get(cacheKey);
        if (inflight) return inflight;

        const promise = (async () =>
        {
            const cached = this.assetTree.get(cacheKey);

            if (cached && fetchMeta)
            {
                try
                {
                    const meta = await fetchMeta();
                    if (meta.updatedAt && meta.updatedAt === cached.updatedAt)
                    {
                        return cached.data;
                    }
                } catch (_) { }
            }

            const data = await fetchData();
            const updatedAt = (data as any)?.updatedAt ?? Date.now().toString();
            const checksum = (data as any)?.checksum;
            this.assetTree.set(cacheKey, { data, updatedAt, checksum });
            return data;
        })();

        this.inFlightListFetches.set(cacheKey, promise);
        promise.finally(() => this.inFlightListFetches.delete(cacheKey));
        return promise;
    }
    public async fetchCachedAlbumTree(cacheKey: string, { fetchMeta, fetchData }: ImmichTreeCacheFetchArgs): Promise<ImmichAlbumsDirectoryNode | undefined>
    {
        const inflight = this.inFlightTreeFetches.get(cacheKey);
        if (inflight) return inflight;

        const promise = (async () =>
        {
            const cached = this.albumsTree.get(cacheKey);

            if (cached && fetchMeta)
            {
                try
                {
                    const meta = await fetchMeta();
                    if (meta.updatedAt && meta.updatedAt === cached.updatedAt)
                    {
                        return cached.data;
                    }
                } catch (_) { }
            }

            const data = await fetchData();
            const updatedAt = (data as any)?.updatedAt ?? Date.now().toString();
            const checksum = (data as any)?.checksum;
            this.albumsTree.set(cacheKey, { data, updatedAt, checksum });

            const album = data?.album ?? undefined;
            if (album) this.albumsMap.set(cacheKey, cacheKey);

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
            }
        }
    }
    public invalidateTree()
    {
        this.invalidateAlbums()
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
        this.albumsMap.clear()
        this.albumsTree.clear()
    }

}


