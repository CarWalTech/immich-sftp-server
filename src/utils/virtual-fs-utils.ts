import { VirtualDirectory } from "../filesystem/virtual-directory";
import { VirtualPathInfo } from "../filesystem/virtual-path-info";

export class VirtualFsUtils
{
    static async resolvePath(root: VirtualDirectory, path: string): Promise<VirtualPathInfo>
    {
        if (path === "/" || path == "/." || path == "/..")
            return { parent: root, node: root, name: root.name };

        // Normalize path segments
        const rawParts = path.split("/").filter(Boolean);
        const parts: string[] = [];

        for (const p of rawParts)
        {
            if (p === ".") continue;          // ignore
            if (p === "..")
            {                 // go up
                parts.pop();
                continue;
            }
            parts.push(p);
        }

        let current: VirtualDirectory = root;

        for (let i = 0; i < parts.length - 1; i++)
        {
            const next = await current.node(parts[i]);
            if (!next || !next.isDir())
                throw new Error(`Directory not found: ${parts[i]}`);
            current = next as VirtualDirectory;
        }

        const name = parts[parts.length - 1];
        const node = await current.node(name) ?? null;

        return { parent: current, node, name };
    }
}