import Builder from 'fast-xml-builder';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import tmp from 'tmp';
import { exiftool } from 'exiftool-vendored';
import YAML from 'yaml';
import { config } from '../../config';
import { isObject } from '../../utils/common-utils';
import { VirtualContentBuffer } from '../../filesystem/virtual-content-buffer';
import { XMPUtils } from '../../utils/xmp-utils';
import { ImmichAPI } from '../immich-api';
import { ImmichAlbumBase, ImmichAlbumUser, ImmichAsset, ImmichUser, isCurrentUserAlbumOwner } from "./immich-api-utils";
import { logger } from '../../logger';

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
    return generateBrowserLink(url, "Open album in Immich")
}
export function generateTrashBrowserLink(baseUrl: string): string
{
    const url = `${baseUrl}/trash`;
    return generateBrowserLink(url, "Open trash in Immich")
}
export function generateBrowserLink(url: string, title: string): string
{
    const safeUrl = AlbumMetadataDocumentUtils.escapeHtml(url);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="0;url=${safeUrl}">
  <title>${title}</title>
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
// Tag-related sidecar fields that Immich always owns — stripped before applying Immich data.
// dc:subject, lr:hierarchicalSubject and digiKam:TagsList are regenerated below from Immich's
// tag list; the rest (MicrosoftPhoto/acdsee/mediapro) are dropped with no replacement since
// nothing currently regenerates them.
const SIDECAR_TAG_FIELDS = [
    'dc:subject', 'lr:hierarchicalSubject',
    'digiKam:TagsList',
    'MicrosoftPhoto:LastKeywordXMP',
    'acdsee:categories',
    'mediapro:CatalogSets',
    // Namespace declarations for the tag-only schemas (safe to drop when their fields are gone)
    '@_xmlns:digiKam',
    '@_xmlns:MicrosoftPhoto',
    '@_xmlns:acdsee',
    '@_xmlns:mediapro',
];

// Editable fields that Immich has no database home for (it neither stores nor round-trips them),
// so a client edit to them is lost unless we persist it to the on-disk .xmp ourselves. The read
// side (generateAssetMetadataDocument) already preserves anything it doesn't manage, so once these
// land on disk they survive both reads and Immich's own sidecar regeneration (which merges, not
// rewrites). `node` is the XMP element in the incoming sidecar; `tag` is the ExifTool tag we write
// it back as; `kind` selects how the value is read out of the parsed XMP.
type ExtraSidecarField = { node: string; tag: string; kind: 'alt' | 'simple' | 'list' };
const EXTRA_SIDECAR_FIELDS: ExtraSidecarField[] = [
    { node: 'dc:title', tag: 'Title', kind: 'alt' },
    { node: 'xmp:Label', tag: 'Label', kind: 'simple' },
];

// Minimal valid XMP packet, used to seed a sidecar that doesn't exist yet before ExifTool writes
// individual tags into it.
const EMPTY_XMP_SKELETON =
    `<?xpacket begin='﻿' id='W5M0MpCehiHzreSzNTczkc9d'?>\n`
    + `<x:xmpmeta xmlns:x='adobe:ns:meta/'>\n`
    + `<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>\n`
    + `<rdf:Description rdf:about=''/>\n`
    + `</rdf:RDF>\n</x:xmpmeta>\n<?xpacket end='w'?>`;

/**
 * Persist client-edited fields that Immich can't store (see EXTRA_SIDECAR_FIELDS) straight to the
 * asset's on-disk .xmp via a targeted ExifTool write — only the listed tags change, everything else
 * (including Immich's own fields) is left intact. Best-effort: a failure here never blocks the
 * Immich API sync. Only fields the incoming sidecar actually asserts are written; absent fields are
 * left alone so a partial write can't wipe a value the client simply didn't include.
 */
async function persistExtraSidecarFieldsToDisk(asset: ImmichAsset, desc: Record<string, any>): Promise<void>
{
    if (!config.OPTION_ENABLE_LOCAL_FILES) return;

    const originalPath = (asset as any).originalPath;
    if (typeof originalPath !== 'string' || originalPath.length === 0) return;

    const writeTags: Record<string, unknown> = {};
    for (const f of EXTRA_SIDECAR_FIELDS)
    {
        if (desc[f.node] === undefined) continue; // not asserted → don't touch it
        const value =
            f.kind === 'alt' ? XMPUtils.extractAltText(desc, f.node)
                : f.kind === 'list' ? XMPUtils.extractListValues(desc, f.node)[0]
                    : XMPUtils.extractSimpleValue(desc, f.node);
        if (value === undefined || value === '') continue; // clearing not handled in this pass
        writeTags[f.tag] = value;
    }
    if (Object.keys(writeTags).length === 0) return;

    const filepath = '/immich' + originalPath + '.xmp';
    try
    {
        if (!fs.existsSync(filepath))
            await fs.promises.writeFile(filepath, EMPTY_XMP_SKELETON, 'utf8');
        await exiftool.write(filepath, writeTags, ['-overwrite_original_in_place']);
        logger.info('MetadataUtils', 'persistExtraSidecarFieldsToDisk',
            `asset=${asset.id} path=${filepath} wrote=${JSON.stringify(writeTags)}`);
    }
    catch (e)
    {
        logger.warn('MetadataUtils', 'persistExtraSidecarFieldsToDisk',
            `asset=${asset.id} path=${filepath} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
}

export function generateAssetMetadataDocument(asset: ImmichAsset, existingSidecar: string | null): string
{
    const exif = asset.exifInfo ?? {};

    const immichDescription = typeof exif.description === 'string' ? exif.description : '';
    const immichCreateDate = exif.dateTimeOriginal ?? asset.fileCreatedAt ?? '';
    const rating = typeof exif.rating === 'number' ? exif.rating : undefined;
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

    // ── Base: start with all existing sidecar fields so non-Immich data is preserved ──
    // (rating, orientation, resolution, lens info, rights, IPTC, etc. all survive unchanged)
    let descNode: Record<string, any> = { '@_rdf:about': '' };
    if (existingSidecar)
    {
        const sidecarDesc = XMPUtils.getDescNode(XMPUtils.parseSidecar(existingSidecar));
        Object.assign(descNode, sidecarDesc);
        descNode['@_rdf:about'] = '';
    }

    // ── Strip all sidecar tag fields — Immich is always authoritative, even when empty ──
    for (const field of SIDECAR_TAG_FIELDS) delete descNode[field];

    // ── Ensure required namespace declarations are present ────────────────────
    const hasGPS = lat !== undefined && lon !== undefined;
    const hasCamera = !!(make || model);
    const hasLocation = !!(city || state || country);

    descNode['@_xmlns:dc'] = 'http://purl.org/dc/elements/1.1/';
    descNode['@_xmlns:xmp'] = 'http://ns.adobe.com/xap/1.0/';
    descNode['@_xmlns:lr'] = 'http://ns.adobe.com/lightroom/1.0/';
    descNode['@_xmlns:digiKam'] = 'http://www.digikam.org/ns/1.0/';
    if (hasGPS) descNode['@_xmlns:exif'] = 'http://ns.adobe.com/exif/1.0/';
    if (hasCamera) descNode['@_xmlns:tiff'] = 'http://ns.adobe.com/tiff/1.0/';
    if (hasLocation) descNode['@_xmlns:photoshop'] = 'http://ns.adobe.com/photoshop/1.0/';

    // ── Apply Immich-managed scalar fields ────────────────────────────────────
    // Immich wins when it has data; when it doesn't, the sidecar value from the
    // merge above acts as the fallback (except for tags, which have no fallback).

    if (immichDescription)
        descNode['dc:description'] = {
            'rdf:Alt': { 'rdf:li': [{ '@_xml:lang': 'x-default', '#text': immichDescription }] }
        };

    if (immichCreateDate) descNode['xmp:CreateDate'] = immichCreateDate;
    if (rating !== undefined) descNode['xmp:Rating'] = rating;

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

    // ── Apply Immich tag fields (always authoritative, even when empty) ────────
    // dc:subject: plain leaf names (DigiKam standard — no path separators).
    // lr:hierarchicalSubject carries the full ancestor paths, '|'-joined.
    // digiKam:TagsList carries the full ancestor paths too, but '/'-joined —
    // DigiKam's own native field; regenerated so a DigiKam read-back after a
    // write from another client (e.g. Nextcloud Memories) still sees its
    // preferred field populated instead of silently losing it on round-trip.
    const immichLeafTags = immichTags.filter(
        tag => !immichTags.some(other => other !== tag && other.startsWith(tag + '/'))
    );
    const subjects = immichLeafTags.map(tag => tag.split('/').pop() ?? tag);
    for (const name of immichPeople)
        if (!subjects.includes(name)) subjects.push(name);

    const hierarchical = XMPUtils.buildHierarchical(immichTags);

    if (subjects.length > 0)
        descNode['dc:subject'] = { 'rdf:Bag': { 'rdf:li': subjects } };
    if (hierarchical.length > 0)
        descNode['lr:hierarchicalSubject'] = { 'rdf:Bag': { 'rdf:li': hierarchical } };
    if (immichLeafTags.length > 0)
        descNode['digiKam:TagsList'] = { 'rdf:Bag': { 'rdf:li': immichLeafTags } };

    // ── Build XML ─────────────────────────────────────────────────────────────
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

export async function _syncAssetTagsFromXmp(asset: ImmichAsset, newTagValues: string[], api: ImmichAPI): Promise<void>
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

    logger.info('MetadataUtils', '_syncAssetTagsFromXmp',
        `asset=${asset.id} xmpTagValues=${JSON.stringify(newTagValues)} currentTagIds=${JSON.stringify([...currentTagIds])} `
        + `targetTagIds=${JSON.stringify([...targetTagIds])} toAdd=${JSON.stringify(toAdd)} toRemove=${JSON.stringify(toRemove)}`);

    if (toAdd.length > 0)
        await api.SERVER_AddAssetsToTags(asset.id, toAdd)

    if (toRemove.length > 0)
        await api.SERVER_RemoveAssetsFromTags(asset.id, toRemove)
}

export function detectImageExtension(header: Buffer): string | null
{
    if (header.length < 4) return null;
    // JPEG
    if (header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return '.jpg';
    // PNG
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E && header[3] === 0x47) return '.png';
    // GIF
    if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46) return '.gif';
    // TIFF (little-endian)
    if (header[0] === 0x49 && header[1] === 0x49 && header[2] === 0x2A && header[3] === 0x00) return '.tiff';
    // TIFF (big-endian)
    if (header[0] === 0x4D && header[1] === 0x4D && header[2] === 0x00 && header[3] === 0x2A) return '.tiff';
    if (header.length < 12) return null;
    // WebP: RIFF....WEBP
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
        header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return '.webp';
    // ISO base media (MP4/MOV/HEIC/AVIF): ftyp box at offset 4
    if (header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70)
    {
        const brand = header.subarray(8, 12).toString('ascii');
        if (/^(heic|heis|heix|hevc|hevx|mif1|msf1)/.test(brand)) return '.heic';
        if (/^avif/.test(brand)) return '.avif';
        return '.mp4';
    }
    return null;
}

/** Stream a VirtualContentBuffer's contents to a file without materializing it as a single in-memory Buffer. */
async function writeVcbToFile(vcb: VirtualContentBuffer, filePath: string): Promise<void>
{
    await pipeline(vcb.createReadStream(), fs.createWriteStream(filePath));
}

/** SHA-256 of a file, computed in chunks so hashing a large file doesn't block the event loop. */
async function hashFileStreaming(filePath: string): Promise<string>
{
    const hash = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(filePath), hash);
    return hash.digest('hex');
}

export async function embedXmpIntoImage(imageVcb: VirtualContentBuffer, xmpContent: string, _ext: string): Promise<VirtualContentBuffer>
{
    const header = imageVcb.read(0, Math.min(12, imageVcb.size));
    const detectedExt = detectImageExtension(header) ?? _ext ?? '.jpg';

    const imageTmp = tmp.fileSync({ postfix: detectedExt, discardDescriptor: true, keep: false });
    const xmpTmp = tmp.fileSync({ postfix: '.xmp', discardDescriptor: true, keep: false });
    try
    {
        await writeVcbToFile(imageVcb, imageTmp.name);
        await fs.promises.writeFile(xmpTmp.name, xmpContent, 'utf8');
        await exiftool.write(imageTmp.name, {}, ['-tagsfromfile', xmpTmp.name, '-XMP:all']);
        const result = await fs.promises.readFile(imageTmp.name);
        return new VirtualContentBuffer(undefined, result);
    }
    finally
    {
        imageTmp.removeCallback();
        xmpTmp.removeCallback();
    }
}

/** Read back all embedded metadata (EXIF/IPTC/XMP) from an image as an XMP sidecar document. */
export async function extractXmpFromImage(imageVcb: VirtualContentBuffer, ext: string): Promise<string>
{
    const imageTmp = tmp.fileSync({ postfix: ext, discardDescriptor: true, keep: false });
    const xmpTmp = tmp.fileSync({ postfix: '.xmp', discardDescriptor: true, keep: false });
    try
    {
        await writeVcbToFile(imageVcb, imageTmp.name);
        await exiftool.write(xmpTmp.name, {}, ['-tagsfromfile', imageTmp.name, '-all:all', '-overwrite_original']);
        return await fs.promises.readFile(xmpTmp.name, 'utf8');
    }
    finally
    {
        imageTmp.removeCallback();
        xmpTmp.removeCallback();
    }
}

/** SHA-256 of the image with all metadata stripped — used to prove two files share the same media stream. */
async function mediaStreamDigest(imageVcb: VirtualContentBuffer, ext: string): Promise<string>
{
    const imageTmp = tmp.fileSync({ postfix: ext, discardDescriptor: true, keep: false });
    try
    {
        await writeVcbToFile(imageVcb, imageTmp.name);
        await exiftool.write(imageTmp.name, {}, ['-all=', '-overwrite_original']);
        return await hashFileStreaming(imageTmp.name);
    }
    finally
    {
        imageTmp.removeCallback();
    }
}

export type EmbeddedMetadataWriteResult = 'applied' | 'unsupported-format' | 'content-changed';

/**
 * Accepts a client-side write to the asset file itself (e.g. digiKam/exiftool editing tags
 * in place rather than through the .xmp sidecar).  The write is only allowed to change
 * embedded metadata — the underlying media stream must come back byte-identical once
 * metadata is stripped from both sides.  On success only the extracted metadata is pushed
 * to Immich; the asset's stored bytes are never replaced.
 *
 * Rejects anything above OPTION_MAX_METADATA_WRITE_SIZE up front: verifying content-identity
 * requires buffering + hashing the whole file through exiftool, which for a large video would
 * otherwise tie up a request slot (and the exiftool process pool) for a long time.
 */
export async function applyEmbeddedAssetMetadataWrite(asset: ImmichAsset, originalVcb: VirtualContentBuffer, newVcb: VirtualContentBuffer, api: ImmichAPI): Promise<EmbeddedMetadataWriteResult>
{
    if (originalVcb.size > config.OPTION_MAX_METADATA_WRITE_SIZE || newVcb.size > config.OPTION_MAX_METADATA_WRITE_SIZE)
        return 'unsupported-format';

    const header = originalVcb.read(0, Math.min(12, originalVcb.size));
    const ext = detectImageExtension(header) ?? detectImageExtension(newVcb.read(0, Math.min(12, newVcb.size)));
    if (!ext) return 'unsupported-format';

    const [originalDigest, newDigest] = await Promise.all([
        mediaStreamDigest(originalVcb, ext),
        mediaStreamDigest(newVcb, ext),
    ]);
    logger.info('MetadataUtils', 'applyEmbeddedAssetMetadataWrite', `asset=${asset.id} originalDigest=${originalDigest} newDigest=${newDigest} match=${originalDigest === newDigest}`);

    if (originalDigest !== newDigest) return 'content-changed';

    const xmp = await extractXmpFromImage(newVcb, ext);
    await saveAssetMetadataFileContent(asset, xmp, api);
    return 'applied';
}

export async function saveAssetMetadataFileContent(asset: ImmichAsset, contents: string, api: ImmichAPI): Promise<void>
{
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
    // lr:hierarchicalSubject uses '|' as separator (XMP standard) — normalize to '/'.
    // It also contains all ancestor paths; keep only leaf entries (not a prefix of any other).
    //
    // Distinguish "the writer did not touch tags" from "the writer cleared all tags": a client
    // (e.g. Nextcloud Memories) legitimately writes a PARTIAL sidecar when only a scalar field
    // changed, omitting the tag containers entirely. extractListValues() returns [] for both the
    // absent and the present-but-empty cases, so we must inspect presence on the parsed node.
    // getDescNode() flattens every rdf:Description block into one object, so a tag namespace is
    // "asserted" iff its key exists there — even as an empty rdf:Bag. Only then may we reconcile
    // (which includes removing tags); otherwise we leave Immich's existing tags untouched.
    const tagsAsserted = ['digiKam:TagsList', 'lr:hierarchicalSubject', 'dc:subject']
        .some(prop => desc[prop] !== undefined);
    const rawHierarchical = XMPUtils.extractListValues(desc, 'lr:hierarchicalSubject')
        .map(v => v.replace(/\|/g, '/'));
    const leafHierarchical = rawHierarchical.filter(
        tag => !rawHierarchical.some(other => other !== tag && other.startsWith(tag + '/'))
    );
    const newTagValues = [...new Set([
        ...XMPUtils.extractListValues(desc, 'digiKam:TagsList'),
        ...leafHierarchical,
        ...XMPUtils.extractListValues(desc, 'dc:subject'),
    ])];

    // --- Patch asset scalar fields (only send changed values) ---
    const exif = asset.exifInfo ?? {};
    const patch: Record<string, unknown> = {};

    if (newDescription !== undefined && newDescription !== (exif.description ?? ''))
        patch.description = newDescription;

    // Rating: Immich accepts -1 (rejected), 1–5 (starred), or null (unrated) — it rejects 0.
    // xmp:Rating 0 is the XMP "unrated" value, so a client clearing the rating (writing 0) must be
    // translated to null. Only emit the clear when the asset currently has a rating, so an
    // already-unrated asset doesn't generate a pointless PATCH that 500s or churns.
    const currentRating = (exif as any).rating;
    if (newRating !== undefined && Number.isFinite(newRating)) {
        const r = Math.round(newRating);
        if (r === 0) {
            if (currentRating !== null && currentRating !== undefined && currentRating !== 0)
                patch.rating = null;
        } else if (r === -1 || (r >= 1 && r <= 5)) {
            if (r !== currentRating)
                patch.rating = r;
        }
    }

    if (newDate !== undefined && newDate !== (exif.dateTimeOriginal ?? asset.fileCreatedAt ?? ''))
        patch.dateTimeOriginal = newDate;

    // GPS is round-tripped through formatGPS (deg,decimal-min at toFixed(6)) and parseGPS, so an
    // unchanged coordinate comes back differing in the last digit. Compare with an epsilon instead
    // of strict inequality, otherwise every save re-PATCHes lat/lon and slowly drifts the value.
    const GPS_EPSILON = 1e-6;
    if (newLat !== undefined && (exif.latitude === undefined || exif.latitude === null || Math.abs(newLat - exif.latitude) > GPS_EPSILON))
        patch.latitude = newLat;

    if (newLon !== undefined && (exif.longitude === undefined || exif.longitude === null || Math.abs(newLon - exif.longitude) > GPS_EPSILON))
        patch.longitude = newLon;

    logger.info('MetadataUtils', 'saveAssetMetadataFileContent',
        `asset=${asset.id} parsed={description=${JSON.stringify(newDescription)}, rating=${newRating}, date=${newDate}, lat=${newLat}, lon=${newLon}, tags=${JSON.stringify(newTagValues)}} `
        + `tagsAsserted=${tagsAsserted} `
        + `currentExif={description=${JSON.stringify(exif.description)}, rating=${(exif as any).rating}} patch=${JSON.stringify(patch)}`);

    // Persist non-Immich fields (Title/Label/…) to the on-disk sidecar BEFORE the Immich PATCH:
    // the PATCH triggers Immich's own sidecar regeneration, which merges over (preserves) whatever
    // is already on disk — so writing first lets those fields survive that regeneration.
    await persistExtraSidecarFieldsToDisk(asset, desc);

    if (Object.keys(patch).length > 0)
    {
        await api.SERVER_UpdateAsset(asset.id, patch)
    }

    // --- Sync tags ---
    // Only reconcile when the sidecar actually asserts tag fields. A partial sidecar that omits
    // the tag containers must NOT be read as "remove every tag" (that was erasing all of an
    // asset's tags whenever a client saved an unrelated scalar change).
    if (tagsAsserted)
    {
        await _syncAssetTagsFromXmp(asset, newTagValues, api);
    }

    // Deliberately NOT mirroring `contents` to the physical .xmp sidecar path here.
    // Immich's own server-side MetadataRepository job independently regenerates that
    // exact file (from its DB, which the SERVER_UpdateAsset/tag calls above just
    // updated) every time an asset's metadata changes -- it is already the sole
    // authoritative writer of the on-disk sidecar. A second direct filesystem write
    // from here races Immich's own atomic tmp-then-rename exiftool write on the same
    // path: whichever writer loses the race either throws ("Temporary file already
    // exists", seen repeatedly in immich_server's logs) or gets silently clobbered by
    // the other, which is how fields set via this exact code path were observed to
    // disappear again shortly after. Let Immich own that file; only talk to it via API.
}










