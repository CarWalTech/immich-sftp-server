import crypto from 'crypto';
import { VirtualContentBufferUtils } from "../../filesystem/virtual-content-buffer";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualMetadata } from "../../filesystem/virtual-metadata";
import { VirtualNode } from "../../filesystem/virtual-node";
import { Timestamp } from "../../utils/date-utils";
import { ImmichAssetFile } from "../files/immich-asset-file";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichVirtualDirectory } from "../immich-virtual-directory";
import { ImmichVirtualFile } from "../immich-virtual-file";
import { getAssetMtime } from "../utils/immich-api-utils";
import { ImmichRootDirectory } from "./immich-root-directory";

const DIRNAME_DIGIKAM_TRASH = '.dtrash';
const DIRNAME_DIGIKAM_FILES = 'files';
const DIRNAME_DIGIKAM_INFO = 'info';
const FILENAME_DIGIKAM_UUID = 'digikam.uuid';

function canDigikamSendFile(item: VirtualNode, _: VirtualDirectory): boolean
{
    return item instanceof ImmichAssetFile;
}
function canDigikamReceiveFile(item: VirtualNode, _: VirtualDirectory): boolean
{
    return item instanceof ImmichAssetFile;
}

function buildDtrashUUID(seed: string): string
{
    const h = crypto.createHash('sha1').update(seed).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function buildDtrashTimestamp(isoString: string | undefined): string
{
    // DigiKam expects "YYYY-MM-DDTHH:mm:ss" — no milliseconds, no timezone suffix
    const src = isoString ?? new Date().toISOString();
    return src.slice(0, 19);
}

// ─── .dtrash (root) ──────────────────────────────────────────────────────────

export class ImmichDigikamTrashDirectory extends ImmichVirtualDirectory
{
    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super(file_system, DIRNAME_DIGIKAM_TRASH, undefined, root);
    }

    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        const filesDir = new ImmichDigikamFilesDirectory(this.file_system, this);
        const infoDir = new ImmichDigikamInfoDirectory(this.file_system, this, filesDir);
        const uuidFile = new ImmichDigikamUuidFile(this.file_system, this);
        return new Map<string, VirtualNode>([
            [FILENAME_DIGIKAM_UUID, uuidFile],
            [DIRNAME_DIGIKAM_FILES, filesDir],
            [DIRNAME_DIGIKAM_INFO, infoDir],
        ]);
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(this.name, this.mtime);
    }

    async event_mkdir(_: string): Promise<boolean>
    {
        return false;
    }
}

// ─── .dtrash/files ───────────────────────────────────────────────────────────

export class ImmichDigikamFilesDirectory extends ImmichVirtualDirectory
{
    constructor(file_system: ImmichFileSystem, parent: ImmichDigikamTrashDirectory)
    {
        super(file_system, DIRNAME_DIGIKAM_FILES, undefined, parent, {
            sendFn: canDigikamSendFile,
            recieveFn: canDigikamReceiveFile,
            refreshOnMove: true,
            refreshOnReadDir: true,
        });
    }

    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        const assets = await this.file_system.getApi().FETCH_AssetsForTrash(this, new Set());
        return new Map(assets.map(a => [a.name, a as VirtualNode]));
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_rw(this.name, this.mtime);
    }

    async event_mkdir(_: string): Promise<boolean>
    {
        return false;
    }

    async event_sendnode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichAssetFile)
        {
            await this.file_system.getApi().SERVER_RestoreAsset(item.asset_id);
            return true;
        }
        return false;
    }

    async event_recievenode(item: VirtualNode): Promise<boolean>
    {
        if (item instanceof ImmichAssetFile)
        {
            await this.file_system.getApi().SERVER_DeleteAsset(item.asset_data);
            return true;
        }
        return false;
    }
}

// ─── .dtrash/info ────────────────────────────────────────────────────────────

export class ImmichDigikamInfoDirectory extends ImmichVirtualDirectory
{
    private readonly files_dir: ImmichDigikamFilesDirectory;

    constructor(file_system: ImmichFileSystem, parent: ImmichDigikamTrashDirectory, files_dir: ImmichDigikamFilesDirectory)
    {
        super(file_system, DIRNAME_DIGIKAM_INFO, undefined, parent, { refreshOnReadDir: true });
        this.files_dir = files_dir;
    }

    async event_rebuild(): Promise<Map<string, VirtualNode>>
    {
        // Use files_dir as the parent so this shares the same asset cache as files/
        const assets = await this.file_system.getApi().FETCH_AssetsForTrash(this.files_dir, new Set());
        const entries = assets
            .filter((a): a is ImmichAssetFile => a instanceof ImmichAssetFile)
            .map(a =>
            {
                const info = new ImmichDigikamTrashInfoFile(a, this, this.file_system);
                return [info.name, info as VirtualNode] as const;
            });
        return new Map(entries);
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.directory_ro(this.name, this.mtime);
    }

    async event_mkdir(_: string): Promise<boolean>
    {
        return false;
    }
}

// ─── .dtrash/digikam.uuid ────────────────────────────────────────────────────

class ImmichDigikamUuidFile extends ImmichVirtualFile
{
    constructor(file_system: ImmichFileSystem, parent: ImmichDigikamTrashDirectory)
    {
        super(file_system, FILENAME_DIGIKAM_UUID, undefined, parent);
    }

    private get content(): string
    {
        return buildDtrashUUID(this.file_system.getUrl());
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        return VirtualMetadata.file_ro(this.name, Buffer.byteLength(this.content, 'utf8'), Timestamp.now());
    }

    async event_readfile()
    {
        return VirtualContentBufferUtils.bufferFromString(this.content);
    }

    async event_delete(): Promise<boolean>
    {
        return false;
    }
}

// ─── .dtrash/info/<name>.dtrashinfo ──────────────────────────────────────────

class ImmichDigikamTrashInfoFile extends ImmichVirtualFile
{
    private readonly asset_file: ImmichAssetFile;

    constructor(asset_file: ImmichAssetFile, parent: ImmichDigikamInfoDirectory, file_system: ImmichFileSystem)
    {
        const baseName = asset_file.name.replace(/\.[^.]+$/, '');
        super(file_system, `${baseName}.dtrashinfo`, getAssetMtime(asset_file.asset_data), parent);
        this.asset_file = asset_file;
    }

    private buildContent(): string
    {
        const asset = this.asset_file.asset_data;
        return JSON.stringify({
            deletiontimestamp: buildDtrashTimestamp(asset.updatedAt ?? asset.fileCreatedAt),
            imageid: asset.id,
            path: asset.originalPath,
        }, null, 4);
    }

    async event_stat(): Promise<VirtualMetadata>
    {
        const content = this.buildContent();
        return VirtualMetadata.file_ro(this.name, Buffer.byteLength(content, 'utf8'), getAssetMtime(this.asset_file.asset_data));
    }

    async event_readfile()
    {
        return VirtualContentBufferUtils.bufferFromString(this.buildContent());
    }

    async event_delete(): Promise<boolean>
    {
        return false;
    }
}
