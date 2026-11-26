#!/usr/bin/env node
/**
 * Import a batch JSONL of warehouse PDFs into Dentalbook center.
 *
 * Usage:
 *   node scripts/linux-corpus-ingest.mjs preview
 *   node scripts/linux-corpus-ingest.mjs run --limit 50 --offset 0
 *   node scripts/linux-corpus-ingest.mjs run --limit 10000 --offset 0 --confirm
 *
 * Env:
 *   DENTALBOOK_CENTER_URL (default http://127.0.0.1:7342)
 *   DENTALBOOK_ADMIN_CENTER_BEARER (required)
 *   DENTALBOOK_CORPUS_RUN_DIR (default /var/lib/dentalbook-test-library/runs/ingest-10k)
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const CENTER_URL = (process.env.DENTALBOOK_CENTER_URL ?? "http://127.0.0.1:7342").replace(/\/$/u, "");
const TOKEN = process.env.DENTALBOOK_ADMIN_CENTER_BEARER ?? process.env.DENTALBOOK_CENTER_BEARER ?? "";
const RUN_DIR = resolve(process.env.DENTALBOOK_CORPUS_RUN_DIR ?? "/var/lib/dentalbook-test-library/runs/ingest-10k");
const BATCH_PATH = join(RUN_DIR, "ingest_batch_10k.jsonl");
const SUMMARY_PATH = join(RUN_DIR, "ingest_manifest_summary.json");
const DEFAULT_REPORT_PATH = join(RUN_DIR, "ingest_report_10k.json");

function parseArgs(argv) {
  const args = { command: argv[2] ?? "help", limit: 50, offset: 0, confirm: false, report: process.env.DENTALBOOK_CORPUS_REPORT_PATH ?? DEFAULT_REPORT_PATH };
  for (let i = 3; i < argv.length; i += 1) {
    if (argv[i] === "--limit") args.limit = Number(argv[++i]);
    else if (argv[i] === "--offset") args.offset = Number(argv[++i]);
    else if (argv[i] === "--confirm") args.confirm = true;
    else if (argv[i] === "--report") args.report = argv[++i];
  }
  return args;
}

async function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function loadBatch() {
  const body = await readFile(BATCH_PATH, "utf8");
  const lines = body.split("\n").filter(Boolean);
  const entries = lines.map((line) => JSON.parse(line));
  const batchSha256 = await sha256Text(body.endsWith("\n") ? body : `${body}\n`);
  let manifestSha256 = "";
  try {
    const summary = JSON.parse(await readFile(SUMMARY_PATH, "utf8"));
    manifestSha256 = summary.manifestSha256 ?? "";
  } catch {
    manifestSha256 = await sha256File(join(RUN_DIR, "ingest_manifest.jsonl"));
  }
  return { entries, batchSha256, manifestSha256, entryCount: entries.length };
}

async function previewBatch() {
  const { batchSha256, manifestSha256, entryCount } = await loadBatch();
  const response = await fetch(`${CENTER_URL}/v1/papers/ingest-corpus/preview`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ batchSha256, manifestSha256, entryCount }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${body.errorCode ?? response.status}: ${body.message ?? "preview failed"}`);
  const outPath = join(RUN_DIR, "ingest_preview.json");
  await writeFile(outPath, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...body, previewPath: outPath }, null, 2));
  return body;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function fetchErrorCode(error) {
  return error?.cause?.code ?? error?.code ?? error?.message ?? "fetch_failed";
}

function isRetryableFetchError(error) {
  const code = String(fetchErrorCode(error));
  return code.includes("UND_ERR_HEADERS_TIMEOUT") || code.includes("UND_ERR_BODY_TIMEOUT") || code.includes("ECONNRESET") || code.includes("fetch failed") || code.includes("UND_ERR_CONNECT_TIMEOUT");
}

async function importOne(entry, preview, report) {
  const bytes = await readFile(entry.path);
  const expectedSha = entry.sha256;
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (expectedSha && actualSha !== expectedSha) {
    report.failed.push({ doi: entry.doi, path: entry.path, error: "sha_mismatch", expectedSha, actualSha });
    return;
  }
  const maxAttempts = 8;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${CENTER_URL}/v1/papers/import`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/pdf",
          "content-length": String(bytes.length),
          "x-dentalbook-doi": entry.doi,
          "x-dentalbook-title-base64": Buffer.from(entry.title ?? entry.doi, "utf8").toString("base64url"),
          "x-dentalbook-confirmation-token": preview.confirmationToken,
          "x-dentalbook-batch-sha256": preview.summary.batchSha256,
          "x-dentalbook-manifest-sha256": preview.summary.manifestSha256,
          "x-dentalbook-entry-count": String(preview.summary.entryCount),
        },
        body: bytes,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if ((response.status >= 500 || response.status === 429) && attempt < maxAttempts) {
          console.error(`retry ${attempt}/${maxAttempts} ${entry.doi} HTTP ${response.status}`);
          await sleep(Math.min(30_000, 2_000 * attempt));
          continue;
        }
        report.failed.push({ doi: entry.doi, path: entry.path, error: body.errorCode ?? String(response.status), message: body.message ?? "import failed" });
        return;
      }
      if (body.alreadyPresent) {
        report.alreadyPresent.push({ doi: entry.doi, sha256: actualSha, receiptId: body.receiptId });
      } else {
        report.imported.push({ doi: entry.doi, sha256: actualSha, receiptId: body.receiptId });
      }
      return;
    } catch (error) {
      if (isRetryableFetchError(error) && attempt < maxAttempts) {
        console.error(`retry ${attempt}/${maxAttempts} ${entry.doi} ${fetchErrorCode(error)}`);
        await sleep(Math.min(30_000, 2_000 * attempt));
        continue;
      }
      report.failed.push({ doi: entry.doi, path: entry.path, error: String(fetchErrorCode(error)) });
      return;
    }
  }
}

async function runBatch(args) {
  if (!TOKEN) throw new Error("DENTALBOOK_ADMIN_CENTER_BEARER is required.");
  const previewPath = join(RUN_DIR, "ingest_preview.json");
  let preview;
  try {
    preview = JSON.parse(await readFile(previewPath, "utf8"));
  } catch {
    preview = await previewBatch();
  }
  if (!args.confirm && args.limit > 50) {
    throw new Error("Refusing to import more than 50 rows without --confirm.");
  }
  const { entries } = await loadBatch();
  const slice = entries.slice(args.offset, args.offset + args.limit);
  const report = {
    startedAt: new Date().toISOString(),
    centerUrl: CENTER_URL,
    offset: args.offset,
    limit: args.limit,
    requested: slice.length,
    imported: [],
    alreadyPresent: [],
    failed: [],
    parallelPdfPolicy: "Same DOI + different SHA are parallel versions; same DOI + same SHA is alreadyPresent.",
  };
  await mkdir(RUN_DIR, { recursive: true });
  let index = 0;
  for (const entry of slice) {
    index += 1;
    if (index % 25 === 0 || index === 1) console.error(`Import ${args.offset + index}/${entries.length}: ${entry.doi}`);
    await importOne(entry, preview, report);
  }
  report.finishedAt = new Date().toISOString();
  report.stats = {
    imported: report.imported.length,
    alreadyPresent: report.alreadyPresent.length,
    failed: report.failed.length,
  };
  const reportPath = resolve(args.report);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const statsResponse = await fetch(`${CENTER_URL}/v1/library/stats`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: "{}",
  }).then((res) => res.json()).catch(() => ({}));
  console.log(JSON.stringify({ reportPath, centerStats: statsResponse, ...report.stats }, null, 2));
  if (report.failed.length > 0) process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.command === "preview") {
    if (!TOKEN) throw new Error("DENTALBOOK_ADMIN_CENTER_BEARER is required.");
    await previewBatch();
    return;
  }
  if (args.command === "run") {
    await runBatch(args);
    return;
  }
  console.log(`Usage:
  preview
  run [--limit N] [--offset N] [--confirm]`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
