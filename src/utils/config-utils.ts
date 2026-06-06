
export type AssetFileNamePattern = 'original' | 'original+assetUuid' | 'original+shortUuid' | 'assetUuid' | 'shortUuid' | 'date' | 'dateUuid';
export type AssetDownloadSource = 'original' | 'preview';

export function parseAssetDownloadSource(value: string | undefined): AssetDownloadSource | undefined
{
    if (!value)
    {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    const byValue: Record<string, AssetDownloadSource> = {
        original: 'original',
        preview: 'preview',
        thumbnail: 'preview',
    };
    const parsed = byValue[normalized];
    if (!parsed)
    {
        throw new Error(`Invalid asset download source: ${value}. Allowed: original, preview.`);
    }
    return parsed;
}

export function parseAssetFileNamePattern(value: string | undefined): AssetFileNamePattern | undefined
{
    if (!value)
    {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    const byValue: Record<string, AssetFileNamePattern> = {

        // original
        original: 'original',

        // assetUuid
        asset_uuid: 'assetUuid',
        assetuuid: 'assetUuid',
        uuid: 'assetUuid',

        // shortUuid
        short_uuid: 'shortUuid',
        shortuuid: 'shortUuid',

        // date
        date: 'date',

        // dateUuid
        date_uuid: 'dateUuid',
        dateuuid: 'dateUuid',

        // original+assetUuid
        "original+asset_uuid": 'original+assetUuid',
        "original+assetuuid": 'original+assetUuid',
        "original+uuid": 'original+assetUuid',

        // original+shortUuid
        "original+short_uuid": 'original+shortUuid',
        "original+shortuuid": 'original+shortUuid'

    };
    const parsed = byValue[normalized];
    if (!parsed)
    {
        throw new Error(`Invalid asset file name pattern: ${value}. Allowed: original, assetUuid, shortUuid, date, dateUuid, original+assetUuid, original+shortUuid.`);
    }
    return parsed;
}


