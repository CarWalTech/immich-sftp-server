import { ImmichTag } from "../collections/tags/tag-folder";


const DEFAULT_ASSET_BASE_NAME = 'asset';

export class ImmichCollectionUtils
{
    public static mapTagFromApi(tag: any): ImmichTag
    {
        return {
            id: tag.id,
            name: tag.name,
            value: tag.value,
            parentId: tag.parentId && typeof tag.parentId === 'string' ? tag.parentId : undefined,
            color: tag.color && typeof tag.color === 'string' ? tag.parentId : undefined,
            createdAt: typeof tag.updatedAt === 'string' ? tag.createdAt : undefined,
            updatedAt: typeof tag.updatedAt === 'string' ? tag.updatedAt : undefined,
        }
    }
}