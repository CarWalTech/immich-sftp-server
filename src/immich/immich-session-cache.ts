import { dirname } from "path";
import { VirtualNode } from "../filesystem/virtual-node";
import { ImmichVirtualAssetFile } from "./collections/immich-virtual-asset-file";
import { ImmichUser } from "./utils/immich-api-utils";
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";

export interface CachedEntry<T>
{
    data: T;
    updatedAt: string;
    checksum?: string;
}

export interface CacheInvalidationOptions
{
    assetIds?: string[];
    albumIds?: string[];
    tagIds?: string[];
    directoryPaths?: string[];
    invalidateAllDirectories?: boolean;
}

export interface CatchFetchArgs<T>
{
    cacheMap: Map<string, CachedEntry<T>>;
    cacheKey: string;
    fetchMeta?: () => Promise<{ updatedAt?: string; checksum?: string }>;
    fetchData: () => Promise<T>;
}

export class ImmichSessionCache
{
    albums: Map<string, CachedEntry<any>>;
    tags: Map<string, CachedEntry<any>>;
    assets: Map<string, CachedEntry<any>>;
    directories: Map<string, CachedEntry<any>>;
    assetFileSizes: Map<string, number>;
    assetDownloadUrls: Map<string, string>;
    assetFileBuffers: Map<string, VirtualContentBuffer>;
    albumAssetListings: Map<string, ImmichVirtualAssetFile[]>;

    private static _instances: Map<string, ImmichSessionCache> = new Map();

    constructor()
    {
        this.albums = new Map()
        this.tags = new Map()
        this.assets = new Map()
        this.directories = new Map()
        this.assetFileSizes = new Map()
        this.assetDownloadUrls = new Map()
        this.assetFileBuffers = new Map()
        this.albumAssetListings = new Map()
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

    public async cachedFetch<T>({ cacheMap, cacheKey, fetchMeta, fetchData, }: CatchFetchArgs<T>): Promise<T>
    {

        const cached = cacheMap.get(cacheKey);

        // 1. If cached, validate metadata
        if (cached && fetchMeta)
        {
            try
            {
                const meta = await fetchMeta();
                if (meta.updatedAt && meta.updatedAt === cached.updatedAt)
                {
                    return cached.data;
                }
            } catch (_)
            {
                // If metadata fetch fails, fall through to full fetch
            }
        }

        // 2. Fetch full data
        const data = await fetchData();

        // 3. Store in cache
        const updatedAt = (data as any)?.updatedAt ?? Date.now().toString();
        const checksum = (data as any)?.checksum;

        cacheMap.set(cacheKey, { data, updatedAt, checksum });

        return data;
    }
    public invalidateAfterMutation(opts: CacheInvalidationOptions)
    {
        if (opts.assetIds)
        {
            for (const id of opts.assetIds)
            {
                this.assets.delete(id);
                this.assetFileSizes.delete(id);
                this.assetFileBuffers.delete(id);

                // delete all download URLs for this asset
                for (const key of this.assetDownloadUrls.keys())
                {
                    if (key.startsWith(id + "_"))
                    {
                        this.assetDownloadUrls.delete(key);
                    }
                }
            }
        }

        if (opts.albumIds)
        {
            for (const id of opts.albumIds)
            {
                this.albums.delete(id);
                this.albumAssetListings.delete(id);
            }
        }

        if (opts.tagIds)
        {
            for (const id of opts.tagIds)
            {
                this.tags.delete(id);
            }
        }

        if (opts.directoryPaths)
        {
            for (const p of opts.directoryPaths)
            {
                this.directories.delete(p);
            }
        }

        if (opts.invalidateAllDirectories)
        {
            this.directories.clear();
        }
    }
    public invalidateAssetNode(node: VirtualNode)
    {
        if (node instanceof ImmichVirtualAssetFile)
        {
            const id = node.asset_id;

            this.assets.delete(id);
            this.assetFileBuffers.delete(id);
            this.assetFileSizes.delete(id);

            // delete all download URLs for this asset
            for (const key of this.assetDownloadUrls.keys())
            {
                if (key.startsWith(id + "_"))
                {
                    this.assetDownloadUrls.delete(key);
                }
            }
        }
    }
    public invalidateFilePath(path: string)
    {
        // directory listing cache is path-based → correct
        this.directories.delete(dirname(path));
    }
    public invalidateDirectoryPath(path: string)
    {
        this.directories.delete(path);
    }
    public invalidateAllDirectories()
    {
        this.directories.clear();
    }
    public invalidateAll()
    {
        this.albums.clear();
        this.tags.clear();
        this.assets.clear();
        this.directories.clear();
        this.assetFileBuffers.clear();
        this.assetFileSizes.clear();
        this.assetDownloadUrls.clear();
        this.albumAssetListings.clear();
    }

}


