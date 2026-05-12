import fs from 'fs';
import path from "path";
import crypto from 'crypto';
import tmp from "tmp"
import axios from "axios";
import isValidFilename from 'valid-filename';
import FormData from 'form-data';

import { ImmichAlbumDirectoryInfo, ImmichTagDirectoryInfo, ImmichTag, mapTagFromApi, applyAlbumDetails, extractCurrentUser, findAlbumNode, getVirtualAlbumTree, ImmichAlbumApiResponse, ImmichAlbumsDirectoryNode, ImmichUser, mapAlbumFromApi } from "./utils/immich-api-utils";
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


export class ImmichAPI
{
    private immichAccessToken: string = '';
    private authMode: 'bearer' | 'api-key' = 'bearer';
    private uploadQueue: Array<ImmichUploadQueueItem> = [];
    private currentUser: ImmichUser | null = null;
    private userSettings: UserScopedConfig;
    private userDisplaySettings: UserDisplaySettings | null = null;
    private shouldLogoutSession = false;
    private readonly baseUrl;

    constructor(immich_url: string)
    {
        this.baseUrl = immich_url;
        this.userSettings = loadSettingsForUser();
        ImmichAssetUtils.setAssetFileNamePattern(this.userSettings.assetFileNamePattern);
    }

    // User Authentication
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


    // Get Methods
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

    // Api Function
    public async callApi({ method, endpoint, data, logAction, respAsStream = false, skipResponseLog = false }: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', endpoint: string, data?: any, logAction: string, respAsStream?: boolean, skipResponseLog?: boolean }): Promise<any>
    {
        try
        {
            logger.info(`ImmichAPI`, `${logAction}`, `Sending: ${method} /api/${endpoint}`);

            const isDownload = method === 'GET' && endpoint.startsWith('assets/') && (endpoint.endsWith('/original') || endpoint.endsWith('/thumbnail'));

            const response = await axios.request({
                method: method,
                url: `${this.baseUrl}/api/${endpoint}`,
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
                logger.info(`ImmichAPI`, `${logAction}`, `Received (${logAction}):`, response.status, '[Data skipped]');
            else
                logger.info(`ImmichAPI`, `${logAction}`, `Received:`, response.status, this.filterLogData(response.data));
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

    // Fetch Methods
    public async FETCH_Albums(assetId?: string): Promise<ImmichAlbumDirectoryInfo[]>
    {
        const [ownAlbumsResponse, sharedAlbumsResponse] = await Promise.all([
            this.callApi({
                method: 'GET',
                endpoint: assetId ? `albums?assetId=${assetId}` : 'albums',
                logAction: 'All own albums',
                skipResponseLog: true,
            }),
            this.callApi({
                method: 'GET',
                endpoint: assetId ? `albums?shared=true&assetId=${assetId}` : 'albums?shared=true',
                logAction: 'All shared albums',
                skipResponseLog: true,
            }),
        ]);

        const ownAlbums = Array.isArray(ownAlbumsResponse) ? ownAlbumsResponse : [];
        const sharedAlbums = Array.isArray(sharedAlbumsResponse) ? sharedAlbumsResponse : [];
        const combinedByAlbumId = new Map<string, Record<string, unknown>>();


        for (const album of [...ownAlbums, ...sharedAlbums])
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
    public async FETCH_VirtualAlbumTree(): Promise<ImmichAlbumsDirectoryNode>
    {
        const albums_cache = await this.FETCH_Albums();
        return getVirtualAlbumTree(albums_cache);
    }
    public async FETCH_VirtualAlbumBranch(path_id: string)
    {
        const albums = await this.FETCH_Albums();
        const tree = getVirtualAlbumTree(albums);
        return findAlbumNode(tree, n => n.path_id === path_id);
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
    public async FETCH_AssetsForNonAlbums(): Promise<ImmichAsset[]>
    {
        const normal_items = await this.FETCH_AssetsByMetadata({ isNotInAlbum: true })
        const archived_items = await this.FETCH_AssetsByMetadata({ isNotInAlbum: true, visibility: "archive" })
        const all_assets: ImmichAsset[] = [...normal_items, ...archived_items]
        return all_assets
    }
    public async FETCH_AssetsForTrash(): Promise<ImmichAsset[]>
    {
        const normal_items = await this.FETCH_AssetsByMetadata({ trashedBefore: DateTime.now().toJSDate().toISOString() })
        const archived_items = await this.FETCH_AssetsByMetadata({ trashedBefore: DateTime.now().toJSDate().toISOString(), visibility: "archive" })
        const all_assets: ImmichAsset[] = [...normal_items, ...archived_items]
        return all_assets
    }
    public async FETCH_AssetsForAlbum(album: ImmichAlbumDirectoryInfo): Promise<void>
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

        // TODO: Maybe a Better Filesize Detection?
        // for (const asset of all_assets)
        //    asset.fileSizeInByte = await this.SERVER_GetAssetFileSize(asset);


        // Convert to ImmichAsset
        album.assets = all_assets
    }
    public async FETCH_AssetsForTag(tag: ImmichTagDirectoryInfo): Promise<void>
    {
        // Fetch assets
        const normal_items = await this.FETCH_AssetsByMetadata({ tagIds: [tag.id], visibility: "archive" })
        const archived_items = await this.FETCH_AssetsByMetadata({ tagIds: [tag.id], visibility: "archive" })

        const all_assets: ImmichAsset[] = [...normal_items, ...archived_items]

        // Convert to ImmichAsset
        tag.assets = all_assets
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
                const asset = ImmichAssetUtils.mapAssetFromApi(item);
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

    // Filter Methods
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

    // Queue Functions
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
    public QUEUE_AppendFile(data: ImmichUploadQueueItem)
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

    public async QUEUE_UploadFile(fileEntry: ImmichUploadQueueItem, mtime: number)
    {
        const filename = fileEntry.filename
        logger.info(`ImmichAPI`, 'QUEUE', `Uploading: ${fileEntry.filename}`)
        // Calculate SHA-1 checksum of the buffer
        const hash = crypto.createHash('sha1');
        await pipeline(fs.createReadStream(fileEntry.tmpFile.name), hash);
        const checksum = hash.digest('base64');

        // Check if the asset already exists using bulk-upload-check
        const bulkCheckResponse = await this.SERVER_ValidateUpload(checksum, filename);

        // Parse response
        const result = bulkCheckResponse.results[0];
        const action = result.action;
        let assetId = result.assetId;
        const isTrashed = result.isTrashed;
        const reason = result.reason;
        logger.info(`ImmichAPI`, 'QUEUE', `Bulk check result for '${filename}': action=${action}, assetId=${assetId}, isTrashed=${isTrashed}, reason=${reason}`)


        // If the asset doen't exist, upload it
        if (action == "accept")
        {
            // Prepare form data
            const data = new FormData();
            const isoWithOffset = DateTime.fromSeconds(mtime, { zone: config.TZ }).toJSDate().toISOString();
            data.append('fileModifiedAt', isoWithOffset);
            data.append('fileCreatedAt', isoWithOffset);
            data.append('deviceAssetId', filename); // Use fileName as deviceAssetId
            data.append('deviceId', 'immich-network-storage');

            // Add stream from tmp file
            const readStream = fs.createReadStream(fileEntry.tmpFile.name);
            data.append('assetData', readStream, { filename: filename });

            // Send the upload request to Immich
            const uploadResponse = await this.SERVER_UploadAsset(data);

            // Close tmp file after successful upload
            fileEntry.tmpFile.removeCallback();

            // Get the new asset id
            assetId = uploadResponse.id;
        }

        //Restore the asset if it is in the trash
        if (action == "reject" && isTrashed == true)
        {
            if (fileEntry.removeFromOtherAlbums == true)
            {
                //Remove the trashed asset from other albums, in case it has some
                const assigedAlbums = await this.FETCH_AlbumsForAssetId(assetId);
                if (assigedAlbums && assigedAlbums.length > 0)
                    for (const assigedAlbum of assigedAlbums)
                        await this.SERVER_DeleteAssetFromAlbumOnly(assigedAlbum, assetId);

                await this.SERVER_RestoreAsset(assetId); //Restore the asset from the trash
            }

        }

        // Add the new asset to the album
        if (fileEntry.uploadToAlbum) await this.SERVER_AddAssetToAlbum(fileEntry.uploadToAlbum, assetId)
    }

    // Server Functions
    // DELETE
    async SERVER_DeleteAsset(asset: ImmichAsset)
    {
        return await this.callApi({
            method: 'DELETE',
            endpoint: 'assets',
            data: JSON.stringify({ ids: [asset.id] }),
            logAction: 'Delete asset'
        });
    }
    async SERVER_DeleteAlbum(album: ImmichAlbumDirectoryInfo)
    {
        await this.callApi({
            method: 'DELETE',
            endpoint: `albums/${album.id}`,
            logAction: 'Delete album'
        });
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
    async SERVER_DeleteAssetFromAlbumOnly(album: ImmichAlbumDirectoryInfo, assetId: string): Promise<void>
    {
        await this.callApi({
            method: 'DELETE',
            endpoint: `albums/${album.id}/assets`,
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Remove asset from album'
        });
    }
    // CREATE
    async SERVER_CreateAlbum(albumName: string): Promise<void>
    {
        await this.callApi({
            method: 'POST',
            endpoint: 'albums',
            data: JSON.stringify({ albumName }),
            logAction: 'Create album'
        });
    }
    // ADD
    async SERVER_AddAssetToAlbum(album: ImmichAlbumDirectoryInfo, assetId: any)
    {
        await this.callApi({
            method: 'PUT',
            endpoint: `albums/${album.id}/assets`,
            data: JSON.stringify({
                ids: [assetId]
            }),
            logAction: 'Add asset to album'
        });
    }
    async SERVER_AddAssetToUnsorted(assetId: any)
    {
        const albums = await this.FETCH_Albums(assetId)
        for (var i = 0; i < albums.length; i++)
        {
            await this.SERVER_DeleteAssetFromAlbumOnly(albums[i], assetId)
        }
    }

    // GET
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
        let response = await this.callApi({
            method: 'POST',
            endpoint: 'download/info',
            data: JSON.stringify({ assetIds: [asset.id] }),
            logAction: 'Get Download Info'
        });

        if (response !== null && typeof response === 'object') return 0;
        return Number(response.totalSize ?? 0)
    }
    // RENAME
    async SERVER_RenameAlbum(album: ImmichAlbumDirectoryInfo, newAlbumName: string): Promise<void>
    {
        await this.callApi({
            method: 'PATCH',
            endpoint: `albums/${album.id}`,
            data: JSON.stringify({ albumName: newAlbumName }),
            logAction: 'Rename album',
        });
    }
    async SERVER_RenameTag(tag: ImmichTag, newDisplayName: string): Promise<void>
    {
        await this.callApi({
            method: 'PUT',
            endpoint: `tags/${tag.id}`,
            data: JSON.stringify({ name: newDisplayName }),
            logAction: 'Rename tag',
        });
    }
    // MISC
    async SERVER_ValidateUpload(checksum: string, filename: string)
    {
        return await this.callApi({
            method: 'POST',
            endpoint: 'assets/bulk-upload-check',
            data: JSON.stringify({ assets: [{ checksum: checksum, id: filename }] }),
            logAction: 'Bulk upload check'
        });
    }
    async SERVER_ReadAsset(asset: ImmichAsset): Promise<tmp.FileResult>
    {
        const endpoint = this.userSettings.assetDownloadSource === 'preview'
            ? `assets/${asset.id}/thumbnail`
            : `assets/${asset.id}/original`;

        const responseStream: Readable = await this.callApi({
            method: 'GET',
            endpoint,
            logAction: 'Download asset',
            respAsStream: true
        });

        const tmpFile = tmp.fileSync();
        const writeStream = fs.createWriteStream(tmpFile.name);
        await pipeline(responseStream, writeStream);
        return tmpFile;
    }
    async SERVER_UploadAsset(data: any)
    {
        return await this.callApi({
            method: 'POST',
            endpoint: 'assets',
            data: data,
            logAction: 'Upload asset'
        });
    }
    async SERVER_RestoreAsset(assetId: string)
    {
        await this.callApi({
            method: 'POST',
            endpoint: 'trash/restore/assets',
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Restore asset'
        });
    }
}

export interface ImmichUploadQueueItem
{
    filename: string;
    longname: string;
    tmpFile: tmp.FileResult;
    uploadToAlbum?: ImmichAlbumDirectoryInfo;
    removeFromOtherAlbums?: boolean;
}