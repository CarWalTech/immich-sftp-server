import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichAlbumsDirectory } from "./immich-albums-directory";
import { ImmichRootTrashDirectory, ImmichRootUnsortedDirectory } from "./immich-root-commons";
import { logger } from "../../logger";
import { ImmichRootMetadataFile } from "./immich-root-metadata";
import { DateUtils } from "../../utils/date-utils";

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