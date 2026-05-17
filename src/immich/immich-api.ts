import fs from 'fs';
import path from "path";
import crypto from 'crypto';
import tmp from "tmp"
import axios from "axios";
import isValidFilename from 'valid-filename';
import FormData from 'form-data';

import { ImmichAlbumDirectoryInfo, ImmichTagDirectoryInfo, ImmichTag, mapTagFromApi, applyAlbumDetails, extractCurrentUser, findAlbumNode, getVirtualAlbumTree, ImmichAlbumApiResponse, ImmichAlbumsDirectoryNode, ImmichUser, mapAlbumFromApi, mapAssetFromApi, getAssetMtime, mapFilesFromAssets } from "./utils/immich-api-utils";
import { config, loadSettingsForUser, UserDisplaySettings, UserScopedConfig } from "../config";
import { PathUtils } from "../utils/path-utils";
import { AlbumMetadataDocumentUtils } from "./utils/immich-metadata-utils";
import { StringUtils } from "../utils/string-utils";
import { ImmichAssetUtils } from "./utils/immich-asset-utils";
import { pipeline } from 'stream/promises';
import { Readable } from "stream";
import { DateTime } from 'luxon';
import { ImmichAsset } from "./utils/immich-asset-utils";
import { isObjectWithId } from "../utils/common-utils";
import { logger } from '../logger';
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { VirtualContentBufferUtils } from "../filesystem/virtual-content-buffer";
import { ImmichCachedEntry, ImmichSessionCache } from './immich-session-cache';
import { ImmichVirtualAssetFile } from './collections/immich-virtual-asset-file';
import { ImmichAlbumFolder } from './collections/immich-album-folder';
import { ImmichVirtualDirectory } from './collections/immich-virtual-directory';

export class ImmichAPI
{
    private immichAccessToken: string = '';
    private authMode: 'bearer' | 'api-key' = 'bearer';
    private uploadQueue: Array<ImmichUploadItem> = [];
    private currentUser: ImmichUser | null = null;
    private userSettings: UserScopedConfig;
    private userDisplaySettings: UserDisplaySettings | null = null;
    private shouldLogoutSession = false;
    private assetFileNamePattern: string = ""
    private readonly baseUrl;

    constructor(immich_url: string)
    {
        this.baseUrl = immich_url;
        this.userSettings = loadSettingsForUser();
        this.assetFileNamePattern = this.userSettings.assetFileNamePattern;
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
            const userId = StringUtils.getTrimmedString(this.currentUser?.id);
            this.userSettings = loadSettingsForUser(userId || undefined);
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

        const userId = StringUtils.getTrimmedString(this.currentUser?.id);
        this.userSettings = loadSettingsForUser(userId || undefined);
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
        this.userSettings = loadSettingsForUser();
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
    public getAssetDisplayName(asset: ImmichAsset): string
    {
        const extension = path.extname(asset.originalFileName);
        const timestamp = getAssetMtime(asset);
        const dt = DateTime.fromSeconds(timestamp, { zone: config.TZ });
        const formattedTimestamp = `${dt.toFormat('yyyyLLdd_HHmmss')}${String(dt.millisecond).padStart(3, '0')}`;
        const shortId = asset.id.slice(0, 8);

        switch (this.assetFileNamePattern)
        {
            case 'assetUuid':
                return `${asset.id}${extension}`;
            case 'shortUuid':
                return `img_${shortId}${extension}`;
            case 'date':
                return `${formattedTimestamp}${extension}`;
            case 'dateUuid':
                return `${formattedTimestamp}_${shortId}${extension}`;
            case 'original':
            default:
                return asset.originalFileName;
        }
    }
    public async getUserDisplaySettings()
    {
        if (this.userDisplaySettings) return this.userDisplaySettings;
        var result: UserDisplaySettings | null = UserScopedConfig.load_user_display(undefined, {})

        try
        {
            const preferences = await this.SERVER_GetCurrentUserPrefrences();
            result = UserScopedConfig.load_user_display(this.currentUser?.id, preferences)
        }
        catch (error)
        {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.warn("ImmichAPI", "GetUserDisplaySettings", `Could not fetch user preferences (${errorMessage}), using default collection settings.`);
        }

        this.userDisplaySettings = result;
        return this.userDisplaySettings;
    }

    // #endregion

    // #region Api Function
    public async callApi({ method, endpoint, data, logAction, respAsStream = false, skipResponseLog = false }: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', endpoint: string, data?: any, logAction: string, respAsStream?: boolean, skipResponseLog?: boolean }): Promise<any>
    {
        try
        {
            logger.debug(`ImmichAPI`, `${logAction}`, `Sending: ${method} /api/${endpoint}`);

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


            //if (skipResponseLog == true)
            logger.debug(`ImmichAPI`, `${logAction}`, `Received (${logAction}):`, response.status, '[Data skipped]');
            //else
            //logger.info(`ImmichAPI`, `${logAction}`, `Received:`, response.status, this.filterLogData(response.data));
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
                const normal_items = await this.FETCH_AssetsByMetadata({ isNotInAlbum: true })
                const archived_items = await this.FETCH_AssetsByMetadata({ isNotInAlbum: true, visibility: "archive" })
                const all_assets: ImmichAsset[] = [...normal_items, ...archived_items]
                return mapFilesFromAssets(all_assets, parent, reserved_names)
            }
        });
    }
    public async FETCH_AssetsForTrash(parent: ImmichVirtualDirectory, reserved_names?: Set<string>): Promise<ImmichVirtualAssetFile[]>
    {
        const cacheKey = parent.fullpath;

        return await this.cache.fetchedCachedAssetLists(cacheKey, {
            fetchData: async () =>
            {
                const normal_items = await this.FETCH_AssetsByMetadata({ trashedBefore: DateTime.now().toJSDate().toISOString() })
                const archived_items = await this.FETCH_AssetsByMetadata({ trashedBefore: DateTime.now().toJSDate().toISOString(), visibility: "archive" })
                const all_assets: ImmichAsset[] = [...normal_items, ...archived_items]
                return mapFilesFromAssets(all_assets, parent, reserved_names)
            }
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
                // Fetch assets
                const response = await this.callApi({
                    method: 'GET',
                    endpoint: `albums/${album.id}`,
                    logAction: 'Assets in album',
                    skipResponseLog: true,
                });

                applyAlbumDetails(album, response);

                //const normal_items = (response.assets ?? []).map((asset: any): ImmichAsset => ImmichAssetUtils.mapAssetFromApi(asset));
                const normal_items = await this.FETCH_AssetsByMetadata({ albumIds: [album.id], visibility: "timeline" })
                const archived_items = await this.FETCH_AssetsByMetadata({ albumIds: [album.id], visibility: "archive" })

                const all_assets: ImmichAsset[] = [...normal_items, ...archived_items]
                return mapFilesFromAssets(all_assets, parent, reserved_names)
            }
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
                // Fetch assets
                const normal_items = await this.FETCH_AssetsByMetadata({ tagIds: [tag.id], visibility: "timeline" })
                const archived_items = await this.FETCH_AssetsByMetadata({ tagIds: [tag.id], visibility: "archive" })

                const all_assets: ImmichAsset[] = [...normal_items, ...archived_items]
                return mapFilesFromAssets(all_assets, parent, reserved_names)
            }
        });
    }
    public async FETCH_AssetsByMetadata(query: { albumIds?: string[], visibility?: string, tagIds?: string[]; personIds?: string[], isNotInAlbum?: boolean, trashedAfter?: string, trashedBefore?: string }): Promise<ImmichAsset[]>
    {
        const byAssetId = new Map<string, ImmichAsset>();
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

        logger.info(`ImmichAPI`, 'QUEUE', `Uploading: ${filename}`);

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

        // Bulk check
        const bulkCheckResponse = await this.SERVER_ValidateUpload(checksum, filename);
        const result = bulkCheckResponse.results[0];
        const action = result.action;
        let assetId = result.assetId;

        logger.info(`ImmichAPI`, 'QUEUE', `Bulk check result for '${filename}': action=${action}`);

        if (action === "accept")
        {
            const data = new FormData();
            const iso = DateTime.fromSeconds(mtime, { zone: config.TZ }).toJSDate().toISOString();

            data.append('fileModifiedAt', iso);
            data.append('fileCreatedAt', iso);
            data.append('deviceAssetId', filename);
            data.append('deviceId', 'immich-network-storage');

            // Stream from VirtualNodeBuffer
            const readStream = node.createReadStream();
            data.append('assetData', readStream, { filename });

            const uploadResponse = await this.SERVER_UploadAsset(data);
            node.removeCallback(); // cleanup tmp or noop for buffer

            assetId = uploadResponse.id;
        }

        // Restore if trashed
        if (action === "reject" && result.isTrashed)
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
        if (fileEntry.uploadToAlbum)
            await this.SERVER_AddAssetToAlbum(fileEntry.uploadToAlbum, assetId);
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
    async SERVER_CreateAlbum(albumName: string, parent?: ImmichAlbumDirectoryInfo)
    {
        await this.callApi({
            method: 'POST',
            endpoint: 'albums',
            data: JSON.stringify({ albumName }),
            logAction: 'Create album'
        });

        this.cache.invalidateAlbums()
    }
    async SERVER_AddAssetToAlbum(album: ImmichAlbumDirectoryInfo, assetId: any)
    {
        await this.callApi({
            method: 'PUT',
            endpoint: `albums/${album.id}/assets`,
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Add asset to album'
        });

        this.cache.invalidateAlbumContents([album.id]);
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
    async SERVER_GetAssetFileSize(asset: ImmichAsset): Promise<number>
    {
        const cached = this.cache.assetFileSizes.get(asset.id);
        if (cached !== undefined) return cached;

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
        if (config.localFilesMode)
        {
            const filepath = "/immich" + asset.originalPath;
            const buf = new VirtualContentBuffer(undefined, fs.readFileSync(filepath));
            this.cache.assetFileBuffers.set(asset.id, buf);
            return buf;
        }

        // 3. Determine endpoint
        const endpoint = this.userSettings.assetDownloadSource === 'preview'
            ? `assets/${asset.id}/thumbnail`
            : `assets/${asset.id}/original`;

        // 4. Download stream
        const responseStream: Readable = await this.callApi({
            method: 'GET',
            endpoint,
            logAction: 'Download asset',
            respAsStream: true
        });

        // 5. Write to temp file
        const node = await VirtualContentBufferUtils.bufferFromStream(responseStream);

        // 6. Cache the temp file buffer
        this.cache.assetFileBuffers.set(asset.id, node);

        return node;
    }
    async SERVER_UploadNode(path: string, node: VirtualContentBuffer, mtime: number)
    {
        const data = new FormData();
        const iso = DateTime.fromSeconds(mtime, { zone: config.TZ }).toJSDate().toISOString();

        data.append('fileModifiedAt', iso);
        data.append('fileCreatedAt', iso);
        data.append('deviceAssetId', path);
        data.append('deviceId', 'immich-network-storage');

        data.append('assetData', node.createReadStream(), { filename: path });

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

export interface ImmichUploadItem
{
    filename: string;
    longname: string;
    node: VirtualContentBuffer;
    uploadToAlbum?: ImmichAlbumDirectoryInfo;
    removeFromOtherAlbums?: boolean;
}

