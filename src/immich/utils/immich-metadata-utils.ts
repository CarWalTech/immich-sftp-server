import fs from 'fs';
import YAML from 'yaml';
import { isObject } from '../../utils/common-utils';
import { ImmichAPI } from '../immich-api';
import { ImmichAsset, ImmichTagDirectoryInfo } from "./immich-api-utils";
import { ImmichAlbumBase, ImmichAlbumUser, ImmichUser, isCurrentUserAlbumOwner } from './immich-api-utils';
import { ImmichFileSystem } from '../immich-file-system';
import { config } from '../../config';
import Builder from 'fast-xml-builder';
import { XMPUtils } from '../../utils/xmp-utils';

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
    static async updateAlbumSharing(api: ImmichAPI, album: AlbumVirtualFileAlbum, sharedUsers: AlbumMetadataSharedUser[]): Promise<void>
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

        await api.SERVER_UpdateAlbumSharing(album, { albumUsers: updatedSharedUsers })


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

// Generation Functions
export function generateAlbumBrowserLink(baseUrl: string, albumId: string): string
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
export function generateAlbumMetadataDocument(album: AlbumMetadataAlbumInput, canEditSharedUsers: boolean, baseUrl: string): AlbumMetadataDocument
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
export function generateAlbumMetadataUserDocument(album: AlbumVirtualFileAlbum, currentUser: ImmichUser | null, baseUrl: string)
{
    return generateAlbumMetadataDocument({
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
export function generateAssetMetadataDocument(asset: ImmichAsset, existingSidecar: string | null): string
{
    const exif = asset.exifInfo ?? {};

    // Immich data — Immich wins over sidecar for shared fields
    const immichDescription = typeof exif.description === 'string' ? exif.description : '';
    const immichCreateDate = exif.dateTimeOriginal ?? asset.fileCreatedAt ?? '';
    const lat = typeof exif.latitude === 'number' ? exif.latitude : undefined;
    const lon = typeof exif.longitude === 'number' ? exif.longitude : undefined;
    const make = typeof exif.make === 'string' ? exif.make : '';
    const model = typeof exif.model === 'string' ? exif.model : '';
    const city = typeof exif.city === 'string' ? exif.city : '';
    const state = typeof exif.state === 'string' ? exif.state : '';
    const country = typeof exif.country === 'string' ? exif.country : '';

    const immichTags: string[] = Array.isArray(asset.tags)
        ? asset.tags.filter(t => t?.value).map(t => String(t.value))
        : [];

    const immichPeople: string[] = Array.isArray(asset.people)
        ? asset.people.filter(p => p?.name).map(p => String(p.name))
        : [];

    // Merge: start with Immich data, sidecar fills missing fields
    let description = immichDescription;
    let subjects = [...immichTags];
    let hierarchical = XMPUtils.buildHierarchical(immichTags);
    let rating: string | undefined;

    if (existingSidecar)
    {
        const desc = XMPUtils.getDescNode(XMPUtils.parseSidecar(existingSidecar));

        if (!description)
            description = XMPUtils.extractAltText(desc, 'dc:description') ?? '';

        if (subjects.length === 0)
        {
            subjects = XMPUtils.extractListValues(desc, 'dc:subject');
            hierarchical = XMPUtils.extractListValues(desc, 'lr:hierarchicalSubject');
        }

        rating = XMPUtils.extractSimpleValue(desc, 'xmp:Rating');
    }

    for (const name of immichPeople)
        if (!subjects.includes(name)) subjects.push(name);

    // Build the rdf:Description node
    const hasGPS = lat !== undefined && lon !== undefined;
    const hasCamera = !!(make || model);
    const hasLocation = !!(city || state || country);

    const descNode: Record<string, any> = {
        '@_rdf:about': '',
        '@_xmlns:dc': 'http://purl.org/dc/elements/1.1/',
        '@_xmlns:xmp': 'http://ns.adobe.com/xap/1.0/',
        '@_xmlns:lr': 'http://ns.adobe.com/lightroom/1.0/',
    };

    if (hasGPS) descNode['@_xmlns:exif'] = 'http://ns.adobe.com/exif/1.0/';
    if (hasCamera) descNode['@_xmlns:tiff'] = 'http://ns.adobe.com/tiff/1.0/';
    if (hasLocation) descNode['@_xmlns:photoshop'] = 'http://ns.adobe.com/photoshop/1.0/';

    if (description)
        descNode['dc:description'] = {
            'rdf:Alt': { 'rdf:li': [{ '@_xml:lang': 'x-default', '#text': description }] }
        };

    if (rating !== undefined) descNode['xmp:Rating'] = rating;
    if (immichCreateDate) descNode['xmp:CreateDate'] = immichCreateDate;

    if (make) descNode['tiff:Make'] = make;
    if (model) descNode['tiff:Model'] = model;

    if (hasGPS)
    {
        descNode['exif:GPSLatitude'] = XMPUtils.formatGPS(lat!, 'N', 'S');
        descNode['exif:GPSLongitude'] = XMPUtils.formatGPS(lon!, 'E', 'W');
    }

    if (city) descNode['photoshop:City'] = city;
    if (state) descNode['photoshop:State'] = state;
    if (country) descNode['photoshop:Country'] = country;

    if (subjects.length > 0)
        descNode['dc:subject'] = { 'rdf:Bag': { 'rdf:li': subjects } };

    if (hierarchical.length > 0)
        descNode['lr:hierarchicalSubject'] = { 'rdf:Bag': { 'rdf:li': hierarchical } };

    const doc = {
        'x:xmpmeta': {
            '@_xmlns:x': 'adobe:ns:meta/',
            'rdf:RDF': {
                '@_xmlns:rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
                'rdf:Description': descNode,
            },
        },
    };

    const builder = new Builder(XMPUtils.BUILDER_OPTIONS);
    const xml: string = builder.build(doc);
    return `<?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?>\n${xml}\n<?xpacket end='w'?>`;
}

// Build Functions
export function buildAlbumBrowserLink(album: AlbumVirtualFileAlbum, baseUrl: string): string
{
    return generateAlbumBrowserLink(baseUrl, album.id);
}
export function buildAlbumMetadataYaml(album: AlbumMetadataAlbumInput, canEditSharedUsers: boolean, baseUrl: string): string
{
    return YAML.stringify(generateAlbumMetadataDocument(album, canEditSharedUsers, baseUrl));
}
export function buildAlbumMetadataUserYaml(album: AlbumVirtualFileAlbum, currentUser: ImmichUser | null, baseUrl: string): string
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
export function buildAssetMetadataXMP(asset: ImmichAsset, existingSidecar: string | null): string
{
    return generateAssetMetadataDocument(asset, existingSidecar);
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
    const current = generateAlbumMetadataUserDocument(album, currentUser, baseUrl);

    const changedImmutableFields = AlbumMetadataDocumentUtils.getChangedImmutableAlbumMetadataFields(current, metadata);
    if (changedImmutableFields.length > 0) throw new Error(`Blocked save: immutable album.yaml fields were modified (${changedImmutableFields.join(', ')}).`);

    if (!isCurrentUserAlbumOwner(album, currentUser)) throw new Error('Blocked save: only the album owner can edit album.yaml.');

    const newAlbumName = metadata.album.name.trim();
    if (newAlbumName && newAlbumName !== album.albumName)
    {
        await immichAPI.SERVER_UpdateAlbum(album, { albumName: newAlbumName }, 'Rename album via album.yaml');
        album.albumName = newAlbumName;
    }

    const newDescription = AlbumMetadataDocumentUtils.mergeNoSyncTag(metadata.album.description, metadata.settings.hidden);
    if ((album.description ?? '') !== newDescription)
    {
        await immichAPI.SERVER_UpdateAlbum(album, { description: newDescription }, 'Update album description/settings');
        album.description = newDescription;
    }

    if (!AlbumMetadataDocumentUtils.sameSharedUsers(current.sharing.sharedUsers, metadata.sharing.sharedUsers))
    {
        await AlbumMetadataDocumentUtils.updateAlbumSharing(immichAPI, album, metadata.sharing.sharedUsers);
    }
}
export async function saveAssetMetadataFileContent(asset: ImmichAsset, contents: string, api: ImmichAPI): Promise<void>
{
    async function _syncAssetTagsFromXmp(asset: ImmichAsset, newTagValues: string[], api: ImmichAPI): Promise<void>
    {
        const currentTagIds = new Set<string>(
            Array.isArray(asset.tags) ? asset.tags.map((t: any) => String(t.id)).filter(Boolean) : []
        );

        // Nothing to do if the asset has no tags and the XMP has no tags
        if (currentTagIds.size === 0 && newTagValues.length === 0) return;

        const allTags = await api.FETCH_Tags();

        // Resolve each XMP tag value to an existing or newly created Immich tag
        const targetTagIds = new Set<string>();
        for (const value of newTagValues)
        {
            const existing = allTags.find(t => t.value === value || t.name === value);
            if (existing)
            {
                targetTagIds.add(existing.id);
            }
            else
            {
                const created = await api.SERVER_CreateTag(value);
                if (created?.id) targetTagIds.add(String(created.id));
            }
        }

        const toAdd = [...targetTagIds].filter(id => !currentTagIds.has(id));
        const toRemove = [...currentTagIds].filter(id => !targetTagIds.has(id));

        if (toAdd.length > 0)
            await api.SERVER_AddAssetsToTags(asset.id, toAdd)

        if (toRemove.length > 0)
            await api.SERVER_RemoveAssetsFromTags(asset.id, toRemove)
    }

    const desc = XMPUtils.getDescNode(XMPUtils.parseSidecar(contents));

    // --- Extract fields per Immich XMP priority rules ---

    // Description: dc:description > tiff:ImageDescription
    const newDescription =
        XMPUtils.extractAltText(desc, 'dc:description') ??
        XMPUtils.extractSimpleValue(desc, 'tiff:ImageDescription');

    // Rating: xmp:Rating (0–5)
    const ratingStr = XMPUtils.extractSimpleValue(desc, 'xmp:Rating');
    const newRating = ratingStr !== undefined ? Number(ratingStr) : undefined;

    // Date: Immich priority order (docs.immich.app/features/xmp-sidecars)
    const newDate =
        XMPUtils.extractSimpleValue(desc, 'exif:SubSecDateTimeOriginal') ??
        XMPUtils.extractSimpleValue(desc, 'exif:DateTimeOriginal') ??
        XMPUtils.extractSimpleValue(desc, 'xmp:SubSecCreateDate') ??
        XMPUtils.extractSimpleValue(desc, 'xmp:CreateDate') ??
        XMPUtils.extractSimpleValue(desc, 'xmp:CreationDate') ??
        XMPUtils.extractSimpleValue(desc, 'xmp:MediaCreateDate') ??
        XMPUtils.extractSimpleValue(desc, 'xmp:SubSecMediaCreateDate') ??
        XMPUtils.extractSimpleValue(desc, 'xmp:DateTimeCreated');

    // GPS: exif:GPSLatitude / exif:GPSLongitude
    const newLat = XMPUtils.parseGPS(XMPUtils.extractSimpleValue(desc, 'exif:GPSLatitude') ?? '');
    const newLon = XMPUtils.parseGPS(XMPUtils.extractSimpleValue(desc, 'exif:GPSLongitude') ?? '');

    // Tags: Immich priority = digiKam:TagsList > lr:hierarchicalSubject > dc:subject
    const newTagValues = [...new Set([
        ...XMPUtils.extractListValues(desc, 'digiKam:TagsList'),
        ...XMPUtils.extractListValues(desc, 'lr:hierarchicalSubject'),
        ...XMPUtils.extractListValues(desc, 'dc:subject'),
    ])];

    // --- Patch asset scalar fields (only send changed values) ---
    const exif = asset.exifInfo ?? {};
    const patch: Record<string, unknown> = {};

    if (newDescription !== undefined && newDescription !== (exif.description ?? ''))
        patch.description = newDescription;

    if (newRating !== undefined && Number.isFinite(newRating) && newRating >= 0 && newRating <= 5)
        patch.rating = Math.round(newRating);

    if (newDate !== undefined)
        patch.dateTimeOriginal = newDate;

    if (newLat !== undefined && newLat !== exif.latitude)
        patch.latitude = newLat;

    if (newLon !== undefined && newLon !== exif.longitude)
        patch.longitude = newLon;

    if (Object.keys(patch).length > 0)
    {
        await api.SERVER_UpdateAsset(asset.id, patch)
    }

    // --- Sync tags ---
    await _syncAssetTagsFromXmp(asset, newTagValues, api);

    // --- Write XMP back to local sidecar if local-files mode is enabled ---
    if (config.enableLocalFiles)
    {
        const filepath = "/immich" + asset.originalPath + ".xmp";
        await fs.promises.writeFile(filepath, contents, 'utf8');
    }
}










