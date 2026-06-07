import fs from "fs";
import { UserConfigLoader } from "../../config";
import { VirtualContentBuffer, VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { VirtualNode } from "../../filesystem/virtual-node";
import { logger } from "../../logger";
import { DateUtils } from "../../utils/date-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichVirtualFile } from "../immich-virtual-file";
import { FILENAME_FILESYSTEM_OPTIONS } from "../utils/immich-fs-utils";
import { ImmichAlbumsDirectory } from "./immich-albums-directory";
import { ImmichRootTrashDirectory } from "./immich-trash-directory";
import { ImmichRootUnsortedDirectory } from "./immich-unsorted-directory";

export class ImmichRootDirectory extends VirtualDirectory
{
    private file_system: ImmichFileSystem;

    private dir_albums: ImmichAlbumsDirectory;
    private dir_trash: ImmichRootTrashDirectory;
    private dir_unsorted: ImmichRootUnsortedDirectory;

    private file_metadata: ImmichRootMetadataFile;

    constructor(file_system: ImmichFileSystem)
    {
        super("")
        this.file_system = file_system

        this.dir_albums = new ImmichAlbumsDirectory(this.file_system, this);
        this.dir_unsorted = new ImmichRootUnsortedDirectory(this.file_system, this);
        this.dir_trash = new ImmichRootTrashDirectory(this.file_system, this);

        this.file_metadata = new ImmichRootMetadataFile(this.file_system, this)
    }

    async event_delete(): Promise<boolean>
    {
        logger.error('ImmichVirtualRootDirectory', 'Delete', 'this directory is read-only');
        return false
    }

    async event_createfile(filename: string, contents: VirtualContentBuffer): Promise<boolean>
    {
        logger.error('ImmichVirtualRootDirectory', 'MkDir', 'this directory is read-only');
        return false
    }

    async event_mkdir(name: string): Promise<boolean>
    {
        logger.error('ImmichVirtualRootDirectory', 'MkDir', 'this directory is read-only');
        return false
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_ro(this.name, DateUtils.getTimestampNow());
    }

    async event_rebuild()
    {
        return new Map([
            [this.dir_albums.name, this.dir_albums as VirtualNode],
            [this.dir_unsorted.name, this.dir_unsorted as VirtualNode],
            [this.dir_trash.name, this.dir_trash as VirtualNode],
            [this.file_metadata.name, this.file_metadata as VirtualNode],
        ]);
    }

}

export class ImmichRootMetadataFile extends ImmichVirtualFile
{
    private root_folder: ImmichRootDirectory;

    constructor(file_system: ImmichFileSystem, parent: ImmichRootDirectory)
    {
        super(file_system, FILENAME_FILESYSTEM_OPTIONS, undefined, parent);
        this.root_folder = parent;
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
        const metadata = UserConfigLoader.load_user_json(this.file_system.getCurrentUser()?.id);
        return VirtualMetadata.file_rw(this.name, Buffer.byteLength(metadata, 'utf8'), DateUtils.getTimestampNow());
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        const metadata = UserConfigLoader.load_user_json(this.file_system.getCurrentUser()?.id);
        return VirtualContentBufferUtils.bufferFromString(metadata);
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        const content = fs.readFileSync(contents.name, 'utf8');
        const metadata = UserConfigLoader.load_user_from_json(content);
        UserConfigLoader.save_user(this.file_system.getCurrentUser()?.id, this.file_system.getCurrentUserView(), metadata);
        this.file_system.getApi().CACHE_InvalidateUserConfig();
        contents.removeCallback();
        this.root_folder.refresh();
        return true;
    }
    async event_delete(): Promise<boolean>
    {
        return true;
    }
}
