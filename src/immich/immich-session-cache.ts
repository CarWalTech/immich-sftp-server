import { dirname } from "path";
import { VirtualNode } from "../filesystem/virtual-node";
import { ImmichVirtualAssetFile } from "./collections/immich-virtual-asset-file";
import { ImmichAlbumDirectoryInfo, ImmichAlbumsDirectoryNode, ImmichUser } from "./utils/immich-api-utils";
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { ImmichAsset } from "./utils/immich-asset-utils";
import { VirtualFile } from "webdav-server";
import { VirtualPathInfo } from "../filesystem/virtual-path-info";
import { ImmichAlbumsDirectory } from "./collections/immich-albums-directory";
import { ImmichRootTrashDirectory } from "./collections/immich-root-commons";
import { ImmichAlbumFolder } from "./collections/immich-album-folder";
import { VirtualDirectory } from "../filesystem/virtual-directory";

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
        const cached = this.assetTree.get(cacheKey);

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

        this.assetTree.set(cacheKey, { data, updatedAt, checksum });

        return data;
    }
    public async fetchCachedAlbumTree(cacheKey: string, { fetchMeta, fetchData, }: ImmichTreeCacheFetchArgs): Promise<ImmichAlbumsDirectoryNode | undefined>
    {
        const cached = this.albumsTree.get(cacheKey);

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

        this.albumsTree.set(cacheKey, { data, updatedAt, checksum });

        const album = data?.album ?? undefined

        if (album) this.albumsMap.set(cacheKey, cacheKey);

        return data;
    }

    public invalidateAssets(assetIds: string[])
    {
        for (const id of assetIds)
        {
            this.assetFileSizes.delete(id);
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
        this.assetTree.clear();
        this.assetFileBuffers.clear();
        this.assetFileSizes.clear();
        this.albumsMap.clear()
        this.albumsTree.clear()
    }

}


