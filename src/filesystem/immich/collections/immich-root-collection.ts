import { ImmichFileSystem } from "../immich-file-system";
import { ImmichAlbumCollection } from "./immich-album-collection";
import { ImmichPeopleCollection } from "./immich-people-collection";
import { ImmichTagCollection } from "./immich-tag-collection";

export class ImmichRootCollection
{
    private file_system: ImmichFileSystem;

    constructor(file_system: ImmichFileSystem)
    {
        this.file_system = file_system
    }

    public isPath(currentDir: string)
    {
        return currentDir == "/";
    }

    public async listFiles(): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>
    {
        const visibility = await this.file_system.getUserDisplaySettings();

        const now = Math.floor(Date.now() / 1000);
        const rootEntries: Array<{ name: string; isDir: boolean; size: number; mtime: number }> = [
            {
                name: ImmichAlbumCollection.ALBUMS_FOLDER_NAME,
                isDir: true,
                size: 0,
                mtime: now,
            },
        ];

        if (visibility.tagsEnabled)
        {
            rootEntries.push({
                name: ImmichTagCollection.TAGS_FOLDER_NAME,
                isDir: true,
                size: 0,
                mtime: now,
            });
        }
        if (visibility.peopleEnabled)
        {
            rootEntries.push({
                name: ImmichPeopleCollection.PEOPLE_FOLDER_NAME,
                isDir: true,
                size: 0,
                mtime: now,
            });
        }
        return rootEntries;
    }
    public async stat(filename: string): Promise<{ isDir: boolean; size: number; mtime: number; } | null>
    {
        return {
            isDir: true,
            size: 0,
            mtime: Math.floor(Date.now() / 1000),
        };
    }
}

export interface ImmichAsset
{
    id: string;
    originalFileName: string;
    createdAt?: string;
    updatedAt?: string;
    fileCreatedAt: string;
    fileModifiedAt: string;
    fileSizeInByte: number;
    isTrashed: boolean;
}