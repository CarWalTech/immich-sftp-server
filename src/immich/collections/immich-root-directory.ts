import { FileResult } from "tmp";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichAlbumsDirectory } from "./immich-albums-directory";
import { ImmichTagsDirectory } from "./immich-tags-directory";
import { ImmichRootTrashDirectory, ImmichRootUnsortedDirectory } from "./immich-root-commons";
import { logger } from "../../logger";
import { ImmichRootMetadataFile } from "./immich-root-metadata";

export class ImmichRootDirectory extends VirtualDirectory
{
    private file_system: ImmichFileSystem;

    private dir_albums: ImmichAlbumsDirectory;
    private dir_tags: ImmichTagsDirectory;
    private dir_trash: ImmichRootTrashDirectory;
    private dir_unsorted: ImmichRootUnsortedDirectory;

    private file_metadata: ImmichRootMetadataFile;

    constructor(file_system: ImmichFileSystem)
    {
        super("")
        this.file_system = file_system

        this.dir_albums = new ImmichAlbumsDirectory(this.file_system, this);
        this.dir_tags = new ImmichTagsDirectory(this.file_system, this);
        this.dir_unsorted = new ImmichRootUnsortedDirectory(this.file_system, this);
        this.dir_trash = new ImmichRootTrashDirectory(this.file_system, this);

        this.file_metadata = new ImmichRootMetadataFile(this.file_system, this)
    }

    async event_list(): Promise<VirtualMetadata[]>
    {
        const visibility = await this.file_system.getUserDisplaySettings();
        let rootEntries = await super.event_list()

        if (!visibility.tagsEnabled) rootEntries = rootEntries.filter(x => x.name != this.dir_tags.name)
        return rootEntries;
    }

    async event_delete(): Promise<boolean>
    {
        logger.error('ImmichVirtualRootDirectory', 'Delete', 'this directory is read-only');
        return false
    }

    async event_createfile(filename: string, contents: FileResult): Promise<boolean>
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
        return VirtualMetadata.directory_ro(this.name, Math.floor(Date.now() / 1000));
    }

    async event_rebuild()
    {
        return new Map([
            [this.dir_albums.name, this.dir_albums as VirtualNode],
            [this.dir_tags.name, this.dir_tags as VirtualNode],
            [this.dir_unsorted.name, this.dir_unsorted as VirtualNode],
            [this.dir_trash.name, this.dir_trash as VirtualNode],
            [this.file_metadata.name, this.file_metadata as VirtualNode],
        ]);
    }

}