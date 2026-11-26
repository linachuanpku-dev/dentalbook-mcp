#!/usr/bin/env node
/**
 * Ingest metadata-only papers (DOI + title, no PDF).
 *
 *   node scripts/linux-corpus-metadata-ingest.mjs run --limit 50 --offset 0
 *   node scripts/linux-corpus-metadata-ingest.mjs run --limit 24029 --offset 0 --confirm --report ...
 *
 * Env: DENTALBOOK_CENTER_URL, DENTALBOOK_ADMIN_CENTER_BEARER,
 *      DENTALBOOK_CORPUS_METADATA_DIR (default /var/lib/dentalbook-test-library/runs/ingest-metadata)
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const CENTER_URL = (process.env.DENTALBOOK_CENTER_URL ?? "http://127.0.0.1:7342").replace(/\/$/u, "");
const TOKEN = process.env.DENTALBOOK_ADMIN_CENTER_BEARER ?? process.env.DENTALBOOK_CENTER_BEARER ?? "";
const RUN_DIR = resolve(process.env.DENTALBOOK_CORPUS_METADATA_DIR ?? "/var/lib/dentalbook-test-library/runs/ingest-metadata");
const BATCH_PATH = join(RUN_DIR, "metadata_batch.jsonl");
const CHUNK = 50;

function parseArgs(argv) {
  const args = { command: argv[2] ?? "help", limit: 50, offset: 0, confirm: false, report: join(RUN_DIR, "ingest_report_metadata.json") };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--offset") args.offset = Number(argv[++i]);
    else if (argv[i] === "--confirm") args.confirm = true;
    else if (argv[i] === "--report") args.report = argv[++i];
  }
  return args;
}

async function loadBatch() {
  const body = await readFile(BATCH_PATH, "utf8");
  return body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function postChunk(papers) {
  const response = await fetch(`${CENTER_URL}/v1/papers/ingest-metadata`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      papers: papers.map((row) => ({ doi: row.doi, title: row.title })),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${body.errorCode ?? response.status}: ${body.message ?? "ingest-metadata failed"}`);
  }
  return body;
}

async function run(args) {
  if (!TOKEN) throw new Error("DENTALBOOK_ADMIN_CENTER_BEARER is required.");
  if (!args.confirm && args.limit > 50) {
    throw new Error("Refusing more than 50 metadata rows without --confirm.");
  }
  const entries = await loadBatch();
  const slice = entries.slice(args.offset, args.offset + args.limit);
  const report = {
    startedAt: new Date().toISOString(),
    offset: args.offset,
    limit: args.limit,
    requested: slice.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failed: [],
    receipts: [],
  };
  await mkdir(RUN_DIR, { recursive: true });
  for (let i = 0; i < slice.length; i += CHUNK) {
    const chunk = slice.slice(i, i + CHUNK);
    const absolute = args.offset + i;
    if (i === 0 || i % 500 === 0) {
      console.error(`Metadata ${absolute}/${entries.length} (+${chunk.length})`);
    }
    try {
      const result = await postChunk(chunk);
      report.created += result.data?.created ?? result.created ?? 0;
      report.updated += result.data?.updated ?? result.updated ?? 0;
      report.skipped += result.data?.skipped ?? result.skipped ?? 0;
      if (result.receiptId) report.receipts.push(result.receiptId);
    } catch (error) {
      report.failed.push({
        offset: absolute,
        count: chunk.length,
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(resolve(args.report), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const stats = await fetch(`${CENTER_URL}/v1/library/stats`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{}",
  }).then((res) => res.json()).catch(() => ({}));
  console.log(JSON.stringify({
    reportPath: resolve(args.report),
    centerStats: stats,
    created: report.created,
    updated: report.updated,
    skipped: report.skipped,
    failedChunks: report.failed.length,
  }, null, 2));
  if (report.failed.length > 0) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.command === "run") {
    await run(args);
    return;
  }
  console.log("Usage: run [--limit N] [--offset N] [--confirm] [--report path]");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
