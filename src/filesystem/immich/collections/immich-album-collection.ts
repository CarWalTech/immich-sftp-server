import { VirtualFileSystem } from "../../virtual-file-system";
import axios from 'axios';
import FormData from 'form-data';
import crypto from 'crypto';
import { config, UserScopedSettings, loadSettingsForUser } from '../../../config';
import fs from 'fs';
import tmp from 'tmp';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { DateTime } from 'luxon';
import isValidFilename from 'valid-filename'; //Achtung, nicht auf v4.0.0 updaten. Ab da wird commjs projekt nicht mehr unterstützt, es geht dann nur noch als ES module.
import path from 'path';
import
{
    ALBUM_METADATA_FILE_NAME,
    ALBUM_BROWSER_LINK_FILE_NAME,
    hasNoSyncTag,
    isAlbumBrowserLinkFileName,
    isAlbumMetadataFileName
} from '../metadata/immich-album-metadata';
import
{
    applyAlbumDetails,
    extractCurrentUser,
    getAlbumMtime,
    ImmichAlbumApiResponse,
    ImmichAlbumBase,
    ImmichAlbumUser,
    ImmichUser,
    mapAlbumFromApi
} from '../utils/immich-album-utils';
import
{
    applyAlbumMetadataFileContent,
    buildAlbumBrowserLinkForAlbum,
    buildAlbumMetadataYamlForAlbum
} from '../metadata/immich-album-metadata-service';
import { ImmichAsset } from "./immich-root-collection";
import { ImmichFileSystem } from "../immich-file-system";
import { PathUtils } from "../../utils/path-utils";
import { Path } from "webdav-server/lib/index.v2";
import { ImmichAssetUtils } from "../utils/immich-asset-utils";
import { FileUtils } from "../../utils/file-utils";

export class ImmichAlbumCollection
{
    private albumsCache: ImmichAlbum[] = [];
    private file_system: ImmichFileSystem;

    public static readonly ALBUMS_FOLDER_NAME = 'albums';

    constructor(file_system: ImmichFileSystem)
    {
        this.file_system = file_system
    }

    // VirtualFileSystem Methods
    public async listFiles(currentDir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>
    {
        // Always refresh album cache
        this.albumsCache = await this.file_system.getApi().fetchAlbums();
        const tree = this.getVirtualAlbumTree(this.albumsCache);

        // Derive segments from the actual path, not from albumName
        const parts = PathUtils.getPathParts(currentDir); // e.g. ["albums", "Subjects", "AI Generated"]

        // Case 1: /albums → list top-level virtual folders
        if (parts.length === 1) // only "albums"
        {
            return [...tree.children.values()].map(node => ({
                name: node.fsName,
                isDir: true,
                size: 0,
                mtime: Math.floor(Date.now() / 1000),
            }));
        }

        // Case 2: /albums/<virtual path...>
        const segments = parts.slice(1); // drop "albums", keep ["Subjects", "AI Generated"]

        let node: ImmichVirtualAlbumNode = tree;
        for (const segment of segments)
        {
            const next = node.children.get(segment);
            if (!next)
            {
                throw new Error(`Folder not found: ${segment}`);
            }
            node = next;
        }


        // Case 2a: Leaf node → real album → list album contents
        if (node.album && node.children.size === 0)
        {
            const album = node.album; // use the album already attached to this node
            await this.file_system.getApi().fetchAssetsForAlbum(album);

            const files = (album.assets ?? []).map(asset => ({
                name: this.getAlbumAssetDisplayNameFromData(asset, album),
                isDir: false,
                size: asset.fileSizeInByte,
                mtime: ImmichAssetUtils.getAssetMtime(asset),
            }));

            const metadataContent = buildAlbumMetadataYamlForAlbum(album, this.file_system.getCurrentUser(), this.file_system.getUrl());
            const linkContent = buildAlbumBrowserLinkForAlbum(album, this.file_system.getUrl());

            files.push({
                name: ALBUM_METADATA_FILE_NAME,
                isDir: false,
                size: Buffer.byteLength(metadataContent, 'utf8'),
                mtime: getAlbumMtime(album),
            });

            files.push({
                name: ALBUM_BROWSER_LINK_FILE_NAME,
                isDir: false,
                size: Buffer.byteLength(linkContent, 'utf8'),
                mtime: getAlbumMtime(album),
            });

            return files;
        }


        // Case 2b: Intermediate folder → list subfolders AND album files if node is also an album
        const entries: Array<{ name: string; isDir: boolean; size: number; mtime: number }> = [];

        // Add subfolders
        for (const child of node.children.values())
        {
            entries.push({
                name: child.fsName,
                isDir: true,
                size: 0,
                mtime: Math.floor(Date.now() / 1000),
            });
        }

        // If this folder is ALSO an album, expose its virtual files
        if (node.album)
        {
            const album = node.album;

            const metadataContent = buildAlbumMetadataYamlForAlbum(album, this.file_system.getCurrentUser(), this.file_system.getUrl());
            const linkContent = buildAlbumBrowserLinkForAlbum(album, this.file_system.getUrl());

            entries.push({
                name: ALBUM_METADATA_FILE_NAME,
                isDir: false,
                size: Buffer.byteLength(metadataContent, 'utf8'),
                mtime: getAlbumMtime(album),
            });

            entries.push({
                name: ALBUM_BROWSER_LINK_FILE_NAME,
                isDir: false,
                size: Buffer.byteLength(linkContent, 'utf8'),
                mtime: getAlbumMtime(album),
            });
        }

        return entries;
    }
    public async readFile(filename: string): Promise<tmp.FileResult>
    {
        if (this.isAlbumMetadataFilePath(filename)) return await this.readAlbumMetadataFile(filename);
        else if (this.isAlbumBrowserLinkFilePath(filename)) return await this.readAlbumBrowserLinkFile(filename);
        else return await this.readAlbumAssetFile(filename)
    }
    public async writeFile(filename: string, tmpFile: tmp.FileResult): Promise<void>
    {
        if (this.isAlbumMetadataFilePath(filename))
        {
            return await this.writeAlbumMetadataFile(filename, tmpFile);
        }
        else if (this.isAlbumBrowserLinkFilePath(filename))
        {
            this.file_system.getApi().QUEUE_OnReadOnlyWrite(ALBUM_BROWSER_LINK_FILE_NAME, tmpFile)
            return;
        }
        else
        {
            this.file_system.getApi().QUEUE_AppendFile(filename, tmpFile)
            return;
        }
    }
    public async rename(oldName: string, newName: string): Promise<void>
    {
        if (this.isVirtualAlbumFile(oldName) || this.isVirtualAlbumFile(newName))
        {
            throw new Error('Renaming virtual album files is not supported.');
        }

        const oldPathInfo = this.getAlbumInfoFromFilePath(oldName);
        const newPathInfo = this.getAlbumInfoFromFilePath(newName);

        const isAlbumFolderRename = oldPathInfo.albumName && !oldPathInfo.fileName
            && newPathInfo.albumName && !newPathInfo.fileName;
        if (!isAlbumFolderRename)
        {
            throw new Error(`'${ImmichAlbumCollection.ALBUMS_FOLDER_NAME}' is read-only except for renaming album folders.`);
        }

        const newAlbumName = newPathInfo.albumName as string;
        if (!isValidFilename(newAlbumName))
        {
            throw new Error(`Invalid album name: '${newAlbumName}'.`);
        }

        const album = await this.pathToAlbum(oldName, true);
        if (!album)
        {
            throw new Error(`Album not found: '${oldPathInfo.albumName}'.`);
        }

        await this.file_system.getApi().SERVER_RenameAlbum(album, newAlbumName);
        this.albumsCache = await this.file_system.getApi().fetchAlbums();
        return;
    }
    public async stat(filename: string): Promise<{ isDir: boolean; size: number; mtime: number; } | null>
    {
        const pathInfo = this.getAlbumInfoFromFilePath(filename);

        // Refresh album cache
        this.albumsCache = await this.file_system.getApi().fetchAlbums();
        const tree = this.getVirtualAlbumTree(this.albumsCache);

        // Case 1: /albums
        if (!pathInfo.albumName)
        {
            return {
                isDir: true,
                size: 0,
                mtime: Math.floor(Date.now() / 1000),
            };
        }

        const segments = pathInfo.albumName.split('/').map(s => s.trim()).filter(Boolean);

        let node: ImmichVirtualAlbumNode = tree;
        for (const segment of segments)
        {
            if (!node.children.has(segment))
            {
                return null;
            }
            node = node.children.get(segment)!;
        }

        // Case 2: Virtual folder (may also be an album)
        if (!pathInfo.fileName)
        {
            return {
                isDir: true,
                size: 0,
                mtime: node.album ? getAlbumMtime(node.album) : Math.floor(Date.now() / 1000),
            };
        }


        // Case 3: Album folder
        if (!pathInfo.fileName && node.album)
        {
            return { isDir: true, size: 0, mtime: getAlbumMtime(node.album) };
        }

        // Case 4: Album file
        if (node.album)
        {
            if (this.isAlbumMetadataFilePath(filename))
            {
                const metadata = buildAlbumMetadataYamlForAlbum(node.album, this.file_system.getCurrentUser(), this.file_system.getUrl());
                return {
                    isDir: false,
                    size: Buffer.byteLength(metadata, 'utf8'),
                    mtime: getAlbumMtime(node.album),
                };
            }

            if (this.isAlbumBrowserLinkFilePath(filename))
            {
                const link = buildAlbumBrowserLinkForAlbum(node.album, this.file_system.getUrl());
                return {
                    isDir: false,
                    size: Buffer.byteLength(link, 'utf8'),
                    mtime: getAlbumMtime(node.album),
                };
            }

            try
            {
                const asset = await this.pathToAsset(filename, true);
                return { isDir: false, size: asset.fileSizeInByte, mtime: ImmichAssetUtils.getAssetMtime(asset) };
            }
            catch
            {
                return null
            }
        }

        return null;
    }
    public async mkdir(dirPath: string): Promise<void>
    {
        const segments = this.getAlbumSegmentsFromDir(dirPath);

        if (segments.length === 0)
        {
            throw new Error("Cannot create the root '/albums' folder.");
        }

        // The album name is the full nested path
        const albumName = segments.join(" / ");
        await this.file_system.getApi().SERVER_CreateAlbum(albumName)
    }
    public async remove(filename: string): Promise<void>
    {
        const parts = PathUtils.getPathParts(filename);
        if (parts[0] !== ImmichAlbumCollection.ALBUMS_FOLDER_NAME)
            throw new Error(`'${filename}' is not in '/albums'.`);

        const segments = parts.slice(1);
        if (segments.length === 0)
            throw new Error(`The '${ImmichAlbumCollection.ALBUMS_FOLDER_NAME}' folder itself cannot be removed.`);

        // Case 1: deleting a virtual album file (album.yaml, link.html)
        const last = segments[segments.length - 1];
        if (isAlbumMetadataFileName(last) || isAlbumBrowserLinkFileName(last))
            throw new Error('Virtual album files cannot be deleted.');

        // Case 2: deleting an album folder
        if (segments.length >= 1 && !last.includes("."))
        {
            // Resolve album
            const album = await this.pathToAlbum(filename, true);
            if (!album)
                throw new Error(`Album not found for '${filename}'.`);

            await this.file_system.getApi().fetchAssetsForAlbum(album);

            for (const asset of album.assets ?? [])
                await this.file_system.getApi().SERVER_DeleteAssetFromAlbum(album, asset);

            await this.file_system.getApi().SERVER_DeleteAlbum(album);
            return;
        }

        // Case 3: deleting an asset inside a nested album
        const album = await this.pathToAlbum(filename, false, true);
        if (!album) throw new Error(`Album not found for '${filename}'.`);
        const asset = await this.pathToAsset(filename, false);
        await this.file_system.getApi().SERVER_DeleteAssetFromAlbum(album, asset);
    }
    public async setAttributes(filename: string, mtime: number): Promise<void>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        if (this.isVirtualAlbumFile(filename)) return;

        // Check if the file exists in the upload queue
        const fileEntry = this.file_system.getApi().QUEUE_GetFile(filename);
        if (!fileEntry) throw new Error(`File not found in upload queue: ${filename}`);

        // Get the album from the cache
        const album = await this.pathToAlbum(filename)
        if (!album) throw new Error(`Album not found for ${filename}`);

        this.file_system.getApi().QUEUE_UploadFile(filename, fileEntry, mtime, { uploadToAlbum: album })
    }

    // Conditional Methods
    public isPathWithin(filePath: string): boolean
    {
        return PathUtils.isPathWithinRoot(filePath, ImmichAlbumCollection.ALBUMS_FOLDER_NAME);
    }
    public isVirtualAlbumFile(filePath: string): boolean
    {
        return this.isAlbumMetadataFilePath(filePath) || this.isAlbumBrowserLinkFilePath(filePath);
    }
    public isAlbumMetadataFilePath(filePath: string): boolean
    {
        try
        {
            return isAlbumMetadataFileName(this.getAlbumInfoFromFilePath(filePath).fileName);
        } catch
        {
            return false;
        }
    }
    public isAlbumBrowserLinkFilePath(filePath: string): boolean
    {
        try
        {
            return isAlbumBrowserLinkFileName(this.getAlbumInfoFromFilePath(filePath).fileName);
        } catch
        {
            return false;
        }
    }


    // Get Methods
    private getAlbumNormalizedName(segment: string, albumId: string): string
    {
        return PathUtils.normalizeFolderDisplayName(segment, 'album', albumId);
    }
    private getAlbumSegmentsFromDir(dirPath: string): string[]
    {
        const parts = PathUtils.getPathParts(dirPath);
        if (parts[0] !== ImmichAlbumCollection.ALBUMS_FOLDER_NAME)
        {
            throw new Error(`Path '${dirPath}' is not in '${ImmichAlbumCollection.ALBUMS_FOLDER_NAME}'.`);
        }
        return parts.slice(1);
    }
    private getAlbumInfoFromFilePath(filePath: string, isFile: boolean = false): { albumName: string | null; fileName: string | null }
    {
        const parts = PathUtils.getPathParts(filePath);

        if (parts[0] !== ImmichAlbumCollection.ALBUMS_FOLDER_NAME)
        {
            throw new Error(`Path '${filePath}' is not in '${ImmichAlbumCollection.ALBUMS_FOLDER_NAME}'.`);
        }

        // /albums
        if (parts.length === 1)
        {
            return { albumName: null, fileName: null };
        }

        // Everything after "albums"
        const segments = parts.slice(1);

        // If the last segment is a virtual file, treat it as fileName
        const last = segments[segments.length - 1];
        if (isAlbumMetadataFileName(last) || isAlbumBrowserLinkFileName(last) || isFile)
        {
            return {
                albumName: segments.slice(0, -1).join('/'),
                fileName: last,
            };
        }

        // Otherwise it's part of the album path
        return {
            albumName: segments.join('/'),
            fileName: null,
        };
    }
    private getAlbumAssetDisplayNameFromData(asset: ImmichAsset, album: ImmichAlbum): string
    {
        return ImmichAssetUtils.getAssetDisplayNameByAssetId(album.assets ?? [], new Set<string>([ALBUM_METADATA_FILE_NAME, ALBUM_BROWSER_LINK_FILE_NAME])).get(asset.id) ?? asset.originalFileName;
    }
    private getVirtualAlbumTree(albums: ImmichAlbum[]): ImmichVirtualAlbumNode
    {
        const root: ImmichVirtualAlbumNode = {
            rawName: '',
            fsName: '',
            children: new Map(),
        };

        for (const album of albums)
        {
            // Use the REAL album name for structure
            const rawSegments = album.albumName.split(' / ').map(s => s.trim()).filter(Boolean);

            let node = root;

            for (const raw of rawSegments)
            {
                const fs = this.getAlbumNormalizedName(raw, album.id);

                if (!node.children.has(fs))
                {
                    node.children.set(fs, {
                        rawName: raw,
                        fsName: fs,
                        children: new Map(),
                    });
                }

                node = node.children.get(fs)!;
            }

            node.album = album;
        }

        return root;
    }


    // Path Methods
    private async pathToAlbum(filePath: string, refreshCache: boolean = false, isFile: boolean = false): Promise<ImmichAlbum | null>
    {
        const parts = PathUtils.getPathParts(filePath); // ["albums", "My Stuff", "Toon", "Kink", "Damned", "album.yaml"]

        if (parts[0] !== ImmichAlbumCollection.ALBUMS_FOLDER_NAME) return null;

        // Remove "albums"
        const segments = parts.slice(1);

        // If last segment is a virtual file, remove it
        const last = segments[segments.length - 1];
        if (isAlbumMetadataFileName(last) || isAlbumBrowserLinkFileName(last) || isFile) segments.pop();

        // Build tree
        if (this.albumsCache.length === 0 || refreshCache) this.albumsCache = await this.file_system.getApi().fetchAlbums();
        const tree = this.getVirtualAlbumTree(this.albumsCache);

        // Traverse
        let node: ImmichVirtualAlbumNode = tree;
        for (const segment of segments)
        {
            const next = node.children.get(segment);
            if (!next) return null;
            node = next;
        }

        return node.album ?? null;
    }
    private async pathToAsset(filename: string, refreshAssetsForThisAlbum: boolean): Promise<ImmichAsset>
    {
        const album = await this.pathToAlbum(filename, false, true);
        if (!album) throw new Error(`Album not found for filename: ${filename}`);;

        // If the album has no assets, fetch them
        if ((album.assets?.length ?? 0) === 0 || refreshAssetsForThisAlbum) await this.file_system.getApi().fetchAssetsForAlbum(album);

        // Find the asset in the album based on the configured visible file name
        const assetFileName = this.getAlbumInfoFromFilePath(filename, true).fileName;
        if (!assetFileName || !album.assets) throw new Error(`Asset not found for filename: ${filename}`);;

        const actualAsset = ImmichAssetUtils.getAssetDisplayNameMap(album.assets ?? [], new Set<string>([ALBUM_METADATA_FILE_NAME, ALBUM_BROWSER_LINK_FILE_NAME])).get(assetFileName)
        if (!actualAsset) throw new Error(`Asset not found for filename: ${filename}`);

        return actualAsset
    }

    // Read Methods
    private async readAlbumMetadataFile(filename: string): Promise<tmp.FileResult>
    {
        const album = await this.pathToAlbum(filename);
        if (!album) throw new Error(`Album not found for ${filename}`);

        await this.file_system.getApi().fetchAssetsForAlbum(album);
        return FileUtils.createTmpFile(buildAlbumMetadataYamlForAlbum(album, this.file_system.getCurrentUser(), this.file_system.getUrl()));
    }
    private async readAlbumBrowserLinkFile(filename: string): Promise<tmp.FileResult>
    {
        const album = await this.pathToAlbum(filename);
        if (!album) throw new Error(`Album not found for ${filename}`);

        await this.file_system.getApi().fetchAssetsForAlbum(album);
        return FileUtils.createTmpFile(buildAlbumBrowserLinkForAlbum(album, this.file_system.getUrl()));
    }
    private async readAlbumAssetFile(filename: string): Promise<tmp.FileResult>
    {
        const album = await this.pathToAlbum(filename, true, true);
        if (!album) throw new Error(`Album not found for filename: ${filename}`);

        const asset = await this.pathToAsset(filename, true);
        if (!asset) throw new Error(`Asset not found for filename: ${filename}`);
        return await this.file_system.getApi().SERVER_ReadAsset(asset)
    }

    // Write Methods
    private async writeAlbumMetadataFile(filename: string, tmpFile: tmp.FileResult): Promise<void>
    {
        const album = await this.pathToAlbum(filename);
        if (!album) throw new Error(`Album not found for ${filename}`);

        await this.file_system.getApi().fetchAssetsForAlbum(album);
        const content = fs.readFileSync(tmpFile.name, 'utf8');
        tmpFile.removeCallback();

        await applyAlbumMetadataFileContent({
            album,
            content,
            currentUser: this.file_system.getCurrentUser(),
            baseUrl: this.file_system.getUrl(),
            immichAPI: this.file_system.getApi(),
            refreshAlbumAssets: (targetAlbum) => this.file_system.getApi().fetchAssetsForAlbum(targetAlbum),
        });

        this.albumsCache = await this.file_system.getApi().fetchAlbums();
        return;
    }
}

export interface ImmichAlbum extends ImmichAlbumBase
{
    assets?: ImmichAsset[];
    displayName?: string;
}

export interface ImmichVirtualAlbumNode
{
    rawName: string;     // original segment from albumName
    fsName: string;      // normalized displayName segment
    children: Map<string, ImmichVirtualAlbumNode>;
    album?: ImmichAlbum;
}