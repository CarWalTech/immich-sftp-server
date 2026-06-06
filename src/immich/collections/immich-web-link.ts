import { VirtualFile } from "../../filesystem/virtual-file";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { VirtualContentBuffer } from "../../filesystem/virtual-content-buffer";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { getAlbumMtime, ImmichAlbumBase } from "../utils/immich-api-utils";
import { ImmichRootDirectory } from "./immich-root-directory";
import { FILENAME_OPEN_IN_IMMICH } from '../utils/immich-fs-utils';
import { VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { buildAlbumBrowserLink } from "../utils/immich-metadata-utils";
import { ImmichAlbumDirectoryInfo } from '../utils/immich-api-utils';
import { logger } from "../../logger";
import { ImmichAlbumFolder } from "./immich-album-folder";
import { DateUtils } from "../../utils/date-utils";

export class ImmichWebLinkFile extends VirtualFile
{
    file_system: ImmichFileSystem

    constructor(parent: VirtualDirectory, file_system: ImmichFileSystem)
    {
        super(FILENAME_OPEN_IN_IMMICH, undefined, parent)
        this.file_system = file_system
    }

    async event_buildlink()
    {
        return ""
    }

    async event_getmodtime()
    {
        return DateUtils.getTimestampNow()
    }

    async event_readlink()
    {
        return ""
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        const link = await this.event_buildlink();
        const mtime = await this.event_getmodtime();
        return VirtualMetadata.file_ro(this.name, Buffer.byteLength(link, 'utf8'), mtime);
    }
    async event_rename(new_name: string): Promise<boolean>
    {
        //Since this is virtual, ignore
        logger.error('ImmichWebLinkFile', 'Rename', 'Renaming link files is not allowed');
        return false;
    }
    async event_setattr(attr: VirtualMetadata): Promise<boolean>
    {
        // Metadata/link files are applied on CLOSE and don't need SETSTAT handling
        return true;
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        const result = await this.event_readlink()
        return VirtualContentBufferUtils.bufferFromString(result);
    }
    async event_writefile(contents: VirtualContentBuffer): Promise<boolean>
    {
        //Since this is virtual, reject
        return false;
    }
    async event_delete(): Promise<boolean>
    {
        //Since this is virtual, ignore
        return false;
    }
}