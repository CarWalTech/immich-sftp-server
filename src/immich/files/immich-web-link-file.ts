import { VirtualContentBuffer, VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { logger } from "../../logger";
import { Timestamp } from "../../utils/date-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichVirtualFile } from "../immich-virtual-file";
import { FILENAME_OPEN_IN_IMMICH } from '../utils/immich-fs-utils';

export class ImmichWebLinkFile extends ImmichVirtualFile
{


    constructor(parent: VirtualDirectory, file_system: ImmichFileSystem)
    {
        super(file_system, FILENAME_OPEN_IN_IMMICH, undefined, parent)
    }

    async event_buildlink()
    {
        return ""
    }

    async event_getmodtime()
    {
        return Timestamp.now()
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