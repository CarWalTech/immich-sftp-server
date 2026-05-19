import { VirtualFile } from "../../filesystem/virtual-file";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { getAlbumMtime, ImmichAlbumBase } from "../utils/immich-api-utils";
import { ImmichRootDirectory } from "./immich-root-directory";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../utils/immich-metadata-utils";
import tmp from 'tmp';
import { VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { saveAlbumMetadataFileContent, buildAlbumBrowserLinkForAlbum, buildAlbumMetadataYamlForAlbum } from "../utils/immich-metadata-utils";
import { ImmichAlbumFolder } from "./immich-album-folder";
import { ImmichAlbumDirectoryInfo } from '../utils/immich-api-utils';
import fs from 'fs';
import { logger } from "../../logger";
import { config, UserConfigLoader, UserConfig } from "../../config";
import { DateUtils } from "../../utils/date-utils";

export class ImmichRootMetadataFile extends VirtualFile
{
    private file_system: ImmichFileSystem
    private root_folder: ImmichRootDirectory

    constructor(file_system: ImmichFileSystem, parent: ImmichRootDirectory)
    {
        super("settings.yaml", undefined, parent)
        this.root_folder = parent
        this.file_system = file_system
    }

    async event_setattr(attr: VirtualMetadata): Promise<boolean>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        return true;
    }
    async event_rename(new_name: string): Promise<boolean>
    {
        logger.error('ImmichRootMetadataFile', 'Rename', 'Renaming metadata files is not allowed');
        return false;
    }
    async event_stat(): Promise<VirtualMetadata>
    {
        const metadata = UserConfigLoader.load_user_yaml(this.file_system.getCurrentUser()?.id)
        return VirtualMetadata.file_rw(this.name, Buffer.byteLength(metadata, 'utf8'), DateUtils.getDateTimeNow());
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        const metadata = UserConfigLoader.load_user_yaml(this.file_system.getCurrentUser()?.id)
        return VirtualContentBufferUtils.bufferFromString(metadata);
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        const content = fs.readFileSync(contents.name, 'utf8');
        const metadata = UserConfigLoader.load_user_from_yaml(content)
        UserConfigLoader.save_user(this.file_system.getCurrentUser()?.id, metadata)
        contents.removeCallback();
        this.root_folder.refresh()
        return true;
    }
    async event_delete(): Promise<boolean>
    {
        return true
    }
}