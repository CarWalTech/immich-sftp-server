import { VirtualFileSystem } from "../virtual-file-system";
import { config, UserDisplaySettings } from '../../config';
import fs from 'fs';
import tmp from 'tmp';
import { ImmichAlbumCollection } from "./collections/immich-album-collection";
import { ImmichRootCollection } from "./collections/immich-root-collection";
import { ImmichTagCollection } from "./collections/immich-tag-collection";
import { ImmichPeopleCollection } from "./collections/immich-people-collection";
import { ImmichAPI } from "./immich-api";



export class ImmichFileSystem implements VirtualFileSystem
{
    private albumsCollection: ImmichAlbumCollection
    private tagsCollection: ImmichTagCollection
    private peopleCollection: ImmichPeopleCollection
    private rootCollection: ImmichRootCollection
    private immichApi: ImmichAPI

    constructor()
    {
        this.immichApi = new ImmichAPI(config.immichHost.replace(/\/+$/, ''));

        this.albumsCollection = new ImmichAlbumCollection(this)
        this.tagsCollection = new ImmichTagCollection(this);
        this.peopleCollection = new ImmichPeopleCollection(this);
        this.rootCollection = new ImmichRootCollection(this);
    }


    // VirtualFileSystem Methods
    async login(username: string, password: string): Promise<void>
    {
        return await this.immichApi.login(username, password)
    }
    async logout(): Promise<void>
    {
        await this.immichApi.logout();
        this.tagsCollection.logout();
        this.peopleCollection.logout();
    }
    async listFiles(currentDir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>
    {
        try
        {
            if (this.rootCollection.isPath(currentDir)) return await this.rootCollection.listFiles();
            else if (this.albumsCollection.isPathWithin(currentDir)) return await this.albumsCollection.listFiles(currentDir);
            else if (await this.tagsCollection.isPathWithin(currentDir)) return await this.tagsCollection.listFiles(currentDir);
            else if (await this.peopleCollection.isPathWithin(currentDir)) return await this.peopleCollection.listFiles(currentDir);

            // No matching path found
            throw new Error(`Unknown path: ${currentDir}`);
        }
        catch (error)
        {
            console.error("Error fetching items:", error);
            throw error;
        }
    }
    async readFile(filename: string): Promise<tmp.FileResult>
    {
        try
        {
            if (await this.tagsCollection.isPathWithin(filename)) return await this.tagsCollection.readFile(filename);
            else if (await this.peopleCollection.isPathWithin(filename)) return await this.peopleCollection.readFile(filename);
            else if (this.albumsCollection.isPathWithin(filename)) return await this.albumsCollection.readFile(filename);

            // No matching path found
            throw new Error(`Unknown file: ${filename}`);
        }
        catch (error)
        {
            console.error("Error reading file:", error);
            throw error;
        }
    }
    async writeFile(filename: string, tmpFile: tmp.FileResult): Promise<void>
    {
        if (await this.isReadOnlyPath(filename))
        {
            return await this.immichApi.QUEUE_OnReadOnlyWrite(filename, tmpFile)
        }
        else if (this.albumsCollection.isPathWithin(filename))
        {
            return await this.albumsCollection.writeFile(filename, tmpFile);
        }
    }
    async stat(filename: string): Promise<{ isDir: boolean; size: number; mtime: number; } | null>
    {
        if (this.rootCollection.isPath(filename)) return await this.rootCollection.stat(filename);
        else if (await this.tagsCollection.isPathWithin(filename)) return await this.tagsCollection.stat(filename);
        else if (await this.peopleCollection.isPathWithin(filename)) return await this.peopleCollection.stat(filename);
        else if (this.albumsCollection.isPathWithin(filename)) return await this.albumsCollection.stat(filename);
        return null;
    }
    async mkdir(dirPath: string): Promise<void>
    {
        if (await this.isReadOnlyPath(dirPath)) throw new Error(`'${dirPath}' is read-only.`);
        if (!this.albumsCollection.isPathWithin(dirPath)) throw new Error("New folders can only be created inside '/albums'.");

        return await this.albumsCollection.mkdir(dirPath);
    }
    async remove(filename: string): Promise<void>
    {
        if (await this.isReadOnlyPath(filename)) throw new Error(`'${filename}' is read-only.`);
        if (!this.albumsCollection.isPathWithin(filename)) throw new Error(`'${filename}' cannot be removed.`);

        return await this.albumsCollection.remove(filename)
    }
    async setAttributes(filename: string, mtime: number): Promise<void>
    {
        if (await this.isReadOnlyPath(filename))
        {
            throw new Error(`'${filename}' is read-only.`);
        }
        else if (this.albumsCollection.isPathWithin(filename))
        {
            return await this.albumsCollection.setAttributes(filename, mtime)
        }
    }
    async rename(oldName: string, newName: string): Promise<void>
    {
        if (await this.tagsCollection.isPathWithin(oldName) || await this.tagsCollection.isPathWithin(newName))
        {
            return await this.tagsCollection.rename(oldName, newName);
        }

        if (await this.peopleCollection.isPathWithin(oldName) || await this.peopleCollection.isPathWithin(newName))
        {
            return await this.peopleCollection.rename(oldName, newName);
        }

        // Detect album folder rename: /albums/OldName → /albums/NewName
        if (this.albumsCollection.isPathWithin(oldName) || this.albumsCollection.isPathWithin(newName))
        {
            return await this.albumsCollection.rename(oldName, newName)
        }

        // Check if the file exists in the upload queue (in-flight upload rename)
        if (this.immichApi.QUEUE_ContainsFile(oldName))
        {
            this.immichApi.QUEUE_RenameFileInFlight(oldName, newName)
            return;
        }


        throw new Error("Rename not support for Immich backend. Expect for tmp files (files that have been upload with OPEN, WRITE, CLOSE, but not yet sent to Immich in SETSTAT).");
    }

    // Conditional Methods
    public async isReadOnlyPath(filePath: string): Promise<boolean>
    {
        return await this.tagsCollection.isPathWithin(filePath) || await this.peopleCollection.isPathWithin(filePath);
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




