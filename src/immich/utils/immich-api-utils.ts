import { isObject } from "../../utils/common-utils";
import { PathUtils } from "../../utils/path-utils";
import { ImmichAlbumFolder } from "../collections/immich-album-folder";
import { ImmichVirtualAssetItem, ImmichVirtualDirectory } from "../collections/immich-virtual-directory";
import { ImmichVirtualAssetFile } from "../collections/immich-virtual-asset-file";
import { logger } from "../../logger";
import { DateUtils } from "../../utils/date-utils";
import { ImmichVirtualAssetSidecar } from "../collections/immich-virtual-asset-sidecar";
import { config } from "../../config";

export interface ImmichAlbumUser
{
    userId: string;
    username: string;
    role: string;
}
export interface ImmichUser
{
    id: string;
    username: string;
    email?: string;
}
export interface ImmichAsset
{
    checksum: string;
    createdAt: string;
    deviceAssetId: string;
    deviceId: string,
    duplicateId?: string,
    duration: string,
    exifInfo?: any,
    fileCreatedAt: string;
    fileModifiedAt: string;
    hasMetadata: boolean,
    height?: number,
    id: string;
    isArchived: boolean,
    isEdited: boolean,
    isFavorite: boolean,
    isOffline: boolean,
    isTrashed: boolean;
    libraryId?: string,
    livePhotoVideoId?: string,
    localDateTime?: string,
    originalFileName: string;
    originalMimeType?: string,
    originalPath: string;
    owner?: any,
    ownerId: string,
    people?: any,
    resized?: boolean,
    stack?: any,
    tags?: any,
    thumbhash?: string,
    type: string,
    unassignedFaces?: any,
    updatedAt?: string,
    visibility: string,
    width?: number,

    fileSizeInByte: number;
}
export interface ImmichAlbumApiResponse
{
    id: string;
    albumName: string;
    description?: string;
    owner?: Record<string, unknown>;
    ownerId?: string;
    ownerName?: string;
    ownerEmail?: string;
    createdAt?: string;
    updatedAt?: string;
    albumUsers?: unknown[];
}
export interface ImmichAlbumBase
{
    id: string;
    albumName: string;
    description: string;
    ownerId?: string;
    ownerUsername?: string;
    ownerEmail?: string;
    createdAt?: string;
    updatedAt?: string;
    albumUsers?: ImmichAlbumUser[];
}
export interface ImmichAlbumDirectoryInfo extends ImmichAlbumBase
{
    assets?: ImmichAsset[];
    displayName?: string;
}
export interface ImmichDirectoryNode
{
    rawName: string; // original segment from albumName
    fsName: string; // normalized displayName segment
    children: Map<string, ImmichDirectoryNode>;
}
export interface ImmichAlbumsDirectoryNode extends ImmichDirectoryNode
{
    album?: ImmichAlbumDirectoryInfo;
    path_id: string;
    children: Map<string, ImmichAlbumsDirectoryNode>;
}
export interface ImmichTag
{
    id: string;
    name: string;
    value: string;
    color?: string;
    parentId?: string;
    updatedAt?: string;
    createdAt?: string;
}
export interface ImmichTagsDirectoryNode extends ImmichDirectoryNode
{
    tag?: ImmichTagDirectoryInfo;
    children: Map<string, ImmichTagsDirectoryNode>;
}
export interface ImmichTagDirectoryInfo extends ImmichTag
{
    assets?: ImmichAsset[];
    displayName?: string;
}

// Conditionals
export function isCurrentUserAlbumOwner(album: ImmichAlbumBase, currentUser: ImmichUser | null): boolean
{
    if (!currentUser)
    {
        return false;
    }

    if (album.ownerId && currentUser.id && album.ownerId === currentUser.id)
    {
        return true;
    }

    const currentCandidates = [currentUser.username, currentUser.email]
        .filter((value): value is string => Boolean(value))
        .map(value => value.toLowerCase());

    const ownerCandidates = [album.ownerUsername, album.ownerEmail]
        .filter((value): value is string => Boolean(value))
        .map(value => value.toLowerCase());

    return ownerCandidates.some(ownerCandidate => currentCandidates.includes(ownerCandidate));
}



// Getters
export function getDesecendantAlbums(node: ImmichAlbumsDirectoryNode, out: ImmichAlbumDirectoryInfo[]): void
{
    if (node.album) out.push(node.album);
    for (const child of node.children.values())
    {
        getDesecendantAlbums(child, out);
    }
}
export function getAlbumNormalizedName(segment: string, albumId: string): string
{
    return PathUtils.normalizeFolderDisplayName(segment, 'album', albumId);
}
export function getVirtualAlbumTree(albums: ImmichAlbumDirectoryInfo[]): ImmichAlbumsDirectoryNode
{
    const root: ImmichAlbumsDirectoryNode = {
        rawName: '',
        fsName: '',
        children: new Map(),
        path_id: "ROOT"
    };

    for (const album of albums)
    {
        // Use the REAL album name for structure
        const rawSegments = album.albumName.split(ImmichAlbumFolder.SEPERATOR).map(s => s.trim()).filter(Boolean);

        let node = root;

        for (const raw of rawSegments)
        {
            const fs = getAlbumNormalizedName(raw, album.id);

            if (!node.children.has(fs))
            {
                const childPathId = `${node.path_id}/${fs}`;
                node.children.set(fs, {
                    rawName: raw,
                    fsName: fs,
                    children: new Map(),
                    path_id: childPathId
                });
            }

            node = node.children.get(fs)!;
        }

        node.album = album;
    }

    return root;
}
export function getAlbumMtime(album: ImmichAlbumBase): number
{
    const updatedTimestamp = album.updatedAt ? new Date(album.updatedAt).getTime() : NaN;
    if (Number.isFinite(updatedTimestamp) && updatedTimestamp > 0)
    {
        return Math.floor(updatedTimestamp / 1000);
    }

    const createdTimestamp = album.createdAt ? new Date(album.createdAt).getTime() : NaN;
    if (Number.isFinite(createdTimestamp) && createdTimestamp > 0)
    {
        return Math.floor(createdTimestamp / 1000);
    }

    logger.warn('ImmichAlbumUtils', 'getAlbumMtime', 'warn', `Album '${album.albumName}' (ID: ${album.id}) has missing/invalid createdAt and updatedAt timestamps, using current time as mtime fallback.`);
    return DateUtils.getTimestampNow();
}
export function getTagMtime(album: ImmichTag): number
{
    const updatedTimestamp = album.updatedAt ? new Date(album.updatedAt).getTime() : NaN;
    if (Number.isFinite(updatedTimestamp) && updatedTimestamp > 0)
    {
        return Math.floor(updatedTimestamp / 1000);
    }

    const createdTimestamp = album.createdAt ? new Date(album.createdAt).getTime() : NaN;
    if (Number.isFinite(createdTimestamp) && createdTimestamp > 0)
    {
        return Math.floor(createdTimestamp / 1000);
    }

    logger.warn("ImmichTagUtils", "getTagMtime", `Tag '${album.value}' (ID: ${album.id}) has missing/invalid createdAt and updatedAt timestamps, using current time as mtime fallback.`)
    return DateUtils.getTimestampNow();
}
export function getVirtualTagTree(tags: ImmichTag[]): ImmichTagsDirectoryNode
{
    const root: ImmichTagsDirectoryNode = {
        rawName: '',
        fsName: '',
        children: new Map(),
    };

    // 1. Index tags by ID
    const byId = new Map<string, ImmichTagsDirectoryNode>();
    for (const tag of tags)
    {
        const fs = PathUtils.normalizeFolderDisplayName(tag.name, 'tag', tag.id);

        byId.set(tag.id, {
            rawName: tag.name,
            fsName: fs,
            children: new Map(),
            tag,
        });
    }

    // 2. Build hierarchy using parentId
    for (const tag of tags)
    {
        const node = byId.get(tag.id)!;

        if (tag.parentId && byId.has(tag.parentId))
        {
            // Attach to parent
            const parent = byId.get(tag.parentId)!;
            parent.children.set(node.fsName, node);
        } else
        {
            // No parent → attach to root
            root.children.set(node.fsName, node);
        }
    }

    return root;
}
export function getAssetMtime(asset: ImmichAsset): number
{
    // Prefer Immich server-maintained timestamps first, then fall back to uploaded file timestamps.
    const candidates = [asset.updatedAt, asset.createdAt, asset.fileModifiedAt, asset.fileCreatedAt];
    for (const value of candidates)
    {
        const timestamp = value ? new Date(value).getTime() : NaN;
        if (Number.isFinite(timestamp) && timestamp > 0)
        {
            return Math.floor(timestamp / 1000);
        }
    }

    logger.warn('ImmichAssetUtils', 'getAssetMtime', `Asset '${asset.originalFileName}' (ID: ${asset.id}) has missing/invalid timestamps, using current time fallback.`);
    return DateUtils.getTimestampNow();
}

// Mapping
export function mapAlbumUsers(rawAlbumUsers: unknown): ImmichAlbumUser[]
{
    if (!Array.isArray(rawAlbumUsers))
    {
        return [];
    }

    return rawAlbumUsers
        .map((albumUser: unknown): ImmichAlbumUser | null =>
        {
            if (!isObject(albumUser))
            {
                return null;
            }

            const userRaw = isObject(albumUser.user) ? albumUser.user : albumUser;
            if (!isObject(userRaw))
            {
                return null;
            }

            const userId = String(userRaw.id ?? albumUser.userId ?? '').trim();
            const username = extractUsername(userRaw);
            if (!userId || !username)
            {
                return null;
            }

            return {
                userId,
                username,
                role: String(albumUser.role ?? 'viewer'),
            };
        })
        .filter((entry): entry is ImmichAlbumUser => entry !== null);
}
export function mapTagFromApi(tag: any): ImmichTag
{
    return {
        id: tag.id,
        name: tag.name,
        value: tag.value,
        parentId: tag.parentId && typeof tag.parentId === 'string' ? tag.parentId : undefined,
        color: tag.color && typeof tag.color === 'string' ? tag.parentId : undefined,
        createdAt: typeof tag.updatedAt === 'string' ? tag.createdAt : undefined,
        updatedAt: typeof tag.updatedAt === 'string' ? tag.updatedAt : undefined,
    };
}
export function mapAlbumFromApi(item: ImmichAlbumApiResponse): ImmichAlbumBase
{
    const owner = isObject(item?.owner) ? item.owner : null;

    return {
        id: String(item.id),
        albumName: String(item.albumName),
        description: String(item.description ?? ''),
        ownerId: owner ? String(owner.id ?? '') : String(item.ownerId ?? ''),
        ownerUsername: owner ? extractUsername(owner) : String(item.ownerName ?? item.ownerEmail ?? ''),
        ownerEmail: owner ? String(owner.email ?? '') : String(item.ownerEmail ?? ''),
        createdAt: item.createdAt ? String(item.createdAt) : undefined,
        updatedAt: item.updatedAt ? String(item.updatedAt) : undefined,
        albumUsers: mapAlbumUsers(item.albumUsers),
    };
}
export function mapAssetFromApi(asset: any): ImmichAsset
{
    if (!asset.exifInfo?.fileSizeInByte)
    {
        logger.warn('ImmichAssetUtils', 'getAssetMtime', `Asset ${asset.originalFileName} (${asset.id}) has no exifInfo.fileSizeInByte, using 0 as fallback.`);
    }
    return {
        checksum: asset.checksum,
        createdAt: asset.createdAt,
        deviceAssetId: asset.deviceAssetId,
        deviceId: asset.deviceId,
        duplicateId: asset.duplicateId,
        duration: asset.duration,
        exifInfo: asset.exifInfo,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        hasMetadata: asset.hasMetadata,
        height: asset.height,
        id: asset.id,
        isArchived: asset.isArchived,
        isEdited: asset.isEdited,
        isFavorite: asset.isFavorite,
        isOffline: asset.isOffline,
        isTrashed: asset.isTrashed,
        libraryId: asset.libraryId,
        livePhotoVideoId: asset.livePhotoVideoId,
        localDateTime: asset.localDateTime,
        originalFileName: asset.originalFileName,
        originalMimeType: asset.originalMimeType,
        originalPath: asset.originalPath,
        owner: asset.owner,
        ownerId: asset.ownerId,
        people: asset.people,
        resized: asset.resized,
        stack: asset.stack,
        tags: asset.tags,
        thumbhash: asset.thumbhash,
        type: asset.type,
        unassignedFaces: asset.unassignedFaces,
        updatedAt: asset.updatedAt,
        visibility: asset.visibility,
        width: asset.width,

        fileSizeInByte: asset.exifInfo?.fileSizeInByte ?? 0,
    };
}
export function mapFilesFromAssets(assets: ImmichAsset[], parent: ImmichVirtualDirectory, reserved_names?: Set<string>): Array<ImmichVirtualAssetItem>
{
    function buildUniqueName(base: string, extension: string, reserved: Set<string>, nameCount: Map<string, number>): string
    {
        const actual_name = base + extension
        // Reserved → force collision immediately
        if (reserved.has(actual_name))
        {
            const count = nameCount.get(actual_name) ?? 0;
            nameCount.set(actual_name, count + 1);
            return `${base} (${count + 1})${extension}`;
        }

        // Normal collision logic
        let finalName = actual_name;
        let count = nameCount.get(finalName) ?? 0;

        if (count > 0)
        {
            do
            {
                count++;
                finalName = `${base} (${count})${extension}`;
            } while (reserved.has(finalName));
        }

        nameCount.set(actual_name, count + 1);
        return finalName;
    }

    const enableSidecars = config.assetSidecarsEnabled;

    const files = new Array<ImmichVirtualAssetItem>(enableSidecars ? assets.length * 2 : assets.length);
    const reservedNames = reserved_names ?? new Set<string>();
    const nameCount = new Map<string, number>();


    for (let i = 0; i < assets.length; i++)
    {

        const asset = assets[i];
        const [name, ext] = parent.file_system.getApi().getAssetDisplayName(asset);
        const finalName = buildUniqueName(name, ext, reservedNames, nameCount);


        const idx = enableSidecars ? i * 2 : i;
        files[idx] = new ImmichVirtualAssetFile(asset, finalName, parent, parent.file_system);
        if (enableSidecars) files[idx + 1] = new ImmichVirtualAssetSidecar(asset, finalName + ".xmp", parent, parent.file_system);
    }

    return files;
}

// Searching
export function findAlbumNode(root: ImmichAlbumsDirectoryNode, predicate: (node: ImmichAlbumsDirectoryNode) => boolean): ImmichAlbumsDirectoryNode | null
{
    if (predicate(root)) return root;

    for (const child of root.children.values())
    {
        const found = findAlbumNode(child, predicate);
        if (found) return found;
    }

    return null;
}

// Updating
export function applyAlbumDetails(album: ImmichAlbumBase, details: unknown): void
{
    if (!isObject(details))
    {
        return;
    }

    const owner = isObject(details.owner) ? details.owner : null;

    album.description = String(details.description ?? album.description ?? '');
    album.ownerId = owner ? String(owner.id ?? album.ownerId ?? '') : String(details.ownerId ?? album.ownerId ?? '');
    album.ownerUsername = owner ? extractUsername(owner) : String(details.ownerName ?? details.ownerEmail ?? album.ownerUsername ?? '');
    album.ownerEmail = owner ? String(owner.email ?? album.ownerEmail ?? '') : String(details.ownerEmail ?? album.ownerEmail ?? '');
    album.createdAt = details.createdAt ? String(details.createdAt) : album.createdAt;
    album.updatedAt = details.updatedAt ? String(details.updatedAt) : album.updatedAt;
    album.albumUsers = mapAlbumUsers(details.albumUsers);
}

// Extracting
export function extractCurrentUser(rawUser: unknown, fallbackUsername: string): ImmichUser
{
    if (!isObject(rawUser))
    {
        return {
            id: '',
            username: fallbackUsername,
            email: fallbackUsername,
        };
    }

    const usernameCandidate = extractUsername(rawUser) || fallbackUsername;
    return {
        id: String(rawUser.id ?? ''),
        username: usernameCandidate,
        email: String(rawUser.email ?? fallbackUsername),
    };
}
export function extractUsername(user: Record<string, unknown>): string
{
    return String(user.name ?? user.username ?? user.email ?? user.id ?? '').trim();
}








