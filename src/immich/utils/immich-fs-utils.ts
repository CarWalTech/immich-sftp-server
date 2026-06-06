import { logger } from "../../logger";
import { VirtualDirectory } from "../../filesystem/virtual-directory";
import { VirtualNode } from "../../filesystem/virtual-node";
import { ImmichAlbumFolder } from "../collections/immich-album-folder";
import { ImmichVirtualAssetFile } from "../collections/immich-virtual-asset-file";
import { ImmichRootTrashDirectory, ImmichRootUnsortedDirectory } from "../collections/immich-root-commons";
import { ImmichAPI } from "../immich-api";
import tmp from "tmp"
import path from "path";

export const FILENAME_FILESYSTEM_OPTIONS = '[SETTINGS].json';
export const FILENAME_ALBUM_PROPERTIES = '[ALBUM].yaml';
export const FILENAME_OPEN_IN_IMMICH = '[IMMICH].html';

export const DIRNAME_ALBUMS = "Albums"
export const DIRNAME_TRASH = "Trash"
export const DIRNAME_UNSORTED = "Unsorted"

export async function deleteAssetFromContainer(item: ImmichVirtualAssetFile, api: ImmichAPI, container: VirtualDirectory): Promise<boolean>
{
    if (item.asset_data)
    {
        if (container instanceof ImmichAlbumFolder)
        {
            const info = (container as ImmichAlbumFolder).get_album_data().album ?? undefined
            if (info !== undefined)
            {
                await api.SERVER_DeleteAssetFromAlbum(info, item.asset_data);
                return true;
            }
            else return false
        }
        else if (container instanceof ImmichRootUnsortedDirectory)
        {
            await api.SERVER_DeleteAsset(item.asset_data);
            container.refresh()
            return true;
        }
        return true
    }
    return false
}

export function canSendAssetTo(item: ImmichVirtualAssetFile, container: VirtualDirectory)
{
    if (container instanceof ImmichAlbumFolder)
    {
        return true;

    }
    else if (container instanceof ImmichRootTrashDirectory)
    {
        return true;
    }
    else if (container instanceof ImmichRootUnsortedDirectory)
    {
        return true
    }
    else
    {
        logger.warn('ImmichFsUtils', 'canSendFileTo', "Unsupported Destination Container for Move")
        return false;
    }
}
export function canRecieveAssetFrom(item: ImmichVirtualAssetFile, container: VirtualDirectory)
{
    if (container instanceof ImmichAlbumFolder)
    {
        if (container.get_album_data().album === undefined)
        {
            logger.warn('ImmichFsUtils', 'canRecieveFileFrom', "Can't recieve files from virtual albums yet!")
            return false
        }
        else
        {
            return true;
        }
    }
    else if (container instanceof ImmichRootTrashDirectory)
    {
        return true;
    }
    else if (container instanceof ImmichRootUnsortedDirectory)
    {
        return true;
    }
    else
    {
        logger.warn('ImmichFsUtils', 'canRecieveFileFrom', "Unsupported Source Container for Move")
        return false;
    }
}

export function canSendFileTo(item: VirtualNode, container: VirtualDirectory)
{
    if (item instanceof ImmichAlbumFolder)
    {
        logger.warn('ImmichFsUtils', 'canSendFileTo', "Can't move album directories yet!")
        return false;
    }
    else if (item instanceof ImmichVirtualAssetFile)
    {
        return canSendAssetTo(item, container);
    }
    else
    {
        logger.warn('ImmichFsUtils', 'canSendFileTo', "Unsupported Item for Move")
        return false;
    }
}
export function canRecieveFileFrom(item: VirtualNode, container: VirtualDirectory)
{
    if (item instanceof ImmichVirtualAssetFile)
    {
        return canRecieveAssetFrom(item, container);
    }
    else
    {
        logger.warn('ImmichFsUtils', 'canRecieveFileFrom', "Unsupported Item for Move")
        return false;
    }
}



