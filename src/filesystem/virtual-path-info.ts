import { VirtualDirectory } from "./virtual-directory";
import { VirtualNode } from "./virtual-node";

export type VirtualPathInfo = { parent: VirtualDirectory; node: VirtualNode | null; name: string; };
