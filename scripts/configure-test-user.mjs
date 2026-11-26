#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const output = resolve(argument("--output") ?? ".dentalbook-local/user.json");
const apiBaseUrl = argument("--api") ?? "https://127.0.0.1:17342";
const localDataDir = argument("--data");
const importRoot = argument("--import-root");
if (!localDataDir || !isAbsolute(localDataDir)) {
  throw new Error("--data must be an absolute, per-user local directory.");
}
if (!importRoot || !isAbsolute(importRoot)) {
  throw new Error("--import-root must be an absolute directory that the user explicitly allows for PDF imports.");
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const bearerToken = Buffer.concat(chunks).toString("utf8").trim();
if (bearerToken.length < 12 || /\s/u.test(bearerToken)) throw new Error("A valid Bearer token must be provided on standard input.");

const url = new URL(apiBaseUrl);
const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
if (url.protocol !== "https:") {
  throw new Error("The user MCP config must use HTTPS.");
}
if (!loopback && !url.hostname.includes(".")) {
  throw new Error("A public Dentalbook center must use an HTTPS DNS hostname.");
}

await mkdir(dirname(output), { recursive: true, mode: 0o700 });
await writeFile(output, `${JSON.stringify({
  apiBaseUrl: url.toString().replace(/\/$/u, ""),
  bearerToken,
  localDataDir: resolve(localDataDir),
  requestTimeoutMs: 10_000,
  maxPdfBytes: 100 * 1024 * 1024,
  importRoots: [resolve(importRoot)],
}, null, 2)}\n`, { flag: "wx", mode: 0o600 });
process.stdout.write(`Created ${output}\n`);
