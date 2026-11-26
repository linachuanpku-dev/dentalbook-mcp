import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

async function packageFiles(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) results.push(...await packageFiles(path));
    else if (entry.name === "package.json") results.push(path);
  }
  return results;
}

test("runtime dependency graph excludes standalone-agent and desktop-shell stacks", async () => {
  const forbidden = ["electron", "@mariozechner/pi-agent-core", "@mariozechner/pi-coding-agent", "@earendil-works/pi-coding-agent", "acp"];
  for (const file of await packageFiles(resolve("."))) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
    for (const name of forbidden) assert.equal(name in dependencies, false, `${file} contains forbidden dependency ${name}`);
  }
});

test("four business MCP App entrypoints build as explicit scaffold states", async () => {
  for (const name of ["notebooks", "citations", "author-map", "author-graph"]) {
    const html = await readFile(resolve(`apps/mcp-ui/dist/${name}.html`), "utf8");
    assert.match(html, /Scaffold only/);
    assert.match(html, new RegExp(`ui://dentalbook/${name}/v1`));
  }
});
