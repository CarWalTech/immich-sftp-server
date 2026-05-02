import { PathUtils } from "../utils/path-utils";
import { ImmichAlbum } from "./collections/immich-album-collection";
import { ImmichAsset } from "./collections/immich-root-collection";
import { ImmichTag } from "./collections/immich-tag-collection";
import { hasNoSyncTag } from "./metadata/immich-album-metadata";
import { applyAlbumDetails, extractCurrentUser, ImmichAlbumApiResponse, ImmichUser, mapAlbumFromApi } from "./utils/immich-album-utils";
import isValidFilename from 'valid-filename'; //Achtung, nicht auf v4.0.0 updaten. Ab da wird commjs projekt nicht mehr unterstützt, es geht dann nur noch als ES module.
import tmp, { file } from 'tmp';
import fs from 'fs';
import { StringUtils } from "../utils/string-utils";
import { ImmichCollectionUtils } from "./utils/immich-collection-utils";
import { ImmichAssetUtils } from "./utils/immich-asset-utils";
import axios from "axios";
import { pipeline } from 'stream/promises';
import { Readable } from "stream";
import { config, loadSettingsForUser, UserDisplaySettings, UserScopedSettings } from "../../config";
import FormData from 'form-data';
import { ImmichPerson } from "./collections/immich-people-collection";
import crypto from 'crypto';
import { DateTime } from 'luxon';
import { isObject } from "util";


export class ImmichAPI
{

    private immichAccessToken: string = '';
    private authMode: 'bearer' | 'api-key' = 'bearer';
    private uploadQueue: Array<ImmichUploadQueueItem> = [];
    private currentUser: ImmichUser | null = null;
    private userSettings: UserScopedSettings;
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

            const me = await this.fetchImmichRequest({
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

        const loginResp = await this.fetchImmichRequest({
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
            await this.fetchCurrentUser(trimmedUsername);
        }

        const userId = StringUtils.getTrimmedString(this.currentUser?.id);
        this.userSettings = loadSettingsForUser(userId || undefined);
    }
    public async logout(): Promise<void>
    {
        if (this.shouldLogoutSession)
        {
            await this.fetchImmichRequest({
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
        let tagsEnabled = this.userSettings.enableTagsFolderDefault;
        let peopleEnabled = this.userSettings.enablePeopleFolderDefault;

        try
        {
            const preferences = await this.SERVER_GetCurrentUserPrefrences();
            if (typeof preferences?.tags?.enabled === 'boolean') tagsEnabled = preferences.tags.enabled;
            if (typeof preferences?.people?.enabled === 'boolean') peopleEnabled = preferences.people.enabled;
        }
        catch (error)
        {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(`Could not fetch user preferences (${errorMessage}), using default collection settings.`);
        }

        this.userDisplaySettings = { tagsEnabled, peopleEnabled };
        return this.userDisplaySettings;
    }

    // Fetch Methods
    public async fetchAlbums(): Promise<ImmichAlbum[]>
    {
        const [ownAlbumsResponse, sharedAlbumsResponse] = await Promise.all([
            this.fetchImmichRequest({
                method: 'GET',
                endpoint: 'albums',
                logAction: 'All own albums',
                skipResponseLog: true,
            }),
            this.fetchImmichRequest({
                method: 'GET',
                endpoint: 'albums?shared=true',
                logAction: 'All shared albums',
                skipResponseLog: true,
            }),
        ]);

        const ownAlbums = Array.isArray(ownAlbumsResponse) ? ownAlbumsResponse : [];
        const sharedAlbums = Array.isArray(sharedAlbumsResponse) ? sharedAlbumsResponse : [];
        const combinedByAlbumId = new Map<string, Record<string, unknown>>();
        const isObjectWithId = (value: unknown): value is Record<string, unknown> & { id: unknown } =>
            typeof value === 'object' && value !== null && !Array.isArray(value) && 'id' in value;

        for (const album of [...ownAlbums, ...sharedAlbums])
        {
            if (isObjectWithId(album))
            {
                combinedByAlbumId.set(String(album.id), album);
            }
        }

        return this.filterAlbums(Array.from(combinedByAlbumId.values()));
    }
    public async fetchAlbumsForAssetId(assetId: string): Promise<ImmichAlbum[]>
    {
        // Check in which albums the asset is used
        const response = await this.fetchImmichRequest({
            method: 'GET',
            endpoint: `albums?assetId=${assetId}`,
            logAction: 'Albums for assetId',
            skipResponseLog: true,
        });

        //Process and filter albums
        return this.filterAlbums(response);
    }
    public async fetchTags(): Promise<ImmichTag[]>
    {
        const response = await this.fetchImmichRequest({
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
            tags.push(ImmichCollectionUtils.mapTagFromApi(tag));
        }
        return tags;
    }
    public async fetchAssetsForAlbum(album: ImmichAlbum): Promise<void>
    {
        // Fetch assets
        const response = await this.fetchImmichRequest({
            method: 'GET',
            endpoint: `albums/${album.id}`,
            logAction: 'Assets in album',
            skipResponseLog: true,
        });

        applyAlbumDetails(album, response);

        const normal_items = (response.assets ?? []).map((asset: any): ImmichAsset => ImmichAssetUtils.mapAssetFromApi(asset));
        const archived_items = await this.fetchAssetsByMetadata({ albumIds: [album.id], visibility: "archive" })

        const all_assets: ImmichAsset[] = [...normal_items, ...archived_items]

        // TODO: Maybe a Better Filesize Detection?
        // for (const asset of all_assets)
        //    asset.fileSizeInByte = await this.SERVER_GetAssetFileSize(asset);


        // Convert to ImmichAsset
        album.assets = all_assets
    }
    public async fetchAssetsByMetadata(query: { albumIds?: string[], visibility?: string, tagIds?: string[]; personIds?: string[] }): Promise<ImmichAsset[]>
    {
        const byAssetId = new Map<string, ImmichAsset>();
        let page = 1;

        while (true)
        {
            const response = await this.fetchImmichRequest({
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
    public async fetchImmichRequest({ method, endpoint, data, logAction, respAsStream = false, skipResponseLog = false }: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', endpoint: string, data?: any, logAction: string, respAsStream?: boolean, skipResponseLog?: boolean }): Promise<any>
    {
        try
        {
            console.log(`Sending (${logAction}): ${method} /api/${endpoint}`);

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

            //Todo better implementation of logging
            if (skipResponseLog == true)
            {
                console.log(`Received (${logAction}):`, response.status, '[Data skipped]');
            }
            else
            {
                console.log(`Received (${logAction}):`, response.status, this.filterLogData(response.data));
            }
            return response.data;
        } catch (restoreError)
        {
            if (axios.isAxiosError(restoreError))
            {
                console.error(`Axios error (${logAction}):`, restoreError.response?.data || restoreError.message);
            } else
            {
                console.error(`Unknown error during http request (${logAction}):`, restoreError);
            }
            throw restoreError;
        }
    }
    public async fetchCurrentUser(fallbackUsername: string): Promise<void>
    {
        try
        {
            const me = await this.fetchImmichRequest({
                method: 'GET',
                endpoint: 'users/me',
                logAction: 'Current user',
                skipResponseLog: true,
            });
            this.currentUser = extractCurrentUser(me, fallbackUsername);
        } catch (error)
        {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.warn(`Could not fetch current user (${errorMessage}), falling back to login username.`);
            this.currentUser = {
                id: '',
                username: fallbackUsername,
                email: fallbackUsername,
            };
        }
    }
    public async fetchPeople(): Promise<ImmichPerson[]>
    {
        const people: ImmichPerson[] = [];
        const seenNames = new Set<string>();
        let page = 1;

        while (true)
        {
            const response = await this.fetchImmichRequest({
                method: 'GET',
                endpoint: `people?page=${page}&size=1000&withHidden=false`,
                logAction: 'All people',
                skipResponseLog: true,
            });

            const responsePeople = Array.isArray(response?.people) ? response.people : [];
            for (const person of responsePeople)
            {
                if (!person?.id || typeof person?.id !== 'string')
                {
                    continue;
                }
                const displayName = PathUtils.normalizeFolderDisplayName(String(person.name ?? ''), 'person', person.id);
                if (!isValidFilename(displayName))
                {
                    continue;
                }
                const lowerDisplayName = displayName.toLowerCase();
                if (seenNames.has(lowerDisplayName))
                {
                    continue;
                }
                seenNames.add(lowerDisplayName);
                people.push({
                    id: person.id,
                    name: String(person.name ?? ''),
                    displayName,
                    updatedAt: typeof person.updatedAt === 'string' ? person.updatedAt : undefined,
                });
            }

            if (!response?.hasNextPage)
            {
                break;
            }
            page += 1;
        }

        return people;
    }

    // Filter Methods
    private filterAlbums(response: unknown)
    {
        if (!Array.isArray(response))
        {
            console.warn(`Unexpected albums response format: expected array but got ${typeof response}.`);
            return [];
        }

        // Map response to ImmichAlbum objects, sanitizing album names for use as folder names
        const albums: ImmichAlbum[] = response.map((item): ImmichAlbum =>
        {
            const base = mapAlbumFromApi(item as ImmichAlbumApiResponse);
            return {
                ...base,
                displayName: PathUtils.normalizeFolderDisplayName(base.albumName, 'album', base.id),
            };
        });

        // Filter out albums whose description contains "#nosync"
        let filteredAlbums = albums.filter(album => !hasNoSyncTag(album.description));

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
    public QUEUE_ContainsFile(filename: string)
    {
        if (this.QUEUE_GetFile(filename)) return true
        else return false
    }
    public QUEUE_GetFile(filename: string)
    {
        return this.uploadQueue.find(f => f.filename === filename)
    }
    public QUEUE_AppendFile(filename: string, tmpFile: tmp.FileResult)
    {
        this.uploadQueue.push({ filename, tmpFile });
    }
    public QUEUE_RenameFileInFlight(oldName: string, newName: string)
    {
        const fileIndex = this.uploadQueue.findIndex(f => f.filename === oldName);
        if (fileIndex !== -1) this.uploadQueue[fileIndex].filename = newName;
        return;
    }
    public QUEUE_OnReadOnlyWrite(filename: string, tmpFile: tmp.FileResult)
    {
        tmpFile.removeCallback();
        throw new Error(`'${filename}' is read-only.`);
    }
    public async QUEUE_UploadFile(filename: string, fileEntry: ImmichUploadQueueItem, mtime: number, params: ImmichUploadParams)
    {
        // Calculate SHA-1 checksum of the buffer
        const hash = crypto.createHash('sha1');
        await pipeline(fs.createReadStream(fileEntry.tmpFile.name), hash);
        const checksum = hash.digest('base64');

        // Check if the asset already exists using bulk-upload-check
        const bulkCheckResponse = await this.SERVER_PerformBulkAssetUploadCheck(checksum, filename);

        // Parse response
        const result = bulkCheckResponse.results[0];
        const action = result.action;
        let assetId = result.assetId;
        const isTrashed = result.isTrashed;
        const reason = result.reason;
        console.log(`Bulk check result for '${filename}': action=${action}, assetId=${assetId}, isTrashed=${isTrashed}, reason=${reason}`);

        // If the asset doen't exist, upload it
        if (action == "accept")
        {
            // Prepare form data
            const data = new FormData();
            const isoWithOffset = DateTime.fromSeconds(mtime, { zone: config.TZ }).toISO();
            data.append('fileModifiedAt', isoWithOffset);
            data.append('fileCreatedAt', isoWithOffset);
            data.append('deviceAssetId', filename); // Use fileName as deviceAssetId
            data.append('deviceId', 'immich-network-storage');
            if (params.uploadToAlbum) data.append('albumId', params.uploadToAlbum.id);

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
            if (params.removeFromOtherAlbums == true)
            {
                //Remove the trashed asset from other albums, in case it has some
                const assigedAlbums = await this.fetchAlbumsForAssetId(assetId);
                if (assigedAlbums && assigedAlbums.length > 0)
                    for (const assigedAlbum of assigedAlbums)
                        await this.SERVER_RemoveAssetFromAlbum(assigedAlbum, assetId);

                await this.SERVER_RestoreAssetFromTrash(assetId); //Restore the asset from the trash
            }

        }

        // Add the new asset to the album
        if (params.uploadToAlbum) await this.SERVER_AddAssetToAlbum(params.uploadToAlbum, assetId)
    }

    // Server Functions
    async SERVER_RemoveAssetFromAlbum(album: ImmichAlbum, assetId: string): Promise<void>
    {
        await this.fetchImmichRequest({
            method: 'DELETE',
            endpoint: `albums/${album.id}/assets`,
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Remove asset from album'
        });
    }
    async SERVER_DeleteAssetFromAlbum(album: ImmichAlbum, asset: ImmichAsset): Promise<void>
    {
        // Check in which albums the asset is used
        const albumsForAsset = await this.fetchAlbumsForAssetId(asset.id);

        // If the asset is in other albums
        if (albumsForAsset && albumsForAsset.length > 1)
        {
            // Remove asset from album
            await this.SERVER_RemoveAssetFromAlbum(album, asset.id);
        }
        else
        {
            // Asset is used in only 1 or no album, delete it from Immich
            await this.SERVER_DeleteAsset(asset)
        }

    }
    async SERVER_CreateAlbum(albumName: string): Promise<void>
    {
        await this.fetchImmichRequest({
            method: 'POST',
            endpoint: 'albums',
            data: JSON.stringify({ albumName }),
            logAction: 'Create album'
        });
    }
    async SERVER_RenameAlbum(album: ImmichAlbum, newAlbumName: string): Promise<void>
    {
        await this.fetchImmichRequest({
            method: 'PATCH',
            endpoint: `albums/${album.id}`,
            data: JSON.stringify({ albumName: newAlbumName }),
            logAction: 'Rename album',
        });
    }
    async SERVER_DeleteAlbum(album: ImmichAlbum)
    {
        await this.fetchImmichRequest({
            method: 'DELETE',
            endpoint: `albums/${album.id}`,
            logAction: 'Delete album'
        });
    }
    async SERVER_AddAssetToAlbum(album: ImmichAlbum, assetId: any)
    {
        await this.fetchImmichRequest({
            method: 'PUT',
            endpoint: `albums/${album.id}/assets`,
            data: JSON.stringify({
                ids: [assetId]
            }),
            logAction: 'Add asset to album'
        });
    }
    async SERVER_RestoreAssetFromTrash(assetId: any)
    {
        await this.fetchImmichRequest({
            method: 'POST',
            endpoint: 'trash/restore/assets',
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Restore asset'
        });
    }
    async SERVER_PerformBulkAssetUploadCheck(checksum: string, filename: string)
    {
        return await this.fetchImmichRequest({
            method: 'POST',
            endpoint: 'assets/bulk-upload-check',
            data: JSON.stringify({ assets: [{ checksum: checksum, id: filename }] }),
            logAction: 'Bulk upload check'
        });
    }
    async SERVER_UploadAsset(data: any)
    {
        return await this.fetchImmichRequest({
            method: 'POST',
            endpoint: 'assets',
            data: data,
            logAction: 'Upload asset'
        });
    }
    async SERVER_DeleteAsset(asset: ImmichAsset)
    {
        await this.fetchImmichRequest({
            method: 'DELETE',
            endpoint: 'assets',
            data: JSON.stringify({ ids: [asset.id] }),
            logAction: 'Delete asset'
        });
    }
    async SERVER_GetCurrentUserPrefrences()
    {
        return await this.fetchImmichRequest({
            method: 'GET',
            endpoint: 'users/me/preferences',
            logAction: 'Current user preferences',
            skipResponseLog: true,
        });
    }
    async SERVER_ReadAsset(asset: ImmichAsset): Promise<tmp.FileResult>
    {
        const endpoint = this.userSettings.assetDownloadSource === 'preview'
            ? `assets/${asset.id}/thumbnail`
            : `assets/${asset.id}/original`;

        const responseStream: Readable = await this.fetchImmichRequest({
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
    async SERVER_GetAssetFileSize(asset: ImmichAsset): Promise<number>
    {
        let response = await this.fetchImmichRequest({
            method: 'POST',
            endpoint: 'download/info',
            data: JSON.stringify({ assetIds: [asset.id] }),
            logAction: 'Get Download Info'
        });

        if (response !== null && typeof response === 'object') return 0;
        return Number(response.totalSize ?? 0)
    }
    async SERVER_RenameTag(tag: ImmichTag, newDisplayName: string): Promise<void>
    {
        await this.fetchImmichRequest({
            method: 'PUT',
            endpoint: `tags/${tag.id}`,
            data: JSON.stringify({ name: newDisplayName }),
            logAction: 'Rename tag',
        });
    }
    async SERVER_RenamePerson(person: ImmichPerson, newDisplayName: string)
    {
        await this.fetchImmichRequest({
            method: 'PUT',
            endpoint: `people/${person.id}`,
            data: JSON.stringify({ name: newDisplayName }),
            logAction: 'Rename person',
        });
    }
}

export interface ImmichUploadQueueItem
{
    filename: string;
    tmpFile: tmp.FileResult;
    uploadToAlbum?: ImmichAlbum;
}

export interface ImmichUploadParams
{
    uploadToAlbum?: ImmichAlbum;
    removeFromOtherAlbums?: boolean;
}