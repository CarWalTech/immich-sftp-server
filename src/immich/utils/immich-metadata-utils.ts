import YAML from 'yaml';
import { isObject } from '../../utils/common-utils';
import { ImmichAPI } from '../immich-api';
import { ImmichTagDirectoryInfo } from "./immich-api-utils";
import { ImmichAlbumBase, ImmichAlbumUser, ImmichUser, isCurrentUserAlbumOwner } from './immich-api-utils';


// Exported Constants
export const TAG_METADATA_FILE_NAME = 'tag.yaml';
export const ALBUM_METADATA_FILE_NAME = 'album.yaml';
export const ALBUM_BROWSER_LINK_FILE_NAME = 'immich.html';

// Constants
const NOSYNC_TAG = '#nosync';
const NOSYNC_TAG_REGEX = /(?:^|\s)#nosync(?:\s|$)/g;
const NOSYNC_TAG_MATCH_REGEX = /(?:^|\s)#nosync(?:\s|$)/;

// Types
type ImmichRequestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type ImmichRequestFn = (args: ImmichRequestArgs) => Promise<any>;
type RefreshAlbumAssetsFn = (album: AlbumVirtualFileAlbum) => Promise<void>;

// Interfaces
export interface AlbumVirtualFileAlbum extends ImmichAlbumBase
{
    albumUsers?: ImmichAlbumUser[];
}
export interface AlbumMetadataSharedUser
{
    userId?: string;
    username: string;
    role: string;
}
export interface AlbumMetadataDocument
{
    schemaVersion: number;
    album: {
        id: string;
        name: string;
        description: string;
        ownerUsername?: string;
        ownerId?: string;
        createdAt?: string;
        updatedAt?: string;
    };
    sharing: {
        canEditSharedUsers: boolean;
        sharedUsers: AlbumMetadataSharedUser[];
    };
    settings: {
        hidden: boolean;
    };
    links: {
        immichWeb: string;
    };
}
export interface AlbumMetadataAlbumInput
{
    id: string;
    name: string;
    description?: string;
    ownerUsername?: string;
    ownerId?: string;
    createdAt?: string;
    updatedAt?: string;
    sharedUsers?: AlbumMetadataSharedUser[];
}
export interface ImmichRequestArgs
{
    method: ImmichRequestMethod;
    endpoint: string;
    data?: any;
    logAction: string;
    respAsStream?: boolean;
    skipResponseLog?: boolean;
}
export interface ImmichApplyMetadataFn
{
    album: AlbumVirtualFileAlbum;
    content: string;
    currentUser: ImmichUser | null;
    baseUrl: string;
    immichAPI: ImmichAPI;
}

// Classes
export class AlbumMetadataDocumentUtils
{
    static async updateAlbumSharing(immichRequest: ImmichRequestFn, album: AlbumVirtualFileAlbum, sharedUsers: AlbumMetadataSharedUser[]): Promise<void>
    {
        const existingUsers = album.albumUsers ?? [];
        const byUserId = new Map(existingUsers.map(user => [user.userId, user]));
        const byUsername = new Map(existingUsers.map(user => [user.username.toLowerCase(), user]));

        const updatedSharedUsers: Array<{ userId: string; role: string }> = [];
        for (const sharedUser of sharedUsers)
        {
            const normalizedName = sharedUser.username.trim().toLowerCase();
            const existing = (sharedUser.userId && byUserId.get(sharedUser.userId)) || byUsername.get(normalizedName);

            if (!existing)
            {
                throw new Error(`Blocked save: shared user '${sharedUser.username}' is not currently shared on this album. Add new users in the Immich UI before editing their role here.`);
            }

            updatedSharedUsers.push({
                userId: existing.userId,
                role: sharedUser.role,
            });
        }

        await immichRequest({
            method: 'PUT',
            endpoint: `albums/${album.id}/users`,
            data: JSON.stringify({ albumUsers: updatedSharedUsers }),
            logAction: 'Update album sharing',
        });

        album.albumUsers = updatedSharedUsers.map(user =>
        {
            const existing = byUserId.get(user.userId);
            return {
                userId: user.userId,
                username: existing?.username ?? user.userId,
                role: user.role,
            };
        });
    }
    static getChangedImmutableAlbumMetadataFields(current: AlbumMetadataDocument, next: AlbumMetadataDocument): string[]
    {
        const changedImmutableFields: string[] = [];
        if (next.schemaVersion !== current.schemaVersion) changedImmutableFields.push('schemaVersion');
        if (next.album.id !== current.album.id) changedImmutableFields.push('album.id');
        if (next.album.ownerUsername !== current.album.ownerUsername) changedImmutableFields.push('album.ownerUsername');
        if (next.album.ownerId !== current.album.ownerId) changedImmutableFields.push('album.ownerId');
        if (next.links.immichWeb !== current.links.immichWeb) changedImmutableFields.push('links.immichWeb');
        return changedImmutableFields;
    }
    static sameSharedUsers(a: AlbumMetadataSharedUser[], b: AlbumMetadataSharedUser[]): boolean
    {
        if (a.length !== b.length)
        {
            return false;
        }

        const normalize = (entries: AlbumMetadataSharedUser[]) => entries
            .map(entry => ({
                userId: (entry.userId ?? '').toLowerCase(),
                username: entry.username.toLowerCase(),
                role: entry.role.toLowerCase(),
            }))
            .sort((left, right) =>
            {
                const byUserId = left.userId.localeCompare(right.userId);
                if (byUserId !== 0)
                {
                    return byUserId;
                }

                const byUsername = left.username.localeCompare(right.username);
                if (byUsername !== 0)
                {
                    return byUsername;
                }

                return left.role.localeCompare(right.role);
            });

        const left = normalize(a);
        const right = normalize(b);
        return left.every((entry, index) =>
            entry.userId === right[index].userId
            && entry.username === right[index].username
            && entry.role === right[index].role
        );
    }
    static hasNoSyncTag(description: string | undefined): boolean
    {
        return NOSYNC_TAG_MATCH_REGEX.test(description ?? '');
    }
    static stripNoSyncTag(description: string): string
    {
        return description
            .replace(NOSYNC_TAG_REGEX, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    static mergeNoSyncTag(descriptionText: string, hidden: boolean): string
    {
        const cleaned = this.stripNoSyncTag(descriptionText);
        if (!hidden)
        {
            return cleaned;
        }

        return cleaned ? `${cleaned} ${NOSYNC_TAG}` : NOSYNC_TAG;
    }



    static escapeHtml(value: string): string
    {
        return value
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }
}

// Build Functions
export function buildAlbumMetadataYamlForAlbum(album: AlbumVirtualFileAlbum, currentUser: ImmichUser | null, baseUrl: string): string
{
    return buildAlbumMetadataYaml({
        id: album.id,
        name: album.albumName,
        description: album.description,
        ownerUsername: album.ownerUsername,
        ownerId: album.ownerId,
        createdAt: album.createdAt,
        updatedAt: album.updatedAt,
        sharedUsers: album.albumUsers,
    }, isCurrentUserAlbumOwner(album, currentUser), baseUrl);
}
export function buildAlbumBrowserLinkForAlbum(album: AlbumVirtualFileAlbum, baseUrl: string): string
{
    return buildAlbumBrowserLink(baseUrl, album.id);
}
export function buildAlbumMetadataDocument(album: AlbumMetadataAlbumInput, canEditSharedUsers: boolean, baseUrl: string): AlbumMetadataDocument
{
    return {
        schemaVersion: 1,
        album: {
            id: album.id,
            name: album.name,
            description: AlbumMetadataDocumentUtils.stripNoSyncTag(album.description ?? ''),
            ownerUsername: album.ownerUsername ?? '',
            ownerId: album.ownerId ?? '',
            createdAt: album.createdAt,
            updatedAt: album.updatedAt,
        },
        sharing: {
            canEditSharedUsers,
            sharedUsers: (album.sharedUsers ?? []).map(user => ({
                userId: user.userId,
                username: user.username,
                role: user.role,
            })),
        },
        settings: {
            hidden: AlbumMetadataDocumentUtils.hasNoSyncTag(album.description),
        },
        links: {
            immichWeb: `${baseUrl}/albums/${album.id}`,
        },
    };
}
export function buildAlbumDocument(album: AlbumVirtualFileAlbum, currentUser: ImmichUser | null, baseUrl: string)
{
    return buildAlbumMetadataDocument({
        id: album.id,
        name: album.albumName,
        description: album.description,
        ownerUsername: album.ownerUsername,
        ownerId: album.ownerId,
        createdAt: album.createdAt,
        updatedAt: album.updatedAt,
        sharedUsers: album.albumUsers,
    }, isCurrentUserAlbumOwner(album, currentUser), baseUrl);
}
export function buildAlbumMetadataYaml(album: AlbumMetadataAlbumInput, canEditSharedUsers: boolean, baseUrl: string): string
{
    return YAML.stringify(buildAlbumMetadataDocument(album, canEditSharedUsers, baseUrl));
}
export function buildAlbumBrowserLink(baseUrl: string, albumId: string): string
{
    const url = `${baseUrl}/albums/${albumId}`;
    const safeUrl = AlbumMetadataDocumentUtils.escapeHtml(url);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${safeUrl}">
  <title>Open album in Immich</title>
</head>
<body>
  <p>Opening album… If not redirected, <a href="${safeUrl}">click here</a>.</p>
  <script>window.location.replace(${JSON.stringify(url)});</script>
</body>
</html>
`;
}
export function buildTagMetadataYamlForTag(tag: ImmichTagDirectoryInfo, currentUser: ImmichUser | null, baseUrl: string): string
{
    let metadata: Array<string> = [
        `id: ${JSON.stringify(tag.id)}`,
        `name: ${JSON.stringify(tag.name)}`,
        `value: ${JSON.stringify(tag.value)}`,
    ];

    return metadata.join('\n');
}

// Validation Functions
export function validateAlbumMetadataDocument(input: Record<string, unknown>): AlbumMetadataDocument
{
    if (!isObject(input.album) || !isObject(input.sharing) || !isObject(input.settings) || !isObject(input.links))
    {
        throw new Error('Invalid album.yaml: missing required root sections (album, sharing, settings, links).');
    }

    const sharedUsersInput = Array.isArray(input.sharing.sharedUsers) ? input.sharing.sharedUsers : [];
    const sharedUsers: AlbumMetadataSharedUser[] = sharedUsersInput.map((user, index) =>
    {
        if (!isObject(user))
        {
            throw new Error(`Invalid album.yaml: sharing.sharedUsers[${index}] must be an object.`);
        }

        const username = String(user.username ?? '').trim();
        const role = String(user.role ?? '').trim();
        const userId = user.userId == null ? undefined : String(user.userId).trim();

        if (!username)
        {
            throw new Error(`Invalid album.yaml: sharing.sharedUsers[${index}].username is required.`);
        }
        if (!role)
        {
            throw new Error(`Invalid album.yaml: sharing.sharedUsers[${index}].role is required.`);
        }

        return { userId, username, role };
    });

    return {
        schemaVersion: Number(input.schemaVersion),
        album: {
            id: String(input.album.id ?? ''),
            name: String(input.album.name ?? ''),
            description: String(input.album.description ?? ''),
            ownerUsername: String(input.album.ownerUsername ?? ''),
            ownerId: String(input.album.ownerId ?? ''),
            createdAt: input.album.createdAt ? String(input.album.createdAt) : undefined,
            updatedAt: input.album.updatedAt ? String(input.album.updatedAt) : undefined,
        },
        sharing: {
            canEditSharedUsers: Boolean(input.sharing.canEditSharedUsers),
            sharedUsers,
        },
        settings: {
            // Accept both 'hidden' (current) and 'hiddenFromSftp' (legacy) for backward compatibility.
            hidden: Boolean(input.settings?.hidden ?? input.settings?.hiddenFromSftp),
        },
        links: {
            immichWeb: String(input.links.immichWeb ?? ''),
        },
    };
}
export function validateAlbumMetadataDocumentYaml(content: string): AlbumMetadataDocument
{
    const parsed = YAML.parse(content);
    if (!isObject(parsed))
    {
        throw new Error('Invalid album.yaml: expected a YAML object.');
    }

    return validateAlbumMetadataDocument(parsed);
}

// Save Functions
export async function saveAlbumMetadataFileContent({ album, content, currentUser, baseUrl, immichAPI }: ImmichApplyMetadataFn): Promise<void>
{
    const metadata = validateAlbumMetadataDocumentYaml(content);
    const current = buildAlbumDocument(album, currentUser, baseUrl);

    const changedImmutableFields = AlbumMetadataDocumentUtils.getChangedImmutableAlbumMetadataFields(current, metadata);
    if (changedImmutableFields.length > 0) throw new Error(`Blocked save: immutable album.yaml fields were modified (${changedImmutableFields.join(', ')}).`);

    if (!isCurrentUserAlbumOwner(album, currentUser)) throw new Error('Blocked save: only the album owner can edit album.yaml.');

    const newAlbumName = metadata.album.name.trim();
    if (newAlbumName && newAlbumName !== album.albumName)
    {
        await immichAPI.callApi({
            method: 'PATCH',
            endpoint: `albums/${album.id}`,
            data: JSON.stringify({ albumName: newAlbumName }),
            logAction: 'Rename album via album.yaml',
        });
        album.albumName = newAlbumName;
    }

    const newDescription = AlbumMetadataDocumentUtils.mergeNoSyncTag(metadata.album.description, metadata.settings.hidden);
    if ((album.description ?? '') !== newDescription)
    {
        await immichAPI.callApi({
            method: 'PATCH',
            endpoint: `albums/${album.id}`,
            data: JSON.stringify({ description: newDescription }),
            logAction: 'Update album description/settings',
        });
        album.description = newDescription;
    }

    if (!AlbumMetadataDocumentUtils.sameSharedUsers(current.sharing.sharedUsers, metadata.sharing.sharedUsers))
    {
        await AlbumMetadataDocumentUtils.updateAlbumSharing(immichAPI.callApi, album, metadata.sharing.sharedUsers);
    }
}








