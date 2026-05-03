
import { VirtualDirectory } from "../../common/virtual-directory";
import { VirtualFsNode, VirtualFSNodeListInfo, VirtualFSNodeStats } from "../../common/virtual-fs-node";
import { PathUtils } from "../../utils/path-utils";
import { ImmichFileSystem } from "../immich-file-system";
import { ImmichAlbumBase } from "../utils/immich-album-utils";
import { ImmichRootDirectory } from "./root-directory";
import { ImmichAssetUtils } from "../utils/immich-asset-utils";
import { ALBUM_BROWSER_LINK_FILE_NAME, ALBUM_METADATA_FILE_NAME } from "../metadata/immich-album-metadata";
import { ImmichAsset, ImmichAssetFile } from "./asset-file";
import { ImmichAlbumFolder } from "./albums/album-folder";

export class ImmichUnsortedDirectory extends VirtualDirectory
{
    private file_system: ImmichFileSystem;
    private assets_cache: ImmichAsset[] = []

    constructor(file_system: ImmichFileSystem, root: ImmichRootDirectory)
    {
        super("unsorted", undefined, root)
        this.file_system = file_system
    }


    async event_rebuild(): Promise<Map<string, VirtualFsNode>>
    {
        var assets = await this.get_assets(new Set());
        var asset_files = new Map(assets.map(asset => ([asset.name, asset as VirtualFsNode])))
        return asset_files;
    }
    async event_stat(): Promise<VirtualFSNodeStats>
    {
        return {
            isDir: true,
            size: 0,
            mtime: Math.floor(Date.now() / 1000),
        };
    }
    async event_mkdir(filename: string): Promise<boolean>
    {
        return true
    }
    async event_moveitem(item: VirtualFsNode, destination: VirtualDirectory): Promise<boolean>
    {
        const result = super.event_moveitem(item, destination)
        this.event_refetch()
        return result
    }
    async event_moveitem_depart(item: VirtualFsNode): Promise<boolean>
    {
        if (item instanceof ImmichAssetFile)
        {
            //No need to do anything special to the item before it's move
            return true
        }
        else
        {
            return false;
        }
    }
    async event_moveitem_arrive(item: VirtualFsNode): Promise<boolean>
    {
        if (item instanceof ImmichAssetFile)
        {
            const asset = (item as ImmichAssetFile)
            await this.file_system.getApi().SERVER_AddAssetToUnsorted(asset.asset_id)
            return true
        }
        else
        {
            return false;
        }
    }
    public event_moveitem_isSendable(item: VirtualFsNode, container: VirtualDirectory): boolean
    {
        if (item instanceof ImmichAlbumFolder)
        {
            console.error("Can't move album directories yet!")
            return false;
        }
        else if (item instanceof ImmichAssetFile)
        {
            if (container instanceof ImmichAlbumFolder)
            {
                if (container.isVirtual())
                {
                    console.error("Can't move files from virtual albums yet!")
                    return false
                }
                else 
                {
                    return true
                }

            }
            else if (container instanceof ImmichUnsortedDirectory)
            {
                return true
            }
            else
            {
                console.error("Unsupported Destination Container for Move")
                return false;
            }
        }
        else
        {
            console.error("Unsupported Item for Move")
            return false;
        }
    }
    public event_moveitem_isRecievable(item: VirtualFsNode, container: VirtualDirectory): boolean
    {
        if (item instanceof ImmichAssetFile)
        {
            if (container instanceof ImmichAlbumFolder)
            {
                if (container.isVirtual())
                {
                    console.error("Can't recieve files from virtual albums yet!")
                    return false
                }
                else
                {
                    return true;
                }
            }
            else
            {
                console.error("Unsupported Source Container for Move")
                return false;
            }
        }
        else
        {
            console.error("Unsupported Item for Move")
            return false;
        }
    }
    public event_list_info(): VirtualFSNodeListInfo
    {
        return {
            name: this.name,
            isDir: true,
            size: 0,
            mtime: Math.floor(Date.now() / 1000),
        }
    }
    public event_refetch()
    {
        this.refresh_nodes()
    }

    async get_assets(reserved_names: Set<string>): Promise<ImmichAssetFile[]>
    {
        const assets = await this.file_system.getApi().fetchAssetForUnsorted();
        const files = new Array<ImmichAssetFile>(assets.length);

        // Track collisions for asset filenames
        const nameCount = new Map<string, number>();

        for (let i = 0; i < assets.length; i++)
        {
            const asset = assets[i];

            let base = asset.originalFileName;

            // If the base name is reserved, force collision logic immediately
            if (reserved_names.has(base))
            {
                const count = nameCount.get(base) ?? 0;
                nameCount.set(base, count + 1);
                base = `${base} (${count + 1})`;
            }

            // Now ensure uniqueness among assets
            let finalName = base;
            let count = nameCount.get(finalName) ?? 0;

            if (count > 0)
            {
                // Already used — increment until unique
                do
                {
                    count++;
                    finalName = `${base} (${count})`;
                } while (reserved_names.has(finalName));
            }

            nameCount.set(base, count + 1);

            files[i] = new ImmichAssetFile(asset, finalName, this, this.file_system);
        }

        return files;
    }
}