import { VirtualFileSystem } from "../virtual-file-system";
import { config, UserDisplaySettings } from '../../config';
import fs from 'fs';
import tmp from 'tmp';
import { ImmichAPI } from "./immich-api";
import { VirtualDirectory } from "../common/virtual-directory";
import { VirtualFile } from "../common/virtual-file";
import { ImmichRootDirectory } from "./collections/root-directory";



export class ImmichFileSystem implements VirtualFileSystem
{
    private immichApi: ImmichAPI
    private root: ImmichRootDirectory

    constructor()
    {
        this.root = new ImmichRootDirectory(this);
        this.immichApi = new ImmichAPI(config.immichHost.replace(/\/+$/, ''));
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
        const { parent, node, name } = await VirtualDirectory.resolvePath(this.root, filename);
        if (node) await node.event_setattr({ mtime: mtime })
    }

    async listFiles(currentDir: string)
    {
        const { node } = await VirtualDirectory.resolvePath(this.root, currentDir);
        if (!node || !node.isDir()) throw new Error(`Not a directory: ${currentDir}`);

        const result = await (node as VirtualDirectory).event_list()
        if (result) return result
        else throw new Error("Unable to process event list")
    }

    async readFile(filename: string)
    {
        const { node } = await VirtualDirectory.resolvePath(this.root, filename);
        if (!node || node.isDir()) throw new Error(`Not a file: ${filename}`);

        const file = (node as VirtualFile)
        return await file.event_readfile()
    }

    async writeFile(filename: string, tmpFile: tmp.FileResult)
    {
        const { parent, node, name } = await VirtualDirectory.resolvePath(this.root, filename);

        if (node && !node.isDir()) await (node as VirtualFile).event_writefile(tmpFile);
        else if (parent && parent.isDir()) await parent.event_createfile(name, tmpFile)
        else throw new Error("Cannot write to destination");
    }

    async stat(filename: string)
    {
        const { node } = await VirtualDirectory.resolvePath(this.root, filename);
        if (!node) return null;

        return await node.event_stat();
    }

    async rename(oldFileName: string, newFileName: string)
    {
        const oldRes = await VirtualDirectory.resolvePath(this.root, oldFileName);
        const newRes = await VirtualDirectory.resolvePath(this.root, newFileName);
        if (!oldRes.node) throw new Error("Source not found");

        if (oldRes.name == newRes.name && oldRes.parent.fullpath != newRes.parent.fullpath)
        {
            await oldRes.parent.event_moveitem(oldRes.node, newRes.parent)
        }
        else
        {
            await oldRes.node.event_rename(newRes.name)
        }
    }

    async remove(filename: string)
    {
        const { parent, name, node } = await VirtualDirectory.resolvePath(this.root, filename);
        if (!node) throw new Error("Source not found");

        await node.event_delete()
    }

    async mkdir(path: string)
    {
        const { parent, node, name } = await VirtualDirectory.resolvePath(this.root, path);
        if (node) throw new Error("Already exists");
        if (!parent) throw new Error("Destination does not exist")

        await parent.event_mkdir(name)
    }


    // Get Methods
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
}




