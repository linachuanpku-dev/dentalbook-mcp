#!/usr/bin/env node

// Read-only recall check: papers.search DOI set for one author + keywords.
// Default: print the current DOI set. --write-baseline snapshots it.
// --compare-before-after --baseline asserts the current set is a superset
// of the snapshot (enrichment must not shrink recall).

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

function usage() {
  console.error(`Usage:
  node scripts/verify-enrichment-recall.mjs --author <name> --keywords <query>
  node scripts/verify-enrichment-recall.mjs --author <name> --keywords <query> --write-baseline path.json
  node scripts/verify-enrichment-recall.mjs --author <name> --keywords <query> --compare-before-after --baseline path.json

Env: DENTALBOOK_ADMIN_CENTER_URL or DENTALBOOK_CENTER_URL (default http://127.0.0.1:7342)
     DENTALBOOK_ADMIN_CENTER_BEARER or DENTALBOOK_CENTER_BEARER (required)
     optional --env=.dentalbook-local/admin.env`);
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function argument(name, fallback = "") {
  const prefix = `--${name}=`;
  const equals = process.argv.find((value) => value.startsWith(prefix));
  if (equals) return equals.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) {
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) return next;
    return "";
  }
  return fallback;
}

function uniqueSortedDois(values) {
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter(Boolean))].sort();
}

async function loadAdminEnv() {
  const envPath = resolve(argument("env", ".dentalbook-local/admin.env"));
  try {
    const text = await readFile(envPath, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const index = trimmed.indexOf("=");
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
  }
}

async function post(base, token, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function parseBaseline(raw) {
  if (Array.isArray(raw)) return { dois: uniqueSortedDois(raw) };
  if (raw && typeof raw === "object" && Array.isArray(raw.dois)) {
    return {
      author: typeof raw.author === "string" ? raw.author : "",
      keywords: typeof raw.keywords === "string" ? raw.keywords : "",
      resolvedAuthorId: typeof raw.resolvedAuthorId === "string" ? raw.resolvedAuthorId : "",
      dois: uniqueSortedDois(raw.dois),
    };
  }
  throw new Error("baseline must be a DOI array or { dois: string[] }");
}

async function searchAll(base, token, author, keywords) {
  const pageSize = 100;
  const items = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let resolvedAuthorId = "";
  while (offset < total) {
    const searched = await post(base, token, "/v1/papers/search", { author, keywords, limit: pageSize, offset });
    if (searched.status !== 200) {
      return { status: searched.status, json: searched.json, dois: [], items: [], total: 0, resolvedAuthorId: "" };
    }
    const page = Array.isArray(searched.json.items) ? searched.json.items : [];
    resolvedAuthorId = typeof searched.json.resolvedAuthorId === "string" ? searched.json.resolvedAuthorId : resolvedAuthorId;
    total = Number.isFinite(Number(searched.json.total)) ? Number(searched.json.total) : offset + page.length;
    items.push(...page);
    if (page.length === 0 || page.length < pageSize) break;
    offset += pageSize;
  }
  const dois = uniqueSortedDois(items.map((item) => item.paper?.doi ?? ""));
  return { status: 200, json: {}, dois, items, total: items.length, resolvedAuthorId };
}

await loadAdminEnv();
const base = (process.env.DENTALBOOK_ADMIN_CENTER_URL ?? process.env.DENTALBOOK_CENTER_URL ?? "http://127.0.0.1:7342").replace(/\/$/u, "");
const token = process.env.DENTALBOOK_ADMIN_CENTER_BEARER ?? process.env.DENTALBOOK_CENTER_BEARER ?? "";
if (!token) {
  console.error("DENTALBOOK_ADMIN_CENTER_BEARER is required.");
  usage();
  process.exit(2);
}

const compare = flag("compare-before-after");
const baselinePath = argument("baseline");
const writePath = argument("write-baseline");
const wantsWrite = process.argv.some((value) => value === "--write-baseline" || value.startsWith("--write-baseline="));
let author = argument("author").trim();
let keywords = argument("keywords").trim();

if (wantsWrite && !writePath) {
  console.error("--write-baseline requires path.json");
  usage();
  process.exit(2);
}

let baseline = null;
if (compare || baselinePath) {
  if (!baselinePath) {
    console.error("--compare-before-after requires --baseline path.json");
    usage();
    process.exit(2);
  }
  if (compare) {
    try {
      baseline = parseBaseline(JSON.parse(await readFile(resolve(baselinePath), "utf8")));
    } catch (error) {
      console.error(`FAIL baseline: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    if (!author) author = (baseline.author ?? "").trim();
    if (!keywords) keywords = (baseline.keywords ?? "").trim();
  }
}

if (!author || !keywords) {
  console.error("author and keywords are required.");
  usage();
  process.exit(2);
}

if (compare && baseline) {
  if (baseline.author && baseline.author.trim() !== author) {
    console.error(`FAIL author differs from baseline: ${author} vs ${baseline.author}`);
    process.exit(1);
  }
  if (baseline.keywords && baseline.keywords.trim() !== keywords) {
    console.error(`FAIL keywords differ from baseline: ${keywords} vs ${baseline.keywords}`);
    process.exit(1);
  }
}

const searched = await searchAll(base, token, author, keywords);
if (searched.status !== 200) {
  console.error(`FAIL ${author} × ${keywords}: HTTP ${searched.status} ${searched.json.errorCode ?? searched.json.message ?? ""}`);
  process.exit(1);
}

console.log(`\n${author}${searched.resolvedAuthorId ? ` ${searched.resolvedAuthorId}` : ""} × ${keywords}: ${searched.dois.length} DOIs`);
const abstractByDoi = new Map();
for (const item of searched.items) {
  const doi = String(item.paper?.doi ?? "").toLowerCase();
  if (!doi || abstractByDoi.has(doi)) continue;
  abstractByDoi.set(doi, item.paper?.hasAbstract === true);
}
for (const doi of searched.dois) {
  console.log(`  ${doi}  hasAbstract=${abstractByDoi.get(doi) === true}`);
}

if (writePath) {
  const snapshot = {
    author,
    keywords,
    resolvedAuthorId: searched.resolvedAuthorId,
    capturedAt: new Date().toISOString(),
    dois: searched.dois,
  };
  await writeFile(resolve(writePath), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`verify-enrichment-recall: wrote baseline ${writePath} (${searched.dois.length} DOIs)`);
}

if (compare && baseline) {
  const missing = baseline.dois.filter((doi) => !searched.dois.includes(doi));
  const extra = searched.dois.filter((doi) => !baseline.dois.includes(doi));
  console.log(`  baseline ${baseline.dois.length}; extra ${extra.length}; missing ${missing.length}`);
  if (extra.length) console.log(`    extra ${extra.join(", ")}`);
  if (missing.length) {
    console.error(`    missing ${missing.join(", ")}`);
    console.error(`\nverify-enrichment-recall failed (recall shrank)`);
    process.exit(1);
  }
}

console.log("\nverify-enrichment-recall passed");
