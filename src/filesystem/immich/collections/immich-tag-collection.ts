import { ImmichAssetUtils } from "../utils/immich-asset-utils";
import { PathUtils } from "../../utils/path-utils";
import { StringUtils } from "../../utils/string-utils";
import { ImmichAsset } from "./immich-root-collection";
import { ImmichFileSystem } from "../immich-file-system";
import tmp from 'tmp';
import isValidFilename from 'valid-filename'; //Achtung, nicht auf v4.0.0 updaten. Ab da wird commjs projekt nicht mehr unterstützt, es geht dann nur noch als ES module.
import { } from "yaml";
import { FileUtils } from "../../utils/file-utils";

export class ImmichTagCollection
{
    private file_system: ImmichFileSystem;
    private tagsCache: ImmichTag[] = [];

    public static readonly TAGS_FOLDER_NAME = 'tags';
    public static readonly TAG_METADATA_FILE_NAME = 'tag.yaml';

    constructor(file_system: ImmichFileSystem)
    {
        this.file_system = file_system
    }

    // Login / Logout Methods
    public logout()
    {
        this.tagsCache = [];
    }

    // VirtualFileSystem Methods
    public async listFiles(currentDir: string)
    {
        const parts = PathUtils.getPathParts(currentDir); // ["tags", "Animals", "Cats"]

        // Load tags + build tree
        this.tagsCache = await this.file_system.getApi().fetchTags();
        const tree = this.getVirtualTagTree(this.tagsCache);

        // Case 1: /tags → list top-level tag folders
        if (parts.length === 1)
        {
            return [...tree.children.values()].map(node => ({
                name: node.fsName,
                isDir: true,
                size: 0,
                mtime: Math.floor(Date.now() / 1000),
            }));
        }

        // Traverse deeper
        let node: ImmichVirtualTagNode = tree;
        for (const segment of parts.slice(1))
        {
            const next = node.children.get(segment);
            if (!next) throw new Error(`Tag folder not found: ${segment}`);
            node = next;
        }

        const entries: Array<{ name: string; isDir: boolean; size: number; mtime: number }> = [];

        // 1. Add subfolders
        for (const child of node.children.values())
        {
            entries.push({
                name: child.fsName,
                isDir: true,
                size: 0,
                mtime: Math.floor(Date.now() / 1000),
            });
        }

        // 2. Add assets for this tag (even if it has children)
        if (node.tag)
        {
            const tag = node.tag;
            const assets = await this.file_system.getApi().fetchAssetsByMetadata({ tagIds: [tag.id] });
            const nameByAssetId = ImmichAssetUtils.getAssetDisplayNameByAssetId(assets, new Set([ImmichTagCollection.TAG_METADATA_FILE_NAME]));

            for (const asset of assets)
            {
                entries.push({
                    name: nameByAssetId.get(asset.id) ?? asset.originalFileName,
                    isDir: false,
                    size: asset.fileSizeInByte,
                    mtime: ImmichAssetUtils.getAssetMtime(asset),
                });
            }

            // 3. Add metadata file
            const metadataContent = this.getTagMetadataYaml(tag);
            entries.push({
                name: ImmichTagCollection.TAG_METADATA_FILE_NAME,
                isDir: false,
                size: Buffer.byteLength(metadataContent, 'utf8'),
                mtime: StringUtils.getTimestampOrNow(tag.updatedAt),
            });
        }

        return entries;
    }
    public async readFile(filename: string): Promise<tmp.FileResult>
    {
        const pathInfo = PathUtils.extractTagPathInfo(filename, ImmichTagCollection.TAGS_FOLDER_NAME);
        if (pathInfo.itemName && pathInfo.fileName === ImmichTagCollection.TAG_METADATA_FILE_NAME)
        {
            const tag = await this.pathToTag(filename, true, true);
            const tmp_file = tag ? this.getTagMetadataYaml(tag) : null;
            if (tmp_file) return FileUtils.createTmpFile(tmp_file);
        }
        else if (pathInfo.itemName && pathInfo.fileName)
        {
            const tag = await this.pathToTag(filename, true, true);
            if (tag)
            {
                const assets = await this.file_system.getApi().fetchAssetsByMetadata({ tagIds: [tag.id] });
                const displayable_assets = ImmichAssetUtils.getAssetFromAssetsByDisplayName(pathInfo.fileName, assets, new Set<string>([ImmichTagCollection.TAG_METADATA_FILE_NAME]));
                if (displayable_assets) return await this.file_system.getApi().SERVER_ReadAsset(displayable_assets)
            }
        }
        throw new Error(`Unknown file: ${filename}`);
    }
    public async writeFile(filename: string, tmpFile: tmp.FileResult): Promise<void>
    {

    }
    public async rename(oldFilename: string, newFilename: string): Promise<void>
    {
        const oldPathInfo = PathUtils.extractTagPathInfo(oldFilename, ImmichTagCollection.TAGS_FOLDER_NAME);
        const newPathInfo = PathUtils.extractTagPathInfo(newFilename, ImmichTagCollection.TAGS_FOLDER_NAME);
        const isFolderRename = oldPathInfo.itemName && !oldPathInfo.fileName && newPathInfo.itemName && !newPathInfo.fileName;
        if (!isFolderRename) throw new Error(`'${ImmichTagCollection.TAGS_FOLDER_NAME}' is read-only except for renaming ${ImmichTagCollection.TAGS_FOLDER_NAME} folders.`);
        const oldDisplayName = oldPathInfo.itemName as string;
        const newDisplayName = newPathInfo.itemName as string;
        if (!isValidFilename(newDisplayName)) throw new Error(`Invalid folder name: '${newDisplayName}'.`);

        const tag = await this.pathToTag(oldFilename, true);
        if (!tag) throw new Error(`Tag not found with name: '${oldDisplayName}'`);

        const targetTag = await this.pathToTag(newFilename, false);
        if (targetTag && targetTag.id !== tag.id) throw new Error(`A tag with name '${newDisplayName}' already exists.`);

        await this.file_system.getApi().SERVER_RenameTag(tag, newDisplayName)
        this.tagsCache = await this.file_system.getApi().fetchTags();
        return;
    }
    public async stat(filename: string)
    {
        const parts = PathUtils.getPathParts(filename);

        this.tagsCache = await this.file_system.getApi().fetchTags();
        const tree = this.getVirtualTagTree(this.tagsCache);

        // /tags
        if (parts.length === 1) return { isDir: true, size: 0, mtime: Math.floor(Date.now() / 1000) };

        // Traverse
        let node: ImmichVirtualTagNode = tree;
        for (const segment of parts.slice(1))
        {
            const next = node.children.get(segment);
            if (!next) return null;
            node = next;
        }

        // Directory
        return {
            isDir: true,
            size: 0,
            mtime: node.tag ? StringUtils.getTimestampOrNow(node.tag.updatedAt) : Math.floor(Date.now() / 1000),
        };
    }
    public async mkdir(dirPath: string): Promise<void>
    {

    }
    public async remove(filename: string): Promise<void>
    {

    }
    public async setAttributes(filename: string, mtime: number): Promise<void>
    {

    }

    // Conditional Methods
    public async isPathWithin(filePath: string): Promise<boolean>
    {
        const visibility = await this.file_system.getUserDisplaySettings();
        return visibility.tagsEnabled && PathUtils.isPathWithinRoot(filePath, ImmichTagCollection.TAGS_FOLDER_NAME);
    }

    // Get Methods
    public getVirtualTagTree(tags: ImmichTag[]): ImmichVirtualTagNode
    {
        const root: ImmichVirtualTagNode = {
            rawName: '',
            fsName: '',
            children: new Map(),
        };

        // 1. Index tags by ID
        const byId = new Map<string, ImmichVirtualTagNode>();
        for (const tag of tags)
        {
            const fs = PathUtils.normalizeFolderDisplayName(tag.name, 'tag', tag.id);

            byId.set(tag.id, {
                rawName: tag.name,
                fsName: fs,
                children: new Map(),
                tag,
            });
        }

        // 2. Build hierarchy using parentId
        for (const tag of tags)
        {
            const node = byId.get(tag.id)!;

            if (tag.parentId && byId.has(tag.parentId))
            {
                // Attach to parent
                const parent = byId.get(tag.parentId)!;
                parent.children.set(node.fsName, node);
            } else
            {
                // No parent → attach to root
                root.children.set(node.fsName, node);
            }
        }

        return root;
    }
    public getTagMetadataYaml(tag: ImmichTag): string
    {
        let metadata: Array<string> = [
            `id: ${JSON.stringify(tag.id)}`,
            `name: ${JSON.stringify(tag.name)}`,
            `value: ${JSON.stringify(tag.value)}`,
        ];

        return metadata.join('\n');
    }

    //Path Methods
    public async pathToTag(filePath: string, refreshCache: boolean, isFile: boolean = false): Promise<ImmichTag | null>
    {
        const parts = PathUtils.getPathParts(filePath);
        if (parts[0] !== ImmichTagCollection.TAGS_FOLDER_NAME) return null;

        const segments = parts.slice(1);
        if (isFile) segments.pop();

        if (this.tagsCache.length === 0 || refreshCache)
        {
            this.tagsCache = await this.file_system.getApi().fetchTags();
        }

        const tree = this.getVirtualTagTree(this.tagsCache);

        let node: ImmichVirtualTagNode = tree;
        for (const segment of segments)
        {
            const next = node.children.get(segment);
            if (!next) return null;
            node = next;
        }

        return node.tag ?? null;
    }
}

export interface ImmichTag
{
    id: string;
    name: string;
    value: string;
    color?: string;
    parentId?: string;
    updatedAt?: string;
    createdAt?: string;
}

export interface ImmichVirtualTagNode
{
    rawName: string;
    fsName: string;
    children: Map<string, ImmichVirtualTagNode>;
    tag?: ImmichTag;
}