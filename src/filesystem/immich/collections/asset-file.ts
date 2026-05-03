import { VirtualFile } from "../../common/virtual-file";
import { VirtualDirectory } from "../../common/virtual-directory";
import { VirtualFsNode, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../common/virtual-fs-node";
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichAlbumBase } from "../utils/immich-album-utils";
import { ImmichRootDirectory } from "./root-directory";
import { ImmichAssetUtils } from "../utils/immich-asset-utils";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../metadata/immich-album-metadata";
import { FileResult } from "tmp";

export class ImmichAssetFile extends VirtualFile
{
    private asset: ImmichAsset
    private file_system: ImmichFileSystem

    constructor(asset: ImmichAsset, fsName: string, parent: VirtualDirectory, file_system: ImmichFileSystem)
    {
        super(fsName, ImmichAssetUtils.getAssetMtime(asset), parent)
        this.file_system = file_system
        this.asset = asset
    }

    get asset_id()
    {
        return this.asset.id
    }

    event_list_info(): VirtualFSNodeListInfo
    {
        return {
            name: this.name,
            isDir: false,
            size: this.asset.fileSizeInByte,
            mtime: ImmichAssetUtils.getAssetMtime(this.asset),
        }
    }

    async event_stat(): Promise<VirtualFSNodeStats>
    {
        return {
            isDir: false,
            size: this.asset.fileSizeInByte,
            mtime: ImmichAssetUtils.getAssetMtime(this.asset)
        }
    }

    async event_readfile(): Promise<FileResult>
    {
        console.warn(`read-asset: ${this.asset.originalFileName}`)
        return await this.file_system.getApi().SERVER_ReadAsset(this.asset)
    }
}

export interface ImmichAsset
{
    id: string;
    originalFileName: string;
    createdAt?: string;
    updatedAt?: string;
    fileCreatedAt: string;
    fileModifiedAt: string;
    fileSizeInByte: number;
    isTrashed: boolean;
}