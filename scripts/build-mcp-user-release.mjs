import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = resolve(root, "releases/mcp-user");
const staging = resolve(releaseRoot, "staging");
const userPkg = JSON.parse(await readFile(resolve(root, "packages/mcp-user/package.json"), "utf8"));
const version = userPkg.version;
const metaPath = resolve(releaseRoot, "release.meta.json");
const meta = JSON.parse(await readFile(metaPath, "utf8").catch(() => "{}"));

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

await cp(resolve(root, "packages/mcp-user/dist"), resolve(staging, "dist"), { recursive: true });
await cp(resolve(root, "apps/mcp-ui/dist"), resolve(staging, "mcp-ui"), { recursive: true });

const contractsPkg = JSON.parse(await readFile(resolve(root, "packages/domain-contracts/package.json"), "utf8"));
const contractsTarget = resolve(staging, "node_modules/@dentalbook/domain-contracts");
await mkdir(contractsTarget, { recursive: true });
await cp(resolve(root, "packages/domain-contracts/dist"), resolve(contractsTarget, "dist"), { recursive: true });
await writeFile(resolve(contractsTarget, "package.json"), `${JSON.stringify({
  name: contractsPkg.name,
  version: contractsPkg.version,
  type: "module",
  exports: "./dist/index.js",
}, null, 2)}\n`);

await writeFile(resolve(staging, "package.json"), `${JSON.stringify({
  name: "dentalbook-mcp-user-release",
  version,
  private: true,
  type: "module",
  dependencies: {
    "@modelcontextprotocol/sdk": userPkg.dependencies["@modelcontextprotocol/sdk"],
    zod: userPkg.dependencies.zod,
  },
}, null, 2)}\n`);

execSync("npm install --omit=dev --no-audit --no-fund", { cwd: staging, stdio: "inherit" });

const archiveName = `dentalbook-mcp-user-${version}.tar.gz`;
const archivePath = resolve(releaseRoot, archiveName);
const latestPath = resolve(releaseRoot, "latest.tar.gz");
execSync(`tar -czf "${archivePath}" -C "${staging}" .`, { stdio: "inherit" });
await cp(archivePath, latestPath);

const sha256 = createHash("sha256").update(await readFile(archivePath)).digest("hex");
const manifest = {
  version,
  sha256,
  publishedAt: new Date().toISOString(),
  upgradeRecommended: meta.upgradeRecommended === true,
  upgradeRequired: meta.upgradeRequired === true,
  minCenterVersion: meta.minCenterVersion ?? version,
  notes: typeof meta.notes === "string" ? meta.notes : "",
  upgradeHint: typeof meta.upgradeHint === "string" && meta.upgradeHint.trim()
    ? meta.upgradeHint.trim()
    : "共享库 MCP 有更新，请打开 /docs#upgrade 并按第 2 条重跑 install 脚本，然后重载 MCP。",
  upgradeUrl: "https://dentalbook.example.com/docs#upgrade",
};

await writeFile(resolve(releaseRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await cp(resolve(root, "scripts/install-mcp-user.sh"), resolve(releaseRoot, "install-mcp-user.sh"));
await rm(staging, { recursive: true, force: true });

console.error(`Dentalbook MCP release ${version} ready (${archiveName}, sha256 ${sha256.slice(0, 12)}…)`);
