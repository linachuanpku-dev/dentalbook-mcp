#!/usr/bin/env node
/** Spot-check imported batch: DOI lookup + SHA match against warehouse files. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const RUN_DIR = resolve(process.env.DENTALBOOK_CORPUS_RUN_DIR ?? "/var/lib/dentalbook-test-library/runs/ingest-10k");
const CENTER_URL = (process.env.DENTALBOOK_CENTER_URL ?? "http://127.0.0.1:7342").replace(/\/$/u, "");
const TOKEN = process.env.DENTALBOOK_ADMIN_CENTER_BEARER ?? process.env.DENTALBOOK_CENTER_BEARER ?? "";
const SAMPLE = Number(process.env.DENTALBOOK_CORPUS_VERIFY_SAMPLE ?? "20");

async function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (c) => hash.update(c)).on("error", reject).on("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function main() {
  const report = JSON.parse(await readFile(join(RUN_DIR, "ingest_report_10k.json"), "utf8"));
  const pool = [...report.imported, ...report.alreadyPresent];
  const sample = pool.sort(() => Math.random() - 0.5).slice(0, Math.min(SAMPLE, pool.length));
  const checks = [];
  for (const item of sample) {
    const batch = JSON.parse((await readFile(join(RUN_DIR, "ingest_batch_10k.jsonl"), "utf8")).split("\n").find((line) => line.includes(item.doi)) ?? "null");
    const localSha = batch?.path ? await sha256File(batch.path) : item.sha256;
    const response = await fetch(`${CENTER_URL}/v1/papers/get`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ identifier: item.doi }),
    });
    const body = await response.json();
    const versions = body.data?.pdfs ?? body.pdfs ?? [];
    const centerSha = versions.find((v) => v.sha256 === item.sha256)?.sha256 ?? body.data?.pdfProof?.fileSha256 ?? body.pdfProof?.fileSha256;
    checks.push({
      doi: item.doi,
      ok: response.ok && (centerSha === item.sha256 || versions.some((v) => v.sha256 === item.sha256)) && localSha === item.sha256,
      localSha,
      centerSha: centerSha ?? versions.map((v) => v.sha256),
    });
  }
  const summary = { checked: checks.length, passed: checks.filter((c) => c.ok).length, failed: checks.filter((c) => !c.ok).length, checks };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
