import fs from 'fs';
import path from "path";
import crypto from 'crypto';
import tmp from "tmp"
import axios from "axios";
import { createWriteStream } from 'fs';
import isValidFilename from 'valid-filename';
import FormData from 'form-data';

import { ImmichAlbumDirectoryInfo, ImmichTagDirectoryInfo, ImmichTag, mapTagFromApi, applyAlbumDetails, extractCurrentUser, findAlbumNode, getVirtualAlbumTree, ImmichAlbumApiResponse, ImmichAlbumsDirectoryNode, ImmichUser, mapAlbumFromApi, mapAssetFromApi, getAssetMtime, mapFilesFromAssets } from "./utils/immich-api-utils";
import { config, UserConfigLoader, UserConfig } from "../config";
import { PathUtils } from "../utils/path-utils";
import { AlbumMetadataDocumentUtils } from "./utils/immich-metadata-utils";
import { StringUtils2 } from "../utils/string-utils";
import { pipeline } from 'stream/promises';
import { Readable } from "stream";
import { DateTime } from 'luxon';
import { ImmichAsset } from "./utils/immich-api-utils";
import { isObjectWithId } from "../utils/common-utils";
import { logger } from '../logger';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { VirtualContentBufferUtils } from "../filesystem/virtual-content-buffer";
import { ImmichCachedEntry, ImmichSessionCache } from './immich-session-cache';
import { ImmichVirtualAssetFile } from './collections/immich-virtual-asset-file';
import { ImmichAlbumFolder } from './collections/immich-album-folder';
import { ImmichVirtualDirectory } from './collections/immich-virtual-directory';
import { DateUtils } from '../utils/date-utils';

/**
 * Lightweight counting semaphore for concurrency control.
 */
class DownloadSemaphore
{
    private readonly limit: number;
    private running = 0;
    private readonly queue: Array<() => void> = [];

    constructor(limit: number) { this.limit = limit; }

    acquire(): Promise<void>
    {
        if (this.running < this.limit)
        {
            this.running++;
            return Promise.resolve();
        }
        return new Promise<void>(resolve =>
        {
            this.queue.push(() => { this.running++; resolve(); });
        });
    }

    release(): void
    {
        this.running--;
        const next = this.queue.shift();
        if (next) next();
    }
}

export class ImmichAPI
{
    private immichAccessToken: string = '';
    private authMode: 'bearer' | 'api-key' = 'bearer';
    private uploadQueue: Array<ImmichUploadItem> = [];
    private currentUser: ImmichUser | null = null;
    private userSettings: UserConfig;
    private shouldLogoutSession = false;
    private readonly baseUrl;
    private readonly downloadSemaphore = new DownloadSemaphore(config.maxConcurrentDLs);

    constructor(immich_url: string)
    {
        this.baseUrl = immich_url;
        this.userSettings = UserConfigLoader.load_user_or_default();
    }

    // #region User Authentication
    public async login(username: string, password: string)
    {
        const trimmedUsername = username.trim();
        const trimmedPassword = password.trim();

        if (trimmedUsername === 'apikey')
        {
            const apiKey = trimmedPassword
            if (!apiKey) throw new Error('API key login requires a non-empty API key as password.');

            this.immichAccessToken = apiKey;
            this.shouldLogoutSession = false;
            this.authMode = 'api-key';

            const me = await this.callApi({
                method: 'GET',
                endpoint: 'users/me',
                logAction: 'Current user (api key)',
                skipResponseLog: true,
            });
            this.currentUser = extractCurrentUser(me, 'api-key');
            const userId = StringUtils2.getTrimmedString(this.currentUser?.id);
            this.userSettings = UserConfigLoader.load_user_or_default(userId || undefined);
            return;
        }

        const loginResp = await this.callApi({
            method: 'POST',
            endpoint: 'auth/login',
            data: JSON.stringify({
                email: trimmedUsername,
                password: trimmedPassword,
            }),
            logAction: 'Login'
        });

        // Store the access token
        this.immichAccessToken = loginResp.accessToken;
        this.authMode = 'bearer';
        this.shouldLogoutSession = true;

        // Try to get current user from login response first
        this.currentUser = extractCurrentUser(loginResp.user, trimmedUsername);

        // Fallback to users/me endpoint
        if (!this.currentUser?.id || !this.currentUser?.username)
        {
            await this.initUser(trimmedUsername);
        }

        const userId = StringUtils2.getTrimmedString(this.currentUser?.id);
        this.userSettings = UserConfigLoader.load_user_or_default(userId || undefined);
    }
    public async logout(): Promise<void>
    {
        if (this.shouldLogoutSession)
        {
            await this.callApi({
                method: 'POST',
                endpoint: 'auth/logout',
                logAction: 'Logout'
            });
        }
        this.immichAccessToken = '';
        this.shouldLogoutSession = false;
        this.currentUser = null;
        this.userSettings = UserConfigLoader.load_user_or_default();
    }
    public async initUser(fallbackUsername: string): Promise<void>
    {
        try
        {
            const me = await this.callApi({
                method: 'GET',
                endpoint: 'users/me',
                logAction: 'Current user',
                skipResponseLog: true,
            });
            this.currentUser = extractCurrentUser(me, fallbackUsername);
        } catch (error)
        {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn(`ImmichAPI`, 'fetchCurrentUser', `Could not fetch current user (${errorMessage}), falling back to login username.`);
            this.currentUser = {
                id: '',
                username: fallbackUsername,
                email: fallbackUsername,
            };
        }
    }
    // #endregion

    // #region Get Methods
    get cache(): ImmichSessionCache
    {
        return ImmichSessionCache.Instance(this.currentUser)
    }
    public getUser()
    {
        return this.currentUser
    }
    public getBaseUrl()
    {
        return this.baseUrl
    }
    public getUserSettings()
    {
        return this.userSettings
    }
    public getAssetDisplayName(asset: ImmichAsset): [string, string]
    {
        const extension = path.extname(asset.originalFileName);
        const originalFileName = asset.originalFileName.slice(0, -(extension.length));
        const timestamp = getAssetMtime(asset);
        const dt = DateTime.fromSeconds(timestamp, { zone: config.immichTimezone });
        const formattedTimestamp = `${dt.toFormat('yyyyLLdd_HHmmss')}${String(dt.millisecond).padStart(3, '0')}`;
        const shortId = asset.id.slice(0, 8);

        switch (this.userSettings.assetFileNamePattern)
        {
            case 'assetUuid':
                return [`${asset.id}`, extension];
            case 'shortUuid':
                return [`img_${shortId}`, extension];
            case 'date':
                return [`${formattedTimestamp}`, extension];
            case 'dateUuid':
                return [`${formattedTimestamp}_${shortId}`, extension];
            case 'original':
            default:
                return [originalFileName, extension];
        }
    }

    // #endregion

    // #region Api Function
    public async callApi({ method, endpoint, data, logAction, respAsStream = false, skipResponseLog = false }: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', endpoint: string, data?: any, logAction: string, respAsStream?: boolean, skipResponseLog?: boolean }): Promise<any>
    {
        try
        {
            logger.explicit(`ImmichAPI`, `${logAction}`, `Sending: ${method} /api/${endpoint}`);

            const isDownload = method === 'GET' && endpoint.startsWith('assets/') && (endpoint.endsWith('/original') || endpoint.endsWith('/thumbnail'));

            const response = await axios.request({
                method: method,
                url: `${this.baseUrl}/api/${endpoint}`,
                timeout: 30_000,
                headers: {
                    ...(isDownload ? {} : { 'Accept': 'application/json' }),
                    'User-Agent': 'ImmichNetworkStorage (Linux)',
                    ...(this.authMode === 'api-key'
                        ? { 'x-api-key': this.immichAccessToken }
                        : { 'Authorization': `Bearer ${this.immichAccessToken}` }),
                    ...(data instanceof FormData ? data.getHeaders?.() : { 'Content-Type': 'application/json' }),
                },
                data: data ?? undefined,

                // stream = Streaming requested for download
                // arraybuffer = Download requested without streaming
                // json = Default for all other requests
                responseType: respAsStream ? 'stream' : (isDownload ? 'arraybuffer' : 'json'),
            });


            if (skipResponseLog == true)
                logger.explicit(`ImmichAPI`, `${logAction}`, `Received (${logAction}):`, response.status, '[Data skipped]');
            else
                logger.explicit(`ImmichAPI`, `${logAction}`, `Received:`, response.status, this.filterLogData(response.data));
            return response.data;
        }
        catch (restoreError)
        {
            if (axios.isAxiosError(restoreError))
                logger.error(`ImmichAPI`, `${logAction}`, `Axios error (${logAction}):`, restoreError.response?.data || restoreError.message);
            else
                logger.error(`ImmichAPI`, `${logAction}`, `Unknown error during http request (${logAction}):`, restoreError);
            throw restoreError;
        }
    }
    // #endregion

    // #region Filter Methods
    private filterAlbums(response: unknown)
    {
        if (!Array.isArray(response))
        {
            logger.warn(`ImmichAPI`, 'filterAlbums', `Unexpected albums response format: expected array but got ${typeof response}.`);
            return [];
        }

        // Map response to ImmichAlbum objects, sanitizing album names for use as folder names
        const albums: ImmichAlbumDirectoryInfo[] = response.map((item): ImmichAlbumDirectoryInfo =>
        {
            const base = mapAlbumFromApi(item as ImmichAlbumApiResponse);
            return {
                ...base,
                displayName: PathUtils.normalizeFolderDisplayName(base.albumName, 'album', base.id),
            };
        });

        // Filter out albums whose description contains "#nosync"
        let filteredAlbums = albums.filter(album => !AlbumMetadataDocumentUtils.hasNoSyncTag(album.description));

        // Filter out albums with empty or invalid display names
        filteredAlbums = filteredAlbums.filter(album => isValidFilename(album.displayName!));

        // Filter out duplicate display names (case-insensitive)
        const seenNames = new Set<string>();
        filteredAlbums = filteredAlbums.filter(album =>
        {
            const lowerName = album.displayName!.toLowerCase();
            if (seenNames.has(lowerName)) return false;
            seenNames.add(lowerName);
            return true;
        });

        //Return filtered albums
        return filteredAlbums;
    }
    private filterLogData(data: unknown, seen = new WeakSet()): unknown
    {
        // Prevent infinite recursion on circular structures
        if (typeof data === 'object' && data !== null)
        {
            if (seen.has(data))
            {
                return '[Circular]';
            }
            seen.add(data);
        }

        // Binary types
        if (Buffer.isBuffer(data)) return '[Binary Data]';
        if (data instanceof Blob) return '[Blob]';
        if (data instanceof FormData) return '[FormData]';

        // Strings: try to parse JSON
        if (typeof data === 'string')
        {
            try
            {
                const parsed = JSON.parse(data);
                return this.filterLogData(parsed, seen);
            } catch
            {
                return data; // leave plain strings alone
            }
        }

        // Non-object primitives
        if (data === null || typeof data !== 'object')
        {
            return data;
        }

        // Generic object → shallow clone + sanitize fields
        const output: Record<string, unknown> | unknown[] = Array.isArray(data) ? [] : {};

        for (const [key, value] of Object.entries(data))
        {
            (output as Record<string, unknown>)[key] = this.filterLogData(value, seen);
        }

        return output;
    }

    // #endregion

    // #region Fetch Methods
    public async FETCH_Albums(): Promise<ImmichAlbumDirectoryInfo[]>
    {
        const [ownAlbumsResponse] = await Promise.all([
            this.callApi({
                method: 'GET',
                endpoint: 'albums',
                logAction: 'All own albums',
                skipResponseLog: true,
            })
        ]);

        const ownAlbums = Array.isArray(ownAlbumsResponse) ? ownAlbumsResponse : [];
        const combinedByAlbumId = new Map<string, Record<string, unknown>>();

        for (const album of [...ownAlbums])
        {
            if (isObjectWithId(album))
            {
                combinedByAlbumId.set(String(album.id), album);
            }
        }

        return this.filterAlbums(Array.from(combinedByAlbumId.values()));
    }
    public async FETCH_AlbumsForAssetId(assetId: string): Promise<ImmichAlbumDirectoryInfo[]>
    {
        // Check in which albums the asset is used
        const response = await this.callApi({
            method: 'GET',
            endpoint: `albums?assetId=${assetId}`,
            logAction: 'Albums for assetId',
            skipResponseLog: true,
        });

        //Process and filter albums
        return this.filterAlbums(response);
    }
    public async FETCH_AlbumVirtualTree()
    {
        return await this.cache.fetchCachedAlbumTree(`ROOT`, {
            // Validate using album list metadata
            fetchMeta: async () =>
            {
                const albums = await this.FETCH_Albums();
                const first = albums[0];
                return { updatedAt: first?.updatedAt };
            },

            fetchData: async () =>
            {
                const albums = await this.FETCH_Albums();
                return getVirtualAlbumTree(albums);
            }
        });
    }
    public async FETCH_AlbumVirtualBranch(path_id: string)
    {
        return await this.cache.fetchCachedAlbumTree(`${path_id}`, {
            fetchMeta: async () =>
            {
                const albums = await this.FETCH_Albums();
                const first = albums[0];
                return { updatedAt: first?.updatedAt };
            },

            fetchData: async () =>
            {
                const albums = await this.FETCH_Albums();
                const tree = getVirtualAlbumTree(albums);
                return findAlbumNode(tree, n => n.path_id === path_id) ?? undefined;
            }
        });
    }

    public async FETCH_AssetsForNonAlbums(parent: ImmichVirtualDirectory, reserved_names?: Set<string>): Promise<ImmichVirtualAssetFile[]>
    {
        const cacheKey = parent.fullpath;

        return await this.cache.fetchedCachedAssetLists(cacheKey, {
            fetchData: async () =>
            {
                return await this.FETCH_AssetsByMetadata({ isNotInAlbum: true }, { isNotInAlbum: true, visibility: "archive" })
            },
            fetchMeta: async () =>
            {
                return { updatedAt: DateUtils.getTimeStringNowISO() }
            },
            buildFiles: (assets) => mapFilesFromAssets(assets, parent, reserved_names)
        });
    }
    public async FETCH_AssetsForTrash(parent: ImmichVirtualDirectory, reserved_names?: Set<string>): Promise<ImmichVirtualAssetFile[]>
    {
        const cacheKey = parent.fullpath;

        return await this.cache.fetchedCachedAssetLists(cacheKey, {
            fetchData: async () =>
            {
                const earliestTime = DateUtils.getEarliestTimeStringISO();
                return await this.FETCH_AssetsByMetadata({ trashedAfter: earliestTime }, { trashedAfter: earliestTime, visibility: "archive" })
            },
            fetchMeta: async () =>
            {
                return { updatedAt: DateUtils.getTimeStringNowISO() }
            },
            buildFiles: (assets) => mapFilesFromAssets(assets, parent, reserved_names)
        });
    }
    public async FETCH_AssetsForAlbum(album: ImmichAlbumDirectoryInfo, parent: ImmichVirtualDirectory, reserved_names?: Set<string>): Promise<ImmichVirtualAssetFile[]>
    {
        const cacheKey = parent.fullpath;
        return await this.cache.fetchedCachedAssetLists(cacheKey, {
            // Validate using album metadata
            fetchMeta: async () =>
            {
                const meta = await this.callApi({
                    method: 'GET',
                    endpoint: `albums/${album.id}`,
                    logAction: '',
                    skipResponseLog: true,
                });
                return { updatedAt: meta?.updatedAt };
            },

            fetchData: async () =>
            {
                const response = await this.callApi({
                    method: 'GET',
                    endpoint: `albums/${album.id}`,
                    logAction: 'Assets in album',
                    skipResponseLog: true,
                });

                applyAlbumDetails(album, response);
                return await this.FETCH_AssetsByMetadata({ albumIds: [album.id], visibility: "timeline" }, { albumIds: [album.id], visibility: "archive" })
            },
            buildFiles: (assets) => mapFilesFromAssets(assets, parent, reserved_names)
        });
    }
    public async FETCH_AssetsForTag(tag: ImmichTagDirectoryInfo, parent: ImmichVirtualDirectory, reserved_names?: Set<string>): Promise<ImmichVirtualAssetFile[]>
    {
        const cacheKey = parent.fullpath;
        return await this.cache.fetchedCachedAssetLists(cacheKey, {
            // Validate using tag metadata
            fetchMeta: async () =>
            {
                const meta = await this.callApi({
                    method: 'GET',
                    endpoint: `tags/${tag.id}`,
                    logAction: '',
                    skipResponseLog: true,
                });
                return { updatedAt: meta?.updatedAt };
            },

            fetchData: async () =>
            {
                return await this.FETCH_AssetsByMetadata({ tagIds: [tag.id], visibility: "timeline" }, { tagIds: [tag.id], visibility: "archive" })
            },
            buildFiles: (assets) => mapFilesFromAssets(assets, parent, reserved_names)
        });
    }
    public async FETCH_AssetsByMetadata(...queries: ImmichMetadataSearchArguments[]): Promise<ImmichAsset[]>
    {
        const byAssetId = new Map<string, ImmichAsset>();
        for (const query of queries)
        {
            let page = 1;
            while (true)
            {
                const response = await this.callApi({
                    method: 'POST',
                    endpoint: 'search/metadata',
                    data: JSON.stringify({
                        ...query,
                        page,
                        size: 1000,
                        withDeleted: false,
                        withExif: true,
                    }),
                    logAction: 'Search assets',
                    skipResponseLog: true,
                });

                const items = Array.isArray(response?.assets?.items) ? response.assets.items : [];
                for (const item of items)
                {
                    const asset = mapAssetFromApi(item);
                    byAssetId.set(asset.id, asset);
                }

                const nextPageRaw = response?.assets?.nextPage;
                const nextPage = typeof nextPageRaw === 'string' ? Number.parseInt(nextPageRaw, 10) : Number.NaN;
                if (!Number.isInteger(nextPage) || nextPage <= page || items.length === 0)
                {
                    break;
                }
                page = nextPage;
            }
        }
        return Array.from(byAssetId.values());
    }
    public async FETCH_Tags(): Promise<ImmichTag[]>
    {
        const response = await this.callApi({
            method: 'GET',
            endpoint: 'tags',
            logAction: 'All tags',
            skipResponseLog: true,
        });

        if (!Array.isArray(response)) return [];

        const tags: ImmichTag[] = [];
        for (const tag of response)
        {
            if (!tag?.id || typeof tag?.id !== 'string') continue;
            tags.push(mapTagFromApi(tag));
        }
        return tags;
    }
    // #endregion

    // #region Queue Functions
    public QUEUE_List()
    {
        return this.uploadQueue
    }
    public QUEUE_ContainsFile(filename: string)
    {
        if (this.QUEUE_GetFile(filename)) return true
        else return false
    }
    public QUEUE_GetFile(longname: string)
    {
        return this.uploadQueue.find(f => f.longname === longname)
    }
    public QUEUE_AppendFile(data: ImmichUploadItem)
    {
        logger.info(`ImmichAPI`, 'QUEUE_AppendFile', `Pushed: ${data.longname}`)
        this.uploadQueue.push(data);
    }
    public QUEUE_Splice(index: number, deleteCount?: number | undefined)
    {
        return this.uploadQueue.splice(index, deleteCount)
    }
    public QUEUE_RenameFileInFlight(oldName: string, newName: string)
    {
        const fileIndex = this.uploadQueue.findIndex(f => f.longname === oldName);
        if (fileIndex !== -1)
        {
            const oldLongName = this.uploadQueue[fileIndex].longname
            this.uploadQueue[fileIndex].longname = newName;
            this.uploadQueue[fileIndex].filename = path.basename(this.uploadQueue[fileIndex].longname)
            logger.info(`ImmichAPI`, 'QUEUE', `Renamed: ${oldLongName} -> ${newName}`)
        }

        return;
    }
    public async QUEUE_UploadFile(fileEntry: ImmichUploadItem, mtime: number)
    {
        const node = fileEntry.node; // VirtualNodeBuffer
        const filename = fileEntry.filename;

        const fileSize = node.size;
        logger.info(`ImmichAPI`, 'QUEUE', `Uploading: ${filename} (${fileSize} bytes)`);

        if (fileSize === 0)
        {
            logger.warn(`ImmichAPI`, 'QUEUE', `Skipping upload of 0-byte file '${filename}' — no data was written`);
            return;
        }

        try
        {
            // Use the pre-computed SHA-1 set by the SFTP write path (incremental, no re-read).
            // Fall back to a full read for FTP/WebDAV uploads where no checksum was pre-computed.
            let checksum: string;
            if (node.checksum)
            {
                checksum = node.checksum;
                logger.info(`ImmichAPI`, 'QUEUE', `Using pre-computed checksum for '${filename}'`);
            }
            else
            {
                const hash = crypto.createHash('sha1');
                if (node.isTmp)
                    await pipeline(fs.createReadStream(node.name), hash);
                else
                    hash.update(node.buffer!);
                checksum = hash.digest('base64');
            }

            let action = "reject";
            let isTrashed = false;
            let assetId: string | undefined;

            if (config.enableUploadValidation)
            {
                const bulkCheckResponse = await this.SERVER_ValidateUpload(checksum, filename);
                const result = bulkCheckResponse.results[0];
                const reason = result.reason;
                assetId = result.assetId;
                action = result.action;
                isTrashed = !!result.isTrashed;
                logger.info(`ImmichAPI`, 'QUEUE', `Bulk check for '${filename}': action=${action}; reason=${reason}; assetId=${assetId}`);
            }
            else
            {
                action = "accept";
            }

            if (action === "accept")
            {
                const data = new FormData();
                const iso = DateTime.fromSeconds(mtime, { zone: config.immichTimezone }).toJSDate().toISOString();

                data.append('fileModifiedAt', iso);
                data.append('fileCreatedAt', iso);
                data.append('deviceAssetId', filename);
                data.append('deviceId', 'immich-network-storage');

                const readStream = node.createReadStream();
                data.append('assetData', readStream, { filename, knownLength: fileSize });

                const uploadResponse = await this.SERVER_UploadAsset(data);
                assetId = uploadResponse.id;
            }

            // Restore if trashed
            if (action === "reject" && isTrashed && assetId)
            {
                if (fileEntry.removeFromOtherAlbums)
                {
                    const assigned = await this.FETCH_AlbumsForAssetId(assetId);
                    for (const album of assigned)
                        await this.SERVER_DeleteAssetFromAlbumOnly(album, assetId);
                }
                await this.SERVER_RestoreAsset(assetId);
            }

            // Add to album
            if (fileEntry.uploadToAlbum && assetId)
                await this.SERVER_AddAssetToAlbum(fileEntry.uploadToAlbum.id, assetId);
        }
        finally
        {
            node.removeCallback();
        }
    }
    // #endregion

    // #region Server Functions
    // DELETE
    async SERVER_DeleteAsset(asset: ImmichAsset)
    {
        const result = await this.callApi({
            method: 'DELETE',
            endpoint: 'assets',
            data: JSON.stringify({ ids: [asset.id] }),
            logAction: 'Delete asset'
        });

        this.cache.invalidateAssets([asset.id]);

        return result;
    }
    async SERVER_DeleteAlbum(album: ImmichAlbumDirectoryInfo)
    {
        await this.callApi({
            method: 'DELETE',
            endpoint: `albums/${album.id}`,
            logAction: 'Delete album'
        });

        this.cache.invalidateAlbums();
    }
    async SERVER_DeleteAssetFromAlbum(album: ImmichAlbumDirectoryInfo, asset: ImmichAsset): Promise<void>
    {
        // Check in which albums the asset is used
        const albumsForAsset = await this.FETCH_AlbumsForAssetId(asset.id);

        // If the asset is in other albums
        if (albumsForAsset && albumsForAsset.length > 1)
        {
            // Remove asset from album
            await this.SERVER_DeleteAssetFromAlbumOnly(album, asset.id);
        }
        else
        {
            // Asset is used in only 1 or no album, delete it from Immich
            await this.SERVER_DeleteAsset(asset)
        }

    }
    async SERVER_DeleteAssetFromAlbumOnly(album: ImmichAlbumDirectoryInfo, assetId: string)
    {
        await this.callApi({
            method: 'DELETE',
            endpoint: `albums/${album.id}/assets`,
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Remove asset from album'
        });

        this.cache.invalidateAlbumContents([album.id]);
    }
    async SERVER_CreateAlbum(albumName: string): Promise<string>
    {
        const response = await this.callApi({
            method: 'POST',
            endpoint: 'albums',
            data: JSON.stringify({ albumName }),
            logAction: 'Create album'
        });

        this.cache.invalidateAlbums()
        return String(response.id)
    }
    async SERVER_AddAssetToAlbum(album_id: string, assetId: any)
    {
        await this.callApi({
            method: 'PUT',
            endpoint: `albums/${album_id}/assets`,
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Add asset to album'
        });

        this.cache.invalidateAlbumContents([album_id]);
    }
    async SERVER_AddAssetToUnsorted(assetId: any)
    {
        const albums = await this.FETCH_AlbumsForAssetId(assetId)
        for (var i = 0; i < albums.length; i++)
        {
            await this.SERVER_DeleteAssetFromAlbumOnly(albums[i], assetId)
        }
    }
    async SERVER_GetCurrentUserPrefrences()
    {
        return await this.callApi({
            method: 'GET',
            endpoint: 'users/me/preferences',
            logAction: 'Current user preferences',
            skipResponseLog: true,
        });
    }
    async SERVER_GetAssetPreviewSize(asset: ImmichAsset): Promise<number>
    {
        const cached = this.cache.assetPreviewSizes.get(asset.id);
        if (cached !== undefined) return cached;

        try
        {
            const response = await axios.request({
                method: 'HEAD',
                url: `${this.baseUrl}/api/assets/${asset.id}/preview`,
                timeout: 10_000,
                headers: {
                    'User-Agent': 'ImmichNetworkStorage (Linux)',
                    ...(this.authMode === 'api-key'
                        ? { 'x-api-key': this.immichAccessToken }
                        : { 'Authorization': `Bearer ${this.immichAccessToken}` }),
                },
            });
            const size = parseInt(response.headers['content-length'] ?? '0', 10) || 0;
            this.cache.assetPreviewSizes.set(asset.id, size);
            return size;
        }
        catch
        {
            return 0;
        }
    }
    async SERVER_GetAssetFileSize(asset: ImmichAsset): Promise<number>
    {
        const cached = this.cache.assetFileSizes.get(asset.id);
        if (cached !== undefined) return cached;

        if (config.enableLocalFiles)
        {
            const filepath = "/immich" + asset.originalPath;
            const stats = fs.statSync(filepath)
            const size = stats.size
            this.cache.assetFileSizes.set(asset.id, size);
            return size;
        }

        let response = await this.callApi({
            method: 'POST',
            endpoint: 'download/info',
            data: JSON.stringify({ assetIds: [asset.id] }),
            logAction: 'Get Download Info'
        });

        const size = Number(response?.totalSize ?? 0);
        this.cache.assetFileSizes.set(asset.id, size);
        return size;
    }
    async SERVER_RenameAlbum(album: ImmichAlbumDirectoryInfo, newAlbumName: string)
    {
        await this.callApi({
            method: 'PATCH',
            endpoint: `albums/${album.id}`,
            data: JSON.stringify({ albumName: newAlbumName }),
            logAction: 'Rename album'
        });

        this.cache.invalidateAlbums()
    }
    async SERVER_RenameTag(tag: ImmichTag, newDisplayName: string)
    {
        await this.callApi({
            method: 'PUT',
            endpoint: `tags/${tag.id}`,
            data: JSON.stringify({ name: newDisplayName }),
            logAction: 'Rename tag'
        });
    }
    async SERVER_ValidateUpload(checksum: string, filename: string)
    {
        return await this.callApi({
            method: 'POST',
            endpoint: 'assets/bulk-upload-check',
            data: JSON.stringify({ assets: [{ checksum: checksum, id: filename }] }),
            logAction: 'Bulk upload check'
        });
    }
    async SERVER_ReadAsset(asset: ImmichAsset): Promise<VirtualContentBuffer>
    {
        // 1. Check cache
        const cached = this.cache.assetFileBuffers.get(asset.id);
        if (cached) return cached;

        // 2. Local mode (unchanged)
        if (config.enableLocalFiles)
        {
            const filepath = "/immich" + asset.originalPath;
            const buf = new VirtualContentBuffer(undefined, fs.readFileSync(filepath));
            this.cache.assetFileBuffers.set(asset.id, buf);
            return buf;
        }

        // 3. Determine endpoint based on user's download source setting
        const endpoint = this.userSettings.assetDownloadSource === 'preview'
            ? `assets/${asset.id}/preview`
            : `assets/${asset.id}/original`;

        // 4. Acquire slot — prevents a directory full of files from all downloading
        //    simultaneously, which exhausts bandwidth and triggers the 30s timeout.
        await this.downloadSemaphore.acquire();

        let node: VirtualContentBuffer;
        try
        {
            // 5. Stream directly from Immich, bypassing callApi so we can read
            //    Content-Length from the response headers before choosing storage.
            const response = await axios.request({
                method: 'GET',
                url: `${this.baseUrl}/api/${endpoint}`,
                timeout: 30_000,
                headers: {
                    'User-Agent': 'ImmichNetworkStorage (Linux)',
                    ...(this.authMode === 'api-key'
                        ? { 'x-api-key': this.immichAccessToken }
                        : { 'Authorization': `Bearer ${this.immichAccessToken}` }),
                },
                responseType: 'stream',
            });

            const contentLength = parseInt(response.headers['content-length'] ?? '0', 10);
            const stream: Readable = response.data;

            logger.debug(`ImmichAPI`, 'SERVER_ReadAsset', `Downloading ${asset.id} via ${endpoint}, Content-Length=${contentLength}`);

            if (contentLength > config.maxCacheBufferSize)
            {
                // Large file — stream to a temp file to avoid heap pressure.
                // This is important when Dolphin (or similar) opens many large
                // assets concurrently for thumbnailing.
                const tmpFile = tmp.fileSync();
                await pipeline(stream, createWriteStream(tmpFile.name));
                node = new VirtualContentBuffer(tmpFile);
            }
            else
            {
                // Small file or unknown size — buffer in memory.
                const chunks: Buffer[] = [];
                for await (const chunk of stream) chunks.push(chunk as Buffer);
                node = new VirtualContentBuffer(undefined, Buffer.concat(chunks));
            }
        }
        finally
        {
            this.downloadSemaphore.release();
        }

        // 6. Only cache buffer-backed nodes. Tmp-backed large-file nodes must NOT be cached
        //    because SFTP_CLOSE calls removeCallback() to clean up the tmp file; a stale
        //    cache entry pointing at a deleted tmp file causes read failures on re-open.
        if (node.isBuffer)
        {
            this.cache.assetFileBuffers.set(asset.id, node);
        }

        return node;
    }
    async SERVER_UploadNode(path: string, node: VirtualContentBuffer, mtime: number)
    {
        const data = new FormData();
        const iso = DateTime.fromSeconds(mtime, { zone: config.immichTimezone }).toJSDate().toISOString();

        data.append('fileModifiedAt', iso);
        data.append('fileCreatedAt', iso);
        data.append('deviceAssetId', path);
        data.append('deviceId', 'immich-network-storage');

        data.append('assetData', node.createReadStream(), { filename: path, knownLength: node.size });

        return this.SERVER_UploadAsset(data);
    }
    async SERVER_UploadAsset(data: any)
    {
        const result = await this.callApi({
            method: 'POST',
            endpoint: 'assets',
            data: data,
            logAction: 'Upload asset'
        });
        this.cache.invalidateTree();
        return result;
    }
    async SERVER_RestoreAsset(assetId: string)
    {
        await this.callApi({
            method: 'POST',
            endpoint: 'trash/restore/assets',
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Restore asset'
        });

        this.cache.invalidateAssets([assetId]);
    }

    // #endregion
}

export interface ImmichMetadataSearchArguments
{
    albumIds?: string[]
    visibility?: string
    tagIds?: string[]
    personIds?: string[]
    isNotInAlbum?: boolean
    trashedAfter?: string
    trashedBefore?: string
}

export interface ImmichUploadItem
{
    filename: string;
    longname: string;
    node: VirtualContentBuffer;
    uploadToAlbum?: ImmichAlbumDirectoryInfo;
    removeFromOtherAlbums?: boolean;
}

