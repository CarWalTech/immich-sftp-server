import tmp from 'tmp';
import { VirtualFile } from "../../filesystem/virtual-file";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { ImmichFileSystem } from "../immich-file-system";
import { VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { ImmichTagFolder } from "./immich-tag-folder";
import { ImmichTagDirectoryInfo } from "../utils/immich-api-utils";
import { buildTagMetadataYamlForTag, TAG_METADATA_FILE_NAME } from "../utils/immich-metadata-utils";
import { getTagMtime } from "../utils/immich-api-utils";
import { logger } from "../../logger";

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

    async event_setattr(attr: VirtualMetadata): Promise<boolean>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        return true;
    }
    async event_rename(new_name: string): Promise<boolean>
    {
        logger.error('ImmichTagMetadataFile', 'Rename', 'Renaming metadata files is not allowed');
        return false;
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        const metadata = buildTagMetadataYamlForTag(this.tag, this.file_system.getCurrentUser(), this.file_system.getUrl());
        return VirtualMetadata.file_ro(this.name, Buffer.byteLength(metadata, 'utf8'), getTagMtime(this.tag))
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        return VirtualContentBufferUtils.bufferFromString(buildTagMetadataYamlForTag(this.tag, this.file_system.getCurrentUser(), this.file_system.getUrl()));
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        //Writing not possible yet
        return false;
    }
    async event_delete(): Promise<boolean>
    {
        //Since this is virtual, allow for it's removal without doing anything
        return true
    }
}