
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichRootDirectory } from "./immich-root-directory";
import { ImmichAlbumFolder } from "./immich-album-folder";
import { ImmichAlbumDirectoryInfo } from '../utils/immich-api-utils';
import { ImmichAlbumsDirectoryNode } from "../utils/immich-api-utils";
import { ImmichVirtualDirectory } from "./immich-virtual-directory";
import { DateUtils } from "../../utils/date-utils";
import { DIRNAME_ALBUMS } from "../utils/immich-fs-utils";

export class ImmichAlbumsDirectory extends ImmichVirtualDirectory
{
    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super(file_system, DIRNAME_ALBUMS, undefined, root, { refreshOnReadDir: true })
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_ro(this.name, DateUtils.getTimestampNow())
    }
    async event_mkdir(albumName: string): Promise<boolean>
    {
        await this.file_system.getApi().SERVER_CreateAlbum(albumName)
        this.refresh()
        return true
    }
    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        const current_file_tree = await this.file_system.getApi().FETCH_AlbumVirtualTree();
        if (!current_file_tree) return new Map()
        return new Map([...current_file_tree.children.values()].map(node => ([node.fsName, new ImmichAlbumFolder(this.file_system, this, this, node)])))
    }
}

