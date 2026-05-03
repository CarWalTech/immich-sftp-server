import tmp from 'tmp';
import { VirtualFile } from "../../../common/virtual-file";
import { VirtualFSNodeAttributes, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../../common/virtual-fs-node";
import { ImmichFileSystem } from "../../immich-file-system";
import { FileUtils } from "../../../utils/file-utils";
import { ImmichTagDirectoryInfo, ImmichTagFolder } from "./tag-folder";
import { buildTagMetadataYamlForTag, TAG_METADATA_FILE_NAME } from "../../metadata/immich-tag-metadata-service";
import { getTagMtime } from "../../utils/immich-tag-utils";

export class ImmichTagMetadataFile extends VirtualFile
{
    private tag: ImmichTagDirectoryInfo
    private file_system: ImmichFileSystem
    private tag_folder: ImmichTagFolder

    public static readonly TAG_METADATA_FILE_NAME = 'tag.yaml';

    constructor(tag: ImmichTagDirectoryInfo, fsName: string, parent: ImmichTagFolder, file_system: ImmichFileSystem)
    {
        super(fsName, undefined, parent)
        this.tag_folder = parent
        this.file_system = file_system
        this.tag = tag
    }

    event_list_info(): VirtualFSNodeListInfo
    {
        const metadataContent = buildTagMetadataYamlForTag(this.tag, this.file_system.getCurrentUser(), this.file_system.getUrl());
        return {
            name: TAG_METADATA_FILE_NAME,
            isDir: false,
            size: Buffer.byteLength(metadataContent, 'utf8'),
            mtime: getTagMtime(this.tag),
        }
    }

    async event_setattr(attr: VirtualFSNodeAttributes): Promise<boolean>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        return true;
    }

    async event_rename(new_name: string): Promise<boolean>
    {
        //Since this is virtual, ignore
        console.error('Renaming metadata files is not allowed');
        return true;
    }

    async event_stat(): Promise<VirtualFSNodeStats>
    {
        const metadata = buildTagMetadataYamlForTag(this.tag, this.file_system.getCurrentUser(), this.file_system.getUrl());
        return {
            isDir: false,
            size: Buffer.byteLength(metadata, 'utf8'),
            mtime: getTagMtime(this.tag),
        };
    }

    async event_readfile(): Promise<tmp.FileResult>
    {
        return FileUtils.createTmpFile(buildTagMetadataYamlForTag(this.tag, this.file_system.getCurrentUser(), this.file_system.getUrl()));
    }

    async event_writefile(contents: tmp.FileResult): Promise<boolean>
    {
        //Writing not possible yet
        return false;
    }

    async event_delete(): Promise<boolean>
    {
        //Since this is virtual, allow for it's removal without doing anything
        return true
    }


    async event_event_delete_from_parent(): Promise<boolean>
    {
        //Since this is virtual, allow for it's removal without doing anything
        return true
    }
}