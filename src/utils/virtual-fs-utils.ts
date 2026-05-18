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

        // Fast path: traverse purely from cache when every level is already built.
        // This avoids N sequential async roundtrips for the common case where the
        // tree is warm (e.g. the second resolvePath call during a rename/move).
        let fastCurrent: VirtualDirectory = root;
        let fastOk = true;

        for (let i = 0; i < parts.length - 1 && fastOk; i++)
        {
            const r = fastCurrent.tryNodeFromCache(parts[i]);
            if (!r.hit || !r.node?.isDir()) { fastOk = false; break; }
            fastCurrent = r.node as VirtualDirectory;
        }

        if (fastOk)
        {
            const name = parts[parts.length - 1];
            const r = fastCurrent.tryNodeFromCache(name);
            if (r.hit) return { parent: fastCurrent, node: r.node ?? null, name };
        }

        // Slow path: one or more levels not cached yet — resolve async, populating the cache.
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