import Builder from 'fast-xml-builder';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import tmp from 'tmp';
import { exiftool } from 'exiftool-vendored';
import YAML from 'yaml';
import { config } from '../../config';
import { isObject } from '../../utils/common-utils';
import { VirtualContentBuffer } from '../../filesystem/virtual-content-buffer';
import { XMPUtils } from '../../utils/xmp-utils';
import { ImmichAPI } from '../immich-api';
import { ImmichAlbumBase, ImmichAlbumUser, ImmichAsset, ImmichUser, isCurrentUserAlbumOwner } from "./immich-api-utils";

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
// Sidecar tags that are leaf-name equivalents of existing Immich tags are already covered
// by the Immich tag values written below; no manual "resemble" matching is required.
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

export function generateAssetMetadataDocument(asset: ImmichAsset, existingSidecar: string | null): string
{
    const exif = asset.exifInfo ?? {};

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
    // lr:hierarchicalSubject carries the full ancestor paths.
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

export async function embedXmpIntoImage(imageVcb: VirtualContentBuffer, xmpContent: string, _ext: string): Promise<VirtualContentBuffer>
{
    const header = imageVcb.read(0, Math.min(12, imageVcb.size));
    const detectedExt = detectImageExtension(header) ?? _ext ?? '.jpg';

    const imageTmp = tmp.fileSync({ postfix: detectedExt, discardDescriptor: true, keep: false });
    const xmpTmp = tmp.fileSync({ postfix: '.xmp', discardDescriptor: true, keep: false });
    try
    {
        fs.writeFileSync(imageTmp.name, imageVcb.read(0, imageVcb.size));
        fs.writeFileSync(xmpTmp.name, xmpContent, 'utf8');
        await exiftool.write(imageTmp.name, {}, ['-tagsfromfile', xmpTmp.name, '-XMP:all']);
        const result = fs.readFileSync(imageTmp.name);
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
        fs.writeFileSync(imageTmp.name, imageVcb.read(0, imageVcb.size));
        await exiftool.write(xmpTmp.name, {}, ['-tagsfromfile', imageTmp.name, '-all:all', '-overwrite_original']);
        return fs.readFileSync(xmpTmp.name, 'utf8');
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
        fs.writeFileSync(imageTmp.name, imageVcb.read(0, imageVcb.size));
        await exiftool.write(imageTmp.name, {}, ['-all=', '-overwrite_original']);
        return crypto.createHash('sha256').update(fs.readFileSync(imageTmp.name)).digest('hex');
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
 */
export async function applyEmbeddedAssetMetadataWrite(asset: ImmichAsset, originalVcb: VirtualContentBuffer, newVcb: VirtualContentBuffer, api: ImmichAPI): Promise<EmbeddedMetadataWriteResult>
{
    const header = originalVcb.read(0, Math.min(12, originalVcb.size));
    const ext = detectImageExtension(header) ?? detectImageExtension(newVcb.read(0, Math.min(12, newVcb.size)));
    if (!ext) return 'unsupported-format';

    const [originalDigest, newDigest] = await Promise.all([
        mediaStreamDigest(originalVcb, ext),
        mediaStreamDigest(newVcb, ext),
    ]);
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

    if (newRating !== undefined && Number.isFinite(newRating) && newRating >= 0 && newRating <= 5)
        patch.rating = Math.round(newRating);

    if (newDate !== undefined && newDate !== (exif.dateTimeOriginal ?? asset.fileCreatedAt ?? ''))
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
    if (config.OPTION_ENABLE_LOCAL_FILES)
    {
        const filepath = "/immich" + asset.originalPath + ".xmp";
        await fs.promises.writeFile(filepath, contents, 'utf8');
    }
}










