import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(appDir, "dist");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await build({
  entryPoints: [resolve(appDir, "src/main.tsx")],
  outfile: resolve(outDir, "app.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  jsx: "automatic",
  minify: true,
  sourcemap: false,
  legalComments: "none",
});

const javascript = await readFile(resolve(outDir, "app.js"));
const hash = createHash("sha256").update(javascript).digest("hex").slice(0, 8);
const hashedName = `app.${hash}.js`;
await writeFile(resolve(outDir, hashedName), javascript);

const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="theme-color" content="#f4f7f2">
    <title>Dentalbook 文献库</title>
  </head>
  <body><div id="root"></div><script src="/${hashedName}" defer></script></body>
</html>`;
await writeFile(resolve(outDir, "index.html"), html, "utf8");

console.log(`Built Dentalbook Web in ${outDir} (${hashedName})`);
