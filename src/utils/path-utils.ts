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

    public static normalizePath(path: string): string
    {
        if (!path) return "/";

        // Replace backslashes, collapse duplicate slashes
        path = path.replace(/\\/g, "/").replace(/\/+/g, "/");

        // Ensure leading slash
        if (!path.startsWith("/")) path = "/" + path;

        // Remove trailing slash unless root
        if (path.length > 1 && path.endsWith("/"))
        {
            path = path.slice(0, -1);
        }

        return path;
    }
}