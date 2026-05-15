import { isObject } from "../../utils/common-utils";
import { PathUtils } from "../../utils/path-utils";
import { ImmichAlbumFolder } from "../collections/immich-album-folder";
import { ImmichVirtualDirectory } from "../collections/immich-virtual-directory";
import { ImmichVirtualAssetFile } from "../collections/immich-virtual-asset-file";
import { ImmichAPI } from "../immich-api";
import { ImmichAsset, ImmichAssetUtils } from "./immich-asset-utils";
import { logger } from "../../logger";
import { ImmichTagFolder } from "../collections/immich-tag-folder";

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
export interface ImmichAlbumsDirectoryNode
{
    rawName: string; // original segment from albumName
    fsName: string; // normalized displayName segment
    children: Map<string, ImmichAlbumsDirectoryNode>;
    album?: ImmichAlbumDirectoryInfo;
    path_id: string
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
export interface ImmichTagsDirectoryNode
{
    rawName: string; // original segment from albumName
    fsName: string; // normalized displayName segment
    children: Map<string, ImmichTagsDirectoryNode>;
    tag?: ImmichTagDirectoryInfo;
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

// Collectors
function buildUniqueName(base: string, reserved: Set<string>, nameCount: Map<string, number>): string
{
    // Reserved → force collision immediately
    if (reserved.has(base))
    {
        const count = nameCount.get(base) ?? 0;
        nameCount.set(base, count + 1);
        return `${base} (${count + 1})`;
    }

    // Normal collision logic
    let finalName = base;
    let count = nameCount.get(finalName) ?? 0;

    if (count > 0)
    {
        do
        {
            count++;
            finalName = `${base} (${count})`;
        } while (reserved.has(finalName));
    }

    nameCount.set(base, count + 1);
    return finalName;
}

export async function collectAlbumAssets(album_folder: ImmichAlbumFolder, reserved_names: Set<string>): Promise<ImmichVirtualAssetFile[]>
{
    const node_data = album_folder.get_album_data();
    if (!node_data.album) return [];

    const album = node_data.album;
    const albumId = album.id;

    // 1. Check cache
    const cached = album_folder.file_system.getCache().albumAssetListings.get(albumId);
    if (cached) return cached;

    // 2. Ensure album assets are loaded (cachedFetch handles this)
    await album_folder.file_system.getApi().FETCH_AssetsForAlbum(album);

    const assets = album.assets ?? [];
    const files = new Array<ImmichVirtualAssetFile>(assets.length);
    const nameCount = new Map<string, number>();

    for (let i = 0; i < assets.length; i++)
    {
        const asset = assets[i];
        const finalName = buildUniqueName(ImmichAssetUtils.buildPreferredAssetName(asset), reserved_names, nameCount);

        files[i] = new ImmichVirtualAssetFile(
            asset,
            finalName,
            album_folder,
            album_folder.file_system
        );
    }

    // 3. Store in cache
    album_folder.file_system.getCache().albumAssetListings.set(albumId, files);

    return files;
}
export async function collectUnsortedAssets(source_folder: ImmichVirtualDirectory, reserved_names: Set<string>): Promise<ImmichVirtualAssetFile[]>
{
    const cacheKey = "__unsorted_assets__";

    // 1. Check cache
    const cached = source_folder.file_system.getCache().albumAssetListings.get(cacheKey);
    if (cached) return cached;

    // 2. Fetch (cachedFetch handles metadata)
    const assets = await source_folder.file_system.getApi().FETCH_AssetsForNonAlbums();

    const files = new Array<ImmichVirtualAssetFile>(assets.length);
    const nameCount = new Map<string, number>();

    for (let i = 0; i < assets.length; i++)
    {
        const asset = assets[i];
        const finalName = buildUniqueName(ImmichAssetUtils.buildPreferredAssetName(asset), reserved_names, nameCount);

        files[i] = new ImmichVirtualAssetFile(
            asset,
            finalName,
            source_folder,
            source_folder.file_system
        );
    }

    // 3. Store in cache
    source_folder.file_system.getCache().albumAssetListings.set(cacheKey, files);

    return files;
}
export async function collectTrashedAssets(source_folder: ImmichVirtualDirectory, reserved_names: Set<string>): Promise<ImmichVirtualAssetFile[]>
{
    const cacheKey = "__trashed_assets__";

    // 1. Check cache
    const cached = source_folder.file_system.getCache().albumAssetListings.get(cacheKey);
    if (cached) return cached;

    // 2. Fetch (cachedFetch handles metadata)
    const assets = await source_folder.file_system.getApi().FETCH_AssetsForTrash();

    const files = new Array<ImmichVirtualAssetFile>(assets.length);
    const nameCount = new Map<string, number>();

    for (let i = 0; i < assets.length; i++)
    {
        const asset = assets[i];
        const finalName = buildUniqueName(ImmichAssetUtils.buildPreferredAssetName(asset), reserved_names, nameCount);

        files[i] = new ImmichVirtualAssetFile(
            asset,
            finalName,
            source_folder,
            source_folder.file_system
        );
    }

    // 3. Store in cache
    source_folder.file_system.getCache().albumAssetListings.set(cacheKey, files);

    return files;
}
export async function collectTaggedAssets(source: ImmichTagFolder, reserved_names: Set<string>): Promise<ImmichVirtualAssetFile[]>
{

    if (!source.node_data.tag) return [];

    const tag = source.node_data.tag;
    const cacheKey = `tag_assets_${tag.id}`;

    // 1. Check cache
    const cached = source.file_system.getCache().albumAssetListings.get(cacheKey);
    if (cached) return cached;

    // 2. Fetch (cachedFetch handles metadata)
    await source.file_system.getApi().FETCH_AssetsForTag(tag);

    const assets = tag.assets ?? [];
    const files = new Array<ImmichVirtualAssetFile>(assets.length);
    const nameCount = new Map<string, number>();

    for (let i = 0; i < assets.length; i++)
    {
        const asset = assets[i];
        const finalName = buildUniqueName(ImmichAssetUtils.buildPreferredAssetName(asset), reserved_names, nameCount);

        files[i] = new ImmichVirtualAssetFile(
            asset,
            finalName,
            source,
            source.file_system
        );
    }

    // 3. Store in cache
    source.file_system.getCache().albumAssetListings.set(cacheKey, files);

    return files;
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
export function getAlbumMtime(album: Pick<ImmichAlbumBase, 'id' | 'albumName' | 'createdAt' | 'updatedAt'>): number
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
    return Math.floor(Date.now() / 1000);
}
export function getTagMtime(album: Pick<ImmichTag, 'id' | 'value' | 'createdAt' | 'updatedAt'>): number
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
    return Math.floor(Date.now() / 1000);
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







