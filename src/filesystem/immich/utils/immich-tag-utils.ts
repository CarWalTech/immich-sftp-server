import { ImmichTag } from "../collections/tags/tag-folder";

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

    console.warn(`Tag '${album.value}' (ID: ${album.id}) has missing/invalid createdAt and updatedAt timestamps, using current time as mtime fallback.`);
    return Math.floor(Date.now() / 1000);
}