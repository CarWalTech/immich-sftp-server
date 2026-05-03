import { VirtualDirectory } from "../../../common/virtual-directory";
import { VirtualFsNode, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../../common/virtual-fs-node";
import { ImmichFileSystem } from "../../immich-file-system";
import { ImmichAssetUtils } from "../../utils/immich-asset-utils";
import { ImmichAsset, ImmichAssetFile } from "../asset-file";
import { ImmichTagsDirectory, ImmichTagsDirectoryNode } from "./tags-directory";
import { ImmichTagMetadataFile } from "./tag-metadata";
import { TAG_METADATA_FILE_NAME } from "../../metadata/immich-tag-metadata-service";

export class ImmichTagFolder extends VirtualDirectory
{
    private file_system: ImmichFileSystem;
    private tags_root: ImmichTagsDirectory;
    private node_data: ImmichTagsDirectoryNode;

    constructor(file_system: ImmichFileSystem, albums_root: ImmichTagsDirectory, parent: ImmichTagsDirectory | ImmichTagFolder, node: ImmichTagsDirectoryNode)
    {
        super(node.fsName, undefined, parent)
        this.node_data = node
        this.tags_root = albums_root
        this.file_system = file_system
    }

    public stage_refetch()
    {
        this.tags_root.stage_refetch()
    }

    async event_rebuild(): Promise<Map<string, VirtualFsNode>>
    {
        var sub_folders = new Map([...this.node_data.children.values()].map(node => ([node.fsName, new ImmichTagFolder(this.file_system, this.tags_root, this, node) as VirtualFsNode])))
        if (this.node_data.tag)
        {
            var metadata_files = new Map([
                [TAG_METADATA_FILE_NAME, new ImmichTagMetadataFile(this.node_data.tag, TAG_METADATA_FILE_NAME, this, this.file_system) as VirtualFsNode],
            ])

            var reserved_names = Array.from(sub_folders.keys()).concat(Array.from(metadata_files.keys()))
            var assets = await this.get_assets(new Set(reserved_names));
            var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualFsNode])))
            return new Map([...Array.from(sub_folders.entries()), ...Array.from(metadata_files.entries()), ...Array.from(asset_files.entries())]);
        }
        else
        {
            return sub_folders
        }
    }

    event_list_info(): VirtualFSNodeListInfo
    {
        return {
            name: this.name,
            isDir: true,
            size: 0,
            mtime: Math.floor(Date.now() / 1000),
        }
    }

    async event_stat(): Promise<VirtualFSNodeStats>
    {
        return {
            isDir: true,
            size: 0,
            mtime: Math.floor(Date.now() / 1000),
        };
    }

    async event_mkdir(folderName: string): Promise<boolean>
    {
        //Can't add tags yet
        return false
    }

    async event_delete(): Promise<boolean>
    {
        //Can't delete tags yet
        return false
    }

    async get_assets(reserved_names: Set<string>): Promise<ImmichAssetFile[]>
    {
        if (!this.node_data.tag) return [];

        const tag = this.node_data.tag;
        await this.file_system.getApi().fetchAssetsForTag(tag);

        const assets = tag.assets ?? [];
        const files = new Array<ImmichAssetFile>(assets.length);

        // Track collisions for asset filenames
        const nameCount = new Map<string, number>();

        for (let i = 0; i < assets.length; i++)
        {
            const asset = assets[i];

            let base = asset.originalFileName;

            // If the base name is reserved, force collision logic immediately
            if (reserved_names.has(base))
            {
                const count = nameCount.get(base) ?? 0;
                nameCount.set(base, count + 1);
                base = `${base} (${count + 1})`;
            }

            // Now ensure uniqueness among assets
            let finalName = base;
            let count = nameCount.get(finalName) ?? 0;

            if (count > 0)
            {
                // Already used — increment until unique
                do
                {
                    count++;
                    finalName = `${base} (${count})`;
                } while (reserved_names.has(finalName));
            }

            nameCount.set(base, count + 1);

            files[i] = new ImmichAssetFile(asset, finalName, this, this.file_system);
        }

        return files;
    }


    public get_tag_realname()
    {
        let tag_real_name;
        if (this.node_data.tag) tag_real_name = this.node_data.tag.name
        else tag_real_name = this.node_data.rawName
        return tag_real_name
    }

    public get_tag_path(): string[]
    {
        if ((this.parent as ImmichTagsDirectory) !== undefined)
        {
            return [this.get_tag_realname()]
        }
        else if ((this.parent as ImmichTagFolder) !== undefined)
        {
            return [...(this.parent as ImmichTagFolder).get_tag_path(), this.get_tag_realname()]
        }
        else throw Error("Can't figure out album path because the folder parents seem to be invalid")
    }
}

export interface ImmichTagDirectoryInfo extends ImmichTag
{
    assets?: ImmichAsset[];
    displayName?: string;
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