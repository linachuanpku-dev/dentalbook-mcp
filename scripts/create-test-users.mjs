#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(process.argv[2] ?? "");
if (!process.argv[2] || root === "/") {
  throw new Error("Usage: node scripts/create-test-users.mjs /absolute/test-library-root");
}

const secretsDir = resolve(root, "secrets");
const usersPath = resolve(secretsDir, "users.json");
const tokenAPath = resolve(secretsDir, "user-a.token");
const tokenBPath = resolve(secretsDir, "user-b.token");
await mkdir(secretsDir, { recursive: true, mode: 0o700 });

for (const path of [usersPath, tokenAPath, tokenBPath]) {
  await lstat(path).then(
    () => { throw new Error(`${path} already exists; refusing to rotate test credentials.`); },
    (error) => { if (error.code !== "ENOENT") throw error; },
  );
}

try {
  const tokenA = randomBytes(32).toString("base64url");
  const tokenB = randomBytes(32).toString("base64url");
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  await writeFile(usersPath, `${JSON.stringify({ users: [
    { userId: "user-a", tokenSha256: sha256(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:import", "fulltext:fetch", "authors:admin"] },
    { userId: "user-b", tokenSha256: sha256(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import", "authors:contribute"] },
  ] }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(tokenAPath, `${tokenA}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(tokenBPath, `${tokenB}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`Created hashed center users at ${usersPath}\n`);
  process.stdout.write(`Created separate one-time user token files under ${secretsDir}\n`);
} catch (error) {
  throw error;
}
