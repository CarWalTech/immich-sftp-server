import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichAssetUtils } from "../utils/immich-asset-utils";
import { ImmichVirtualAssetFile } from "./immich-virtual-asset-file";
import { ImmichTagsDirectory } from "./immich-tags-directory";
import { ImmichTagMetadataFile } from "./immich-tag-metadata";
import { TAG_METADATA_FILE_NAME } from "../utils/immich-metadata-utils";
import { collectTaggedAssets, ImmichTagsDirectoryNode } from "../utils/immich-api-utils";

export class ImmichTagFolder extends VirtualDirectory
{
    readonly file_system: ImmichFileSystem;
    readonly tags_root: ImmichTagsDirectory;
    readonly node_data: ImmichTagsDirectoryNode;

    constructor(file_system: ImmichFileSystem, albums_root: ImmichTagsDirectory, parent: ImmichTagsDirectory | ImmichTagFolder, node: ImmichTagsDirectoryNode)
    {
        super(node.fsName, undefined, parent)
        this.node_data = node
        this.tags_root = albums_root
        this.file_system = file_system
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

    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        var sub_folders = new Map([...this.node_data.children.values()].map(node => ([node.fsName, new ImmichTagFolder(this.file_system, this.tags_root, this, node) as VirtualNode])))
        if (this.node_data.tag)
        {
            var metadata_files = new Map([
                [TAG_METADATA_FILE_NAME, new ImmichTagMetadataFile(this.node_data.tag, TAG_METADATA_FILE_NAME, this, this.file_system) as VirtualNode],
            ])

            var reserved_names = Array.from(sub_folders.keys()).concat(Array.from(metadata_files.keys()))
            var assets = await collectTaggedAssets(this, new Set(reserved_names));
            var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualNode])))
            return new Map([...Array.from(sub_folders.entries()), ...Array.from(metadata_files.entries()), ...Array.from(asset_files.entries())]);
        }
        else
        {
            return sub_folders
        }
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_ro(this.name, Math.floor(Date.now() / 1000));
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




}


