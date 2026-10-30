import fs from "fs";
import { UserConfigLoader } from "../../config";
import { VirtualContentBuffer, VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualMetadata } from '../../filesystem/virtual-metadata';
import { VirtualNode } from "../../filesystem/virtual-node";
import { logger } from "../../logger";
import { Timestamp } from "../../utils/date-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichVirtualFile } from "../immich-virtual-file";
import { FILENAME_FILESYSTEM_OPTIONS } from "../utils/immich-fs-utils";
import { ImmichAlbumsDirectory } from "./immich-albums-directory";
import { ImmichDigikamTrashDirectory } from "./immich-digikam-trash-directory";
import { ImmichRootTrashDirectory } from "./immich-trash-directory";
import { ImmichRootUnsortedDirectory } from "./immich-unsorted-directory";

export class ImmichRootDirectory extends VirtualDirectory
{
    private file_system: ImmichFileSystem;

    private dir_albums: ImmichAlbumsDirectory;
    private dir_unsorted: ImmichRootUnsortedDirectory;
    private file_metadata: ImmichRootMetadataFile;
    // Built on first use and then reused.  Re-creating them per rebuild reset
    // their mtime to "now" every time the root was listed, which reads to a sync
    // client as the trash folder having just changed.
    private dir_trash?: ImmichRootTrashDirectory;
    private dir_digikam_trash?: ImmichDigikamTrashDirectory;

    constructor(file_system: ImmichFileSystem)
    {
        super("")
        this.file_system = file_system

        this.dir_albums = new ImmichAlbumsDirectory(this.file_system, this);
        this.dir_unsorted = new ImmichRootUnsortedDirectory(this.file_system, this);

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
        return VirtualMetadata.directory_ro(this.name, this.mtime);
    }

    async event_rebuild()
    {
        var result = new Map([
            [this.dir_albums.name, this.dir_albums as VirtualNode],
            [this.dir_unsorted.name, this.dir_unsorted as VirtualNode],
            [this.file_metadata.name, this.file_metadata as VirtualNode],
        ]);

        if (this.file_system.getUserSettings().digikamTrashCompat)
        {
            if (!this.dir_digikam_trash) this.dir_digikam_trash = new ImmichDigikamTrashDirectory(this.file_system, this);
            result.set(this.dir_digikam_trash.name, this.dir_digikam_trash as VirtualNode)
        }
        else
        {
            if (!this.dir_trash) this.dir_trash = new ImmichRootTrashDirectory(this.file_system, this);
            result.set(this.dir_trash.name, this.dir_trash as VirtualNode)
        }

        return result
    }

}

export class ImmichRootMetadataFile extends ImmichVirtualFile
{
    private root_folder: ImmichRootDirectory;

    // Timestamp of the last time the rendered settings actually changed.  Using
    // Timestamp.now() here meant the file's mtime — and therefore its etag — was
    // different on every single request, so clients re-fetched it continuously.
    private rendered?: { json: string; mtime: Timestamp };

    constructor(file_system: ImmichFileSystem, parent: ImmichRootDirectory)
    {
        super(file_system, FILENAME_FILESYSTEM_OPTIONS, undefined, parent);
        this.root_folder = parent;
    }

    private render(): { json: string; mtime: Timestamp }
    {
        const json = UserConfigLoader.load_user_json(this.file_system.getCurrentUser()?.id, this.file_system.getCurrentUserView());
        if (!this.rendered || this.rendered.json !== json)
            this.rendered = { json, mtime: Timestamp.now() };
        return this.rendered;
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
        const { json, mtime } = this.render();
        return VirtualMetadata.file_rw(this.name, Buffer.byteLength(json, 'utf8'), mtime);
    }
    async event_readfile(): Promise<VirtualContentBuffer>
    {
        return VirtualContentBufferUtils.bufferFromString(this.render().json);
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
