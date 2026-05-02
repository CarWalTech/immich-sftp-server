export class PathUtils
{

    public static isPathWithinRoot(filePath: string, folder: string): boolean
    {
        const parts = this.getPathParts(filePath);
        return parts[0] === folder;
    }

    public static getPathParts(filePath: string): string[]
    {
        return filePath.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
    }

    public static normalizeFolderDisplayName(name: string, fallbackPrefix: string, id: string): string
    {
        const trimmed = name.trim();
        const fallbackName = `${fallbackPrefix}_${id.slice(0, 8)}`;
        const candidate = trimmed === '' ? fallbackName : trimmed;
        const sanitized = candidate.replace(/[\\/:*?"<>|]/g, '_');
        return sanitized.trim() || fallbackName;
    }

    public static extractAlbumPathInfo(filePath: string): { albumName: string; fileName: string | null }
    {
        // Entfernt führende und doppelte Slashes, z. B. aus "//Pflanzen/..." → "Pflanzen/..."
        const cleanedPath = filePath.replace(/^\/+|\/+$/g, "");

        const parts = cleanedPath.split('/').filter(Boolean); // Entfernt leere Segmente

        if (parts.length === 1)
        {
            return {
                albumName: parts[0],
                fileName: null,
            };
        } else if (parts.length === 2)
        {
            return {
                albumName: parts[0],
                fileName: parts[1],
            };
        } else
        {
            throw new Error(`Ungültiger Pfad: "${filePath}" – Erwartet 1 oder 2 Segmente.`);
        }
    }

    public static extractTagPathInfo(
        filePath: string,
        rootFolderName: string
    ): { itemName: string | null; fileName: string | null }
    {
        const parts = PathUtils.getPathParts(filePath);

        if (parts[0] !== rootFolderName)
        {
            throw new Error(`Path '${filePath}' is not in '${rootFolderName}'.`);
        }

        // Case: "/tags"
        if (parts.length === 1)
        {
            return { itemName: null, fileName: null };
        }

        // Remove root folder
        const segments = parts.slice(1);

        // Case: "/tags/<tag...>" (folder)
        if (!segments[segments.length - 1].includes("."))
        {
            return {
                itemName: segments.join("/"),
                fileName: null,
            };
        }

        // Case: "/tags/<tag...>/<file>"
        return {
            itemName: segments.slice(0, -1).join("/"),
            fileName: segments[segments.length - 1],
        };
    }

    public static extractPeoplePathInfo(filePath: string, rootFolderName: string): { itemName: string | null, fileName: string | null }
    {
        const parts = PathUtils.getPathParts(filePath);
        if (parts[0] !== rootFolderName)
        {
            throw new Error(`Path '${filePath}' is not in '${rootFolderName}'.`);
        }

        if (parts.length === 1)
        {
            return { itemName: null, fileName: null };
        }
        else if (parts.length === 2)
        {
            return { itemName: parts[1], fileName: null };
        }
        else if (parts.length === 3)
        {
            return { itemName: parts[1], fileName: parts[2] };
        }

        throw new Error(`Invalid path '${filePath}' in '${rootFolderName}' folder.`);
    }


}