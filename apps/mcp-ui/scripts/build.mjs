import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(appDir, "dist");
const entries = ["probe", "library", "notebooks", "citations", "author-map", "author-graph"];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const entry of entries) {
  const result = await build({
    entryPoints: [resolve(appDir, "src/entries", `${entry}.tsx`)],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    jsx: "automatic",
    write: false,
    minify: true,
    legalComments: "none",
  });
  const javascript = result.outputFiles?.[0]?.text;
  if (!javascript) throw new Error(`No JavaScript emitted for ${entry}`);
  const safeJavascript = javascript.replaceAll("</script", "<\\/script");
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script>${safeJavascript}</script></body></html>`;
  await writeFile(resolve(outDir, `${entry}.html`), html, "utf8");
}

console.log(`Built ${entries.length} self-contained MCP App resources in ${outDir}`);
