#!/usr/bin/env node
/**
 * Scan Linux 统一文献库_PDF仓库 → ingest_manifest.jsonl → ingest_batch_10k.jsonl
 *
 * L1: DOI or title required
 * L2: valid PDF, not HTML masquerade, not print snapshot, <= 100 MiB
 *
 * Batch: target_set rank first, then DOI alphabetical fill to 10_000 rows.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const WAREHOUSE = process.env.DENTALBOOK_CORPUS_WAREHOUSE
  ?? "/home/lnc/文献管理/文献库/统一文献库_PDF仓库";
const TARGET_SET = process.env.DENTALBOOK_CORPUS_TARGET_SET
  ?? "/home/lnc/文献管理/runs/oral-all-fields-50000/20260714-015324-698955-refine-8fa1dd4b/target_set.csv";
const OUT_DIR = process.env.DENTALBOOK_CORPUS_RUN_DIR
  ?? "/var/lib/dentalbook-test-library/runs/ingest-10k";
const BATCH_SIZE = Number(process.env.DENTALBOOK_CORPUS_BATCH_SIZE ?? "10000");
const MAX_BYTES = 100 * 1024 * 1024;
const SNAPSHOT_MARKERS = ["skia/pdf", "chromium", "headlesschrome", "playwright", "wkhtmltopdf"];

function canonicalDoi(value) {
  return value.trim().toLowerCase()
    .replace(/^doi:\s*/u, "")
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, "")
    .replace(/[),.;]+$/u, "");
}

function folderToDoi(dirName) {
  if (!dirName.startsWith("10.")) return "";
  const idx = dirName.indexOf("_");
  if (idx === -1) return canonicalDoi(dirName);
  return canonicalDoi(`${dirName.slice(0, idx)}/${dirName.slice(idx + 1).replace(/_/g, "/")}`);
}

function pdfinfoAll(path) {
  const result = spawnSync("pdfinfo", [path], { encoding: "utf8", maxBuffer: 64 * 1024 });
  if (result.status !== 0) return null;
  const fields = {};
  for (const line of result.stdout.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fields;
}

function looksSnapshot(fields, headBytes) {
  const producer = `${fields?.Producer ?? ""} ${fields?.Creator ?? ""}`.toLowerCase();
  if (SNAPSHOT_MARKERS.some((marker) => producer.includes(marker))) return "print_snapshot_producer";
  const head = headBytes.toString("latin1").toLowerCase();
  if (head.includes("skia/pdf") || head.includes("headlesschrome")) return "print_snapshot_bytes";
  return "";
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

async function loadTargetSet(path) {
  const rankByDoi = new Map();
  const titleByDoi = new Map();
  try {
    const text = await readFile(path, "utf8");
    const lines = text.split("\n");
    const header = lines[0]?.split(",") ?? [];
    const doiIdx = header.indexOf("doi");
    const titleIdx = header.indexOf("title");
    const rankIdx = header.indexOf("rank");
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      const cols = parseCsvLine(line);
      const doi = canonicalDoi(cols[doiIdx] ?? "");
      if (!doi) continue;
      const rank = Number(cols[rankIdx]);
      if (Number.isFinite(rank)) rankByDoi.set(doi, rank);
      const title = (cols[titleIdx] ?? "").trim();
      if (title) titleByDoi.set(doi, title);
    }
  } catch (error) {
    console.error(`Warning: could not load target set ${path}: ${error.message}`);
  }
  return { rankByDoi, titleByDoi };
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"" && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else if (ch === "\"") {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === "\"") {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

async function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function listWarehousePdfs(root) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  const pdfs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pdfPath = join(root, entry.name, "原版.pdf");
    try {
      const { stat } = await import("node:fs/promises");
      const info = await stat(pdfPath);
      if (info.isFile()) pdfs.push({ dirName: entry.name, pdfPath });
    } catch {
      // skip dirs without 原版.pdf
    }
  }
  return pdfs;
}

async function scanEntry({ dirName, pdfPath }, titleByDoi) {
  const doiFolder = folderToDoi(dirName);
  const info = pdfinfoAll(pdfPath);
  const titlePdf = info?.Title ?? "";
  const doi = doiFolder || canonicalDoi(info?.Subject || "");
  const title = (titlePdf || titleByDoi.get(doi) || "").replace(/\s+/g, " ").trim();
  const l1 = doi || title ? "pass" : "skip";
  let l2 = "skip";
  let skipReason = l1 === "skip" ? "no_metadata" : null;
  let byteSize = 0;
  let pageCount = 0;
  let sha256 = "";
  if (l1 === "pass") {
    const head = Buffer.alloc(65536);
    const fd = await import("node:fs/promises").then((m) => m.open(pdfPath, "r"));
    try {
      const { bytesRead } = await fd.read(head, 0, head.length, 0);
      const slice = head.subarray(0, bytesRead);
      const stat = await fd.stat();
      byteSize = stat.size;
      if (!slice.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
        skipReason = "not_pdf";
      } else if (slice.subarray(0, 4096).toString("latin1").toLowerCase().includes("<html")) {
        skipReason = "html_masquerade";
      } else if (byteSize > MAX_BYTES) {
        skipReason = "too_large";
      } else {
        const snap = looksSnapshot(info, slice);
        if (snap) skipReason = snap;
      }
      if (!skipReason) {
        pageCount = Number(info?.Pages) || 0;
        sha256 = await sha256File(pdfPath);
        l2 = "pass";
      }
    } finally {
      await fd.close();
    }
  }
  return {
    path: pdfPath,
    dirName,
    doi: doi || null,
    title: title || null,
    sha256: sha256 || null,
    byteSize,
    pageCount,
    l1,
    l2,
    skipReason,
    status: l1 === "pass" && l2 === "pass" ? "pass" : "skip",
  };
}

function selectBatch(passRows, rankByDoi, batchSize) {
  const ranked = passRows
    .filter((row) => row.doi)
    .map((row) => ({
      ...row,
      rank: rankByDoi.get(row.doi) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      return String(left.doi).localeCompare(String(right.doi));
    });
  const seenDoi = new Set();
  const batch = [];
  for (const row of ranked) {
    if (seenDoi.has(row.doi)) continue;
    seenDoi.add(row.doi);
    batch.push(row);
    if (batch.length >= batchSize) break;
  }
  if (batch.length < batchSize) {
    const fill = passRows
      .filter((row) => row.doi && !seenDoi.has(row.doi))
      .sort((a, b) => String(a.doi).localeCompare(String(b.doi)));
    for (const row of fill) {
      seenDoi.add(row.doi);
      batch.push(row);
      if (batch.length >= batchSize) break;
    }
  }
  return batch.slice(0, batchSize);
}

async function main() {
  const warehouse = resolve(WAREHOUSE);
  const outDir = resolve(OUT_DIR);
  await mkdir(outDir, { recursive: true });
  const { rankByDoi, titleByDoi } = await loadTargetSet(TARGET_SET);
  const pdfList = await listWarehousePdfs(warehouse);
  console.error(`Scanning ${pdfList.length} 原版.pdf under ${warehouse}`);

  const manifestPath = join(outDir, "ingest_manifest.jsonl");
  const summary = { scanned: 0, pass: 0, skip: 0, reasons: {} };
  const passRows = [];
  const manifestLines = [];

  let index = 0;
  for (const item of pdfList) {
    index += 1;
    if (index % 500 === 0) console.error(`  ${index}/${pdfList.length}`);
    const row = await scanEntry(item, titleByDoi);
    summary.scanned += 1;
    if (row.status === "pass") {
      summary.pass += 1;
      passRows.push(row);
    } else {
      summary.skip += 1;
      const reason = row.skipReason ?? "unknown";
      summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1;
    }
    manifestLines.push(JSON.stringify(row));
  }

  const manifestBody = `${manifestLines.join("\n")}\n`;
  const manifestSha256 = await sha256Text(manifestBody);
  await writeFile(manifestPath, manifestBody, "utf8");

  const batch = selectBatch(passRows, rankByDoi, BATCH_SIZE);
  const batchPath = join(outDir, "ingest_batch_10k.jsonl");
  const batchBody = `${batch.map((row) => JSON.stringify({
    path: row.path,
    doi: row.doi,
    title: row.title,
    sha256: row.sha256,
    byteSize: row.byteSize,
    pageCount: row.pageCount,
    rank: rankByDoi.get(row.doi) ?? null,
  })).join("\n")}\n`;
  const batchSha256 = await sha256Text(batchBody);
  await writeFile(batchPath, batchBody, "utf8");

  const report = {
    generatedAt: new Date().toISOString(),
    warehouse,
    targetSet: TARGET_SET,
    manifestPath,
    manifestSha256,
    manifestLines: manifestLines.length,
    batchPath,
    batchSha256,
    batchLines: batch.length,
    summary,
    parallelPdfPolicy: "Same DOI + different SHA are parallel versions; same DOI + same SHA is alreadyPresent.",
  };
  await writeFile(join(outDir, "ingest_manifest_summary.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
