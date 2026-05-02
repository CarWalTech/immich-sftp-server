import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import isValidFilename from 'valid-filename'; //Achtung, nicht auf v4.0.0 updaten. Ab da wird commjs projekt nicht mehr unterstützt, es geht dann nur noch als ES module.
import tmp from 'tmp';
import { StringUtils } from "../../utils/string-utils";
import { ImmichAsset } from "./immich-root-collection";
import { ImmichAssetUtils } from "../utils/immich-asset-utils";
import { FileUtils } from "../../utils/file-utils";

export class ImmichPeopleCollection
{
    private file_system: ImmichFileSystem;
    private peopleCache: ImmichPerson[] = [];

    public static readonly PEOPLE_FOLDER_NAME = 'people';
    public static readonly PERSON_METADATA_FILE_NAME = 'person.yaml';

    constructor(file_system: ImmichFileSystem)
    {
        this.file_system = file_system
    }

    // Login / Logout Methods
    public logout()
    {
        this.peopleCache = [];
    }


    public async rename(oldName: string, newName: string): Promise<void>
    {
        const oldPathInfo = PathUtils.extractPeoplePathInfo(oldName, ImmichPeopleCollection.PEOPLE_FOLDER_NAME);
        const newPathInfo = PathUtils.extractPeoplePathInfo(newName, ImmichPeopleCollection.PEOPLE_FOLDER_NAME);
        const isFolderRename = oldPathInfo.itemName && !oldPathInfo.fileName && newPathInfo.itemName && !newPathInfo.fileName;
        if (!isFolderRename) throw new Error(`'${ImmichPeopleCollection.PEOPLE_FOLDER_NAME}' is read-only except for renaming ${ImmichPeopleCollection.PEOPLE_FOLDER_NAME} folders.`);

        const oldDisplayName = oldPathInfo.itemName as string;
        const newDisplayName = newPathInfo.itemName as string;
        if (!isValidFilename(newDisplayName)) throw new Error(`Invalid folder name: '${newDisplayName}'.`);

        const person = await this.getPersonFromCache(oldDisplayName, true);
        const targetPerson = await this.getPersonOrNullFromCache(newDisplayName, false);
        if (targetPerson && targetPerson.id !== person.id)
        {
            throw new Error(`A person with name '${newDisplayName}' already exists.`);
        }

        await this.file_system.getApi().SERVER_RenamePerson(person, newDisplayName);
        this.peopleCache = await this.file_system.getApi().fetchPeople();
    }

    public async isPathWithin(filePath: string): Promise<boolean>
    {
        const visibility = await this.file_system.getUserDisplaySettings();
        return visibility.peopleEnabled && PathUtils.isPathWithinRoot(filePath, ImmichPeopleCollection.PEOPLE_FOLDER_NAME);
    }
    public buildPersonMetadataYaml(person: ImmichPerson): string
    {
        return `id: ${JSON.stringify(person.id)}\nname: ${JSON.stringify(person.name)}\ndisplayName: ${JSON.stringify(person.displayName)}\n`;
    }

    public async listFiles(currentDir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>
    {
        const pathInfo = PathUtils.extractPeoplePathInfo(currentDir, ImmichPeopleCollection.PEOPLE_FOLDER_NAME);
        if (pathInfo.fileName)
        {
            throw new Error(`Invalid people path: ${currentDir}`);
        }

        if (!pathInfo.itemName)
        {
            this.peopleCache = await this.file_system.getApi().fetchPeople();
            return this.peopleCache.map((person) => ({
                name: person.displayName,
                isDir: true,
                size: 0,
                mtime: StringUtils.getTimestampOrNow(person.updatedAt),
            }));
        }

        const person = await this.getPersonFromCache(pathInfo.itemName, true);
        const assets = await this.file_system.getApi().fetchAssetsByMetadata({ personIds: [person.id] });
        const nameByAssetId = ImmichAssetUtils.getAssetDisplayNameByAssetId(assets, new Set<string>([ImmichPeopleCollection.PERSON_METADATA_FILE_NAME]));
        const files = assets.map((asset) => ({
            name: nameByAssetId.get(asset.id) ?? asset.originalFileName,
            isDir: false,
            size: asset.fileSizeInByte,
            mtime: ImmichAssetUtils.getAssetMtime(asset),
        }));
        const metadataContent = this.buildPersonMetadataYaml(person);
        files.push({
            name: ImmichPeopleCollection.PERSON_METADATA_FILE_NAME,
            isDir: false,
            size: Buffer.byteLength(metadataContent, 'utf8'),
            mtime: StringUtils.getTimestampOrNow(person.updatedAt),
        });
        return files;
    }

    public async getPersonOrNullFromCache(displayName: string, refreshCache: boolean): Promise<ImmichPerson | null>
    {
        if (this.peopleCache.length === 0 || refreshCache)
        {
            this.peopleCache = await this.file_system.getApi().fetchPeople();
        }
        return this.peopleCache.find((person) => person.displayName === displayName) ?? null;
    }
    public async getPersonFromCache(displayName: string, refreshCache: boolean): Promise<ImmichPerson>
    {
        const person = await this.getPersonOrNullFromCache(displayName, refreshCache);
        if (!person)
        {
            throw new Error(`Person not found: ${displayName}`);
        }
        return person;
    }
    public async stat(filename: string): Promise<{ isDir: boolean; size: number; mtime: number; } | null>
    {
        const pathInfo = PathUtils.extractPeoplePathInfo(filename, ImmichPeopleCollection.PEOPLE_FOLDER_NAME);
        if (!pathInfo.itemName)
        {
            return {
                isDir: true,
                size: 0,
                mtime: Math.floor(Date.now() / 1000),
            };
        }

        if (!pathInfo.fileName)
        {
            const person = await this.getPersonOrNullFromCache(pathInfo.itemName, true);
            if (!person)
            {
                return null;
            }
            return {
                isDir: true,
                size: 0,
                mtime: StringUtils.getTimestampOrNow(person.updatedAt),
            };
        }

        if (pathInfo.fileName === ImmichPeopleCollection.PERSON_METADATA_FILE_NAME)
        {
            const person = await this.getPersonOrNullFromCache(pathInfo.itemName, true);
            if (!person)
            {
                return null;
            }
            const metadataContent = this.buildPersonMetadataYaml(person);
            return {
                isDir: false,
                size: Buffer.byteLength(metadataContent, 'utf8'),
                mtime: StringUtils.getTimestampOrNow(person.updatedAt),
            };
        }

        const asset = await this.getCollectionAssetOrNull(filename, true);
        if (!asset)
        {
            return null;
        }
        return {
            isDir: false,
            size: asset.fileSizeInByte,
            mtime: ImmichAssetUtils.getAssetMtime(asset),
        };
    }

    private async getCollectionAssetOrNull(filename: string, refreshCollectionAssets: boolean): Promise<ImmichAsset | null>
    {
        if (await this.isPathWithin(filename))
        {
            const pathInfo = PathUtils.extractPeoplePathInfo(filename, ImmichPeopleCollection.PEOPLE_FOLDER_NAME);
            if (!pathInfo.itemName || !pathInfo.fileName)
            {
                return null;
            }
            if (pathInfo.fileName === ImmichPeopleCollection.PERSON_METADATA_FILE_NAME)
            {
                return null;
            }
            const person = await this.getPersonOrNullFromCache(pathInfo.itemName, refreshCollectionAssets);
            if (!person)
            {
                return null;
            }
            const assets = await this.file_system.getApi().fetchAssetsByMetadata({ personIds: [person.id] });
            return ImmichAssetUtils.getAssetFromAssetsByDisplayName(pathInfo.fileName, assets, new Set<string>([ImmichPeopleCollection.PERSON_METADATA_FILE_NAME]));
        }

        return null;
    }

    public async readFile(filename: string): Promise<tmp.FileResult>
    {
        const pathInfo = PathUtils.extractPeoplePathInfo(filename, ImmichPeopleCollection.PEOPLE_FOLDER_NAME);
        if (pathInfo.itemName && pathInfo.fileName === ImmichPeopleCollection.PERSON_METADATA_FILE_NAME)
        {
            const person = await this.getPersonOrNullFromCache(pathInfo.itemName, true);
            const tmp_file = person ? this.buildPersonMetadataYaml(person) : null;
            if (tmp_file) return FileUtils.createTmpFile(tmp_file);
        }
        else if (pathInfo.itemName && pathInfo.fileName)
        {
            const person = await this.getPersonOrNullFromCache(pathInfo.itemName, true);
            if (person)
            {
                const assets = await this.file_system.getApi().fetchAssetsByMetadata({ personIds: [person.id] });
                const displayable_assets = ImmichAssetUtils.getAssetFromAssetsByDisplayName(pathInfo.fileName, assets, new Set<string>([ImmichPeopleCollection.PERSON_METADATA_FILE_NAME]));
                if (displayable_assets) return await this.file_system.getApi().SERVER_ReadAsset(displayable_assets)
            }
        }
        throw new Error(`Unknown file: ${filename}`);
    }
}

export interface ImmichPerson
{
    id: string;
    name: string;
    displayName: string;
    updatedAt?: string;
}