
import path from 'path';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { logger } from '../../logger';

const DEFAULT_ASSET_BASE_NAME = 'asset';

export class ImmichAssetUtils
{
    private static assetFileNamePattern: string = ""

    public static setAssetFileNamePattern(pattern: string)
    {
        this.assetFileNamePattern = pattern
    }
    public static getAssetMtime(asset: ImmichAsset): number
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
        return Math.floor(Date.now() / 1000);
    }
    public static buildPreferredAssetName(asset: ImmichAsset): string
    {
        const extension = path.extname(asset.originalFileName);
        const timestamp = this.getAssetMtime(asset);
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
    public static ensureUniqueAssetName(preferredName: string, asset: ImmichAsset, usedNames: Set<string>): string
    {
        if (!usedNames.has(preferredName))
        {
            return preferredName;
        }

        const parsed = path.parse(preferredName);
        const shortId = asset.id.slice(0, 8);
        const base = parsed.name || DEFAULT_ASSET_BASE_NAME;
        const ext = parsed.ext || path.extname(asset.originalFileName);

        let candidate = `${base}__${shortId}${ext}`;
        let counter = 2;
        while (usedNames.has(candidate))
        {
            candidate = `${base}__${shortId}_${counter}${ext}`;
            counter += 1;
        }
        return candidate;
    }
    public static getAssetDisplayNameMap(assets: ImmichAsset[], reservedNames: Set<string>): Map<string, ImmichAsset>
    {
        const byDisplayName = new Map<string, ImmichAsset>();
        const usedNames = new Set<string>(reservedNames);

        for (const asset of assets)
        {
            const preferredName = this.buildPreferredAssetName(asset);
            const uniqueName = this.ensureUniqueAssetName(preferredName, asset, usedNames);
            usedNames.add(uniqueName);
            byDisplayName.set(uniqueName, asset);
        }
        return byDisplayName;
    }
    public static getAssetDisplayNameByAssetId(assets: ImmichAsset[], reservedNames: Set<string>): Map<string, string>
    {
        const byAssetId = new Map<string, string>();
        for (const [displayName, asset] of ImmichAssetUtils.getAssetDisplayNameMap(assets, reservedNames).entries())
        {
            byAssetId.set(asset.id, displayName);
        }
        return byAssetId;
    }
    public static getAssetFromAssetsByDisplayName(displayName: string, assets: ImmichAsset[], reservedNames: Set<string>): ImmichAsset | null
    {
        const byDisplayName = ImmichAssetUtils.getAssetDisplayNameMap(assets, reservedNames);
        return byDisplayName.get(displayName) ?? null;
    }
    public static mapAssetFromApi(asset: any): ImmichAsset
    {
        if (!asset.exifInfo?.fileSizeInByte)
        {
            logger.warn('ImmichAssetUtils', 'getAssetMtime', `Asset ${asset.originalFileName} (${asset.id}) has no exifInfo.fileSizeInByte, using 0 as fallback.`);
        }
        return {
            id: asset.id,
            originalFileName: asset.originalFileName,
            createdAt: asset.createdAt,
            updatedAt: asset.updatedAt,
            originalPath: asset.originalPath,
            fileCreatedAt: asset.fileCreatedAt,
            fileModifiedAt: asset.fileModifiedAt,
            fileSizeInByte: asset.exifInfo?.fileSizeInByte ?? 0,
            isTrashed: asset.isTrashed,
        };
    }
}

export interface ImmichAsset
{
    id: string;
    originalFileName: string;
    originalPath: string;
    createdAt?: string;
    updatedAt?: string;
    fileCreatedAt: string;
    fileModifiedAt: string;
    fileSizeInByte: number;
    isTrashed: boolean;
}


