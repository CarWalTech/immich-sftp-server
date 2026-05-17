
import path from 'path';
import { DateTime } from 'luxon';
import { config } from '../../config';
import { logger } from '../../logger';
import { getAssetMtime } from './immich-api-utils';

const DEFAULT_ASSET_BASE_NAME = 'asset';

export class ImmichAssetUtils
{
    private static assetFileNamePattern: string = ""

    public static setAssetFileNamePattern(pattern: string)
    {
        this.assetFileNamePattern = pattern
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


