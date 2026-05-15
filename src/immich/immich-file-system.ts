import { VirtualFileSystem } from "../filesystem/virtual-file-system";
import { config, UserDisplaySettings } from '../config';
import tmp from 'tmp';
import { ImmichAPI } from "./immich-api";
import { VirtualDirectory } from "../filesystem/virtual-directory";
import { VirtualPathInfo } from "../filesystem/virtual-path-info";
import { VirtualFile } from "../filesystem/virtual-file";
import { ImmichRootDirectory } from "./collections/immich-root-directory";
import { ImmichWritableMemory } from "./immich-writable-memory";
import { VirtualFsUtils } from "../utils/virtual-fs-utils";
import { logger } from "../logger";
import { VirtualContentBuffer } from "../filesystem/virtual-content-buffer";
import { ImmichSessionCache } from "./immich-session-cache";
import { PathUtils } from "../utils/path-utils";
import { VirtualNode } from "../filesystem/virtual-node";
import { ImmichVirtualAssetFile } from "./collections/immich-virtual-asset-file";
import { dirname } from "path";


export class ImmichFileSystem implements VirtualFileSystem
{
    private immichApi: ImmichAPI
    private root: ImmichRootDirectory
    memory: ImmichWritableMemory

    constructor()
    {
        this.root = new ImmichRootDirectory(this);
        this.immichApi = new ImmichAPI(config.immichHost.replace(/\/+$/, ''));
        this.memory = new ImmichWritableMemory(this);
    }


    // VirtualFileSystem Methods
    async login(username: string, password: string): Promise<void>
    {
        return await this.immichApi.login(username, password)
    }

    async logout(): Promise<void>
    {
        await this.immichApi.logout();
        await this.root.event_logout();
    }
    async setAttributes(filename: string, mtime: number)
    {
        const { parent, node, name } = await VirtualFsUtils.resolvePath(this.root, filename);
        if (node)
        {
            //TODO: Set Attributes Better Implementation
            //await node.event_setattr({ mtime: mtime })
        }
    }
    async listFiles(currentDir: string)
    {
        const { node } = await VirtualFsUtils.resolvePath(this.root, currentDir);
        if (!node || !node.isDir()) throw new Error(`Not a directory: ${currentDir}`);

        const result = await (node as VirtualDirectory).event_list()
        if (result) return result
        else throw new Error("Unable to process event list")
    }
    async readFile(filename: string)
    {
        const tmp_result = await this.memory.read(filename)
        if (tmp_result) return tmp_result;

        const { node } = await VirtualFsUtils.resolvePath(this.root, filename);
        if (!node || node.isDir()) throw new Error(`Not a file: ${filename}`);

        const file = (node as VirtualFile);
        return await file.event_readfile();
    }
    async writeFile(filename: string, tmpFile: VirtualContentBuffer)
    {
        const is_tmp = await this.memory.write(filename, tmpFile)
        if (is_tmp) return;

        const { parent, node, name } = await VirtualFsUtils.resolvePath(this.root, filename);

        if (node && !node.isDir())
        {
            await (node as VirtualFile).event_writefile(tmpFile);

            this.getCache().invalidateAssetNode(node);
            this.getCache().invalidateFilePath(filename);
            return;
        }

        if (parent && parent.isDir())
        {
            await parent.event_createfile(name, tmpFile);

            this.getCache().invalidateDirectoryPath(parent.fullpath);
            this.getCache().invalidateFilePath(filename);

            await this.memory.flushQueued(filename);
            return;
        }

        throw new Error("Cannot write to destination");
    }
    async stat(filename: string)
    {
        const tmp_result = await this.memory.stat(filename)
        if (tmp_result) return tmp_result;

        const { node } = await VirtualFsUtils.resolvePath(this.root, filename);
        if (!node) throw new Error(`File not found: ${filename}`);
        return await node.event_stat();
    }
    async rename(oldFileName: string, newFileName: string)
    {
        const tmp_result = await this.memory.rename(oldFileName, newFileName)
        if (tmp_result) return tmp_result;

        const oldRes = await VirtualFsUtils.resolvePath(this.root, oldFileName);
        const newRes = await VirtualFsUtils.resolvePath(this.root, newFileName);

        // If destination is a directory, append the original filename
        if (newRes.node && newRes.node.isDir())
        {
            newFileName = newFileName + "/" + oldRes.name;
            // Re-resolve with the corrected path
            const corrected = await VirtualFsUtils.resolvePath(this.root, newFileName);
            newRes.parent = corrected.parent;
            newRes.name = corrected.name;
        }

        if (!oldRes.node)
        {
            throw new Error('File not found');
        }
        else if (oldRes.name == newRes.name && oldRes.parent.fullpath != newRes.parent.fullpath)
        {
            this.getCache().invalidateAssetNode(oldRes.node);
            this.getCache().invalidateFilePath(oldFileName);
            this.getCache().invalidateFilePath(newFileName);
            this.getCache().invalidateAllDirectories();
            return await oldRes.parent.event_movenode(oldRes.node, newRes.parent)
        }
        else
        {
            this.getCache().invalidateAssetNode(oldRes.node);
            this.getCache().invalidateFilePath(oldFileName);
            this.getCache().invalidateFilePath(newFileName);
            this.getCache().invalidateAllDirectories();
            return await oldRes.node.event_rename(newRes.name)
        }

    }
    async remove(filename: string)
    {
        const { parent, name, node } = await VirtualFsUtils.resolvePath(this.root, filename);

        if (!node)
        {
            return await this.memory.remove(filename);
        }

        this.getCache().invalidateAssetNode(node);
        this.getCache().invalidateFilePath(filename);
        this.getCache().invalidateDirectoryPath(parent?.fullpath ?? "/");

        return await node.event_delete();
    }
    async mkdir(path: string)
    {
        const { parent, node, name } = await VirtualFsUtils.resolvePath(this.root, path);

        if (node) return false;
        if (!parent) return false;

        const result = await parent.event_mkdir(name);

        this.getCache().invalidateDirectoryPath(parent.fullpath);
        this.getCache().invalidateDirectoryPath(path);

        return result;
    }


    // Get Methods
    public getCache(): ImmichSessionCache
    {
        return this.getApi().cache;
    }
    public getApi()
    {
        return this.immichApi;
    }
    public getUrl()
    {
        return this.immichApi.getBaseUrl()
    }
    public getCurrentUser()
    {
        return this.immichApi.getUser()
    }
    public getUserSettings()
    {
        return this.immichApi.getUserSettings()
    }
    public async getUserDisplaySettings(): Promise<UserDisplaySettings>
    {
        return await this.immichApi.getUserDisplaySettings()
    }
    public async getResolvedPath(path: string): Promise<VirtualPathInfo>
    {
        return await VirtualFsUtils.resolvePath(this.root, path);
    }




}






