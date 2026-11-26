import { readFile, readdir } from "node:fs/promises";
import { extname, resolve } from "node:path";

const ignored = new Set(["node_modules", "dist", ".git"]);

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (extname(entry.name) === ".json") files.push(path);
  }
  return files;
}

const files = await walk(resolve("."));
for (const file of files) JSON.parse(await readFile(file, "utf8"));
console.log(`Validated ${files.length} JSON files.`);
