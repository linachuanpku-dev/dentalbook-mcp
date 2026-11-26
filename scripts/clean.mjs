import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const roots = ["apps/mcp-ui/dist", ...["domain-contracts", "ui-kit", "mcp-user", "mcp-admin", "admin-cli"].map((name) => `packages/${name}/dist`)];

await Promise.all(roots.map((directory) => rm(resolve(directory), { recursive: true, force: true })));
