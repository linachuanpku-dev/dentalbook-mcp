import { access, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ignored = new Set(["node_modules", "dist", ".git"]);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.name.endsWith(".md")) files.push(path);
  }
  return files;
}

const failures = [];
const markdownFiles = await walk(resolve("."));
for (const markdownFile of markdownFiles) {
  const text = await readFile(markdownFile, "utf8");
  const links = text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
  for (const match of links) {
    const href = match[1]?.trim().replace(/^<|>$/g, "");
    if (!href || href.startsWith("#") || /^(https?:|mailto:)/.test(href)) continue;
    const withoutAnchor = decodeURIComponent(href.split("#", 1)[0] ?? "").replace(/:\d+$/, "");
    const target = withoutAnchor.startsWith("/") ? withoutAnchor : resolve(dirname(markdownFile), withoutAnchor);
    try { await access(target); } catch { failures.push(`${markdownFile}: ${href}`); }
  }
}

if (failures.length) {
  console.error(`Broken local Markdown links:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Validated local links in ${markdownFiles.length} Markdown files.`);
}
