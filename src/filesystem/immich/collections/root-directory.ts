import { FileResult } from "tmp";
import { VirtualDirectory } from "../../common/virtual-directory";
import { VirtualFsNode, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../common/virtual-fs-node";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichAlbumsDirectory } from "./albums/albums-directory";
import { ImmichTagsDirectory } from "./tags/tags-directory";
import { ImmichUnsortedDirectory } from "./unsorted-directory";

export class ImmichRootDirectory extends VirtualDirectory
{
    private file_system: ImmichFileSystem;

    private albums_dir: ImmichAlbumsDirectory;
    private tags_dir: ImmichTagsDirectory;
    private unsorted_dir: ImmichUnsortedDirectory;

    constructor(file_system: ImmichFileSystem)
    {
        super("")
        this.file_system = file_system

        this.albums_dir = new ImmichAlbumsDirectory(this.file_system, this);
        this.tags_dir = new ImmichTagsDirectory(this.file_system, this);
        this.unsorted_dir = new ImmichUnsortedDirectory(this.file_system, this);
    }

    async event_list(): Promise<VirtualFSNodeListInfo[]>
    {
        const visibility = await this.file_system.getUserDisplaySettings();
        let rootEntries = await super.event_list()

        if (!visibility.tagsEnabled) rootEntries = rootEntries.filter(x => x.name != this.tags_dir.name)
        return rootEntries;
    }

    async event_delete(): Promise<boolean>
    {
        console.error("this directory is read-only")
        return false
    }

    async event_createfile(name: string, contents: FileResult): Promise<boolean>
    {
        console.error("this directory is read-only")
        return false
    }

    async event_mkdir(name: string): Promise<boolean>
    {
        console.error("this directory is read-only")
        return false
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

    async event_rebuild()
    {
        return new Map([
            [this.albums_dir.name, this.albums_dir as VirtualDirectory],
            [this.tags_dir.name, this.tags_dir as VirtualDirectory],
            [this.unsorted_dir.name, this.unsorted_dir as VirtualDirectory]
        ]);
    }

}