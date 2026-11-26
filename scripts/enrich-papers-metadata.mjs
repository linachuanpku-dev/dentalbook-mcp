#!/usr/bin/env node

/**
 * Idempotent backfill of paper abstracts / keywords / MeSH via OpenAlex then PubMed.
 * Writes only through POST /v1/papers/ingest-metadata (never SQLite).
 *
 * Env (same names as linux-corpus / merge-omfs scripts):
 *   DENTALBOOK_ADMIN_CENTER_URL or DENTALBOOK_CENTER_URL (default http://127.0.0.1:7342)
 *   DENTALBOOK_ADMIN_CENTER_BEARER or DENTALBOOK_CENTER_BEARER
 *     (operators typically `cat` the sidecar token file into the bearer env var)
 *
 * Flags: --all --limit=N --dry-run --bearer= --center-url=
 *        --doi-file=path (newline-separated DOIs; skips the full-library scan
 *        and resolves only those DOIs against the catalog)
 */

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

export const MAILTO = "dentalbook-catalog@local";
export const UA = `Dentalbook-paper-enrich/0.1 (mailto:${MAILTO})`;
export const OPENALEX_BATCH = 50;
export const INGEST_BATCH = 50;
export const LIST_PAGE_SIZE = 100;
export const STALE_MS = 60 * 24 * 60 * 60 * 1000;
export const PUBMED_MIN_INTERVAL_MS = 334;
export const OPENALEX_MIN_INTERVAL_MS = 200;
export const FETCH_TIMEOUT_MS = 10_000;
export const CONCEPT_MIN_SCORE = 0.4;
export const MAX_ABSTRACT_CHARS = 20_000;
export const MAX_TERMS = 80;
export const MAX_TERM_CHARS = 200;

function argumentFrom(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const match = argv.find((value) => value.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }
  return fallback;
}

function hasFlagFrom(argv, name) {
  return argv.includes(`--${name}`);
}

export function canonicalDoi(value = "") {
  return String(value).trim().toLowerCase().replace(/^doi:\s*/u, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, "");
}

export function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

export function reconstructAbstract(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object" || Array.isArray(invertedIndex)) return "";
  let max = -1;
  const placements = [];
  for (const [word, indexes] of Object.entries(invertedIndex)) {
    if (!Array.isArray(indexes)) continue;
    const token = String(word || "").trim();
    if (!token) continue;
    for (const index of indexes) {
      if (!Number.isInteger(index) || index < 0) continue;
      placements.push({ index, token });
      if (index > max) max = index;
    }
  }
  if (max < 0) return "";
  const words = Array.from({ length: max + 1 }, () => "");
  for (const item of placements) words[item.index] = item.token;
  return words.join(" ").replace(/\s+/gu, " ").trim();
}

function addTerm(list, seen, raw) {
  const value = String(raw || "").trim();
  if (!value) return;
  const key = value.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  list.push(value.slice(0, MAX_TERM_CHARS));
}

export function extractOpenAlexEnrichment(work) {
  const keywords = [];
  const seenKw = new Set();
  for (const item of Array.isArray(work?.keywords) ? work.keywords : []) {
    addTerm(keywords, seenKw, item?.display_name);
  }
  for (const item of Array.isArray(work?.concepts) ? work.concepts : []) {
    if (Number(item?.score) >= CONCEPT_MIN_SCORE) addTerm(keywords, seenKw, item?.display_name);
  }
  const meshTerms = [];
  const seenMesh = new Set();
  for (const item of Array.isArray(work?.mesh) ? work.mesh : []) {
    addTerm(meshTerms, seenMesh, item?.descriptor_name);
  }
  return {
    doi: canonicalDoi(work?.doi),
    abstract: reconstructAbstract(work?.abstract_inverted_index).slice(0, MAX_ABSTRACT_CHARS),
    keywords: keywords.slice(0, MAX_TERMS),
    meshTerms: meshTerms.slice(0, MAX_TERMS),
  };
}

function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;/gu, "'")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/gu, " ")
    .trim();
}

function xmlTexts(xml, tag) {
  const matches = [];
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "giu");
  let match = pattern.exec(xml);
  while (match) {
    const text = decodeXml(match[1]);
    if (text) matches.push(text);
    match = pattern.exec(xml);
  }
  return matches;
}

export function parsePubmedXml(xml) {
  const source = String(xml || "");
  const abstractParts = [];
  const abstractPattern = /<AbstractText(\s[^>]*)?>([\s\S]*?)<\/AbstractText>/giu;
  let abstractMatch = abstractPattern.exec(source);
  while (abstractMatch) {
    const label = /Label="([^"]+)"/u.exec(abstractMatch[1] || "")?.[1];
    const text = decodeXml(abstractMatch[2]);
    if (text) abstractParts.push(label ? `${label} ${text}` : text);
    abstractMatch = abstractPattern.exec(source);
  }
  const keywords = [];
  const seenKw = new Set();
  for (const name of xmlTexts(source, "Keyword")) addTerm(keywords, seenKw, name);
  const meshTerms = [];
  const seenMesh = new Set();
  for (const name of xmlTexts(source, "DescriptorName")) addTerm(meshTerms, seenMesh, name);
  return {
    abstract: abstractParts.join(" ").replace(/\s+/gu, " ").trim().slice(0, MAX_ABSTRACT_CHARS),
    keywords: keywords.slice(0, MAX_TERMS),
    meshTerms: meshTerms.slice(0, MAX_TERMS),
  };
}

export function isStaleEnrichedAt(enrichedAt, now = Date.now(), staleMs = STALE_MS) {
  if (enrichedAt == null || String(enrichedAt).trim() === "") return true;
  const timestamp = Date.parse(String(enrichedAt));
  if (Number.isNaN(timestamp)) return true;
  return now - timestamp >= staleMs;
}

export function selectCandidates(papers, options = {}) {
  const all = options.all === true;
  const limit = options.limit == null || options.limit === "" ? Number.POSITIVE_INFINITY : Number(options.limit);
  const now = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const staleMs = options.staleMs ?? STALE_MS;
  const selected = [];
  if (Number.isFinite(limit) && limit <= 0) return selected;
  for (const item of papers) {
    const paper = item?.paper ?? item;
    const doi = canonicalDoi(paper?.doi);
    const title = String(paper?.title || "").trim();
    if (!doi || !title) continue;
    if (!all) {
      if (paper?.hasAbstract === true) continue;
      if (!isStaleEnrichedAt(paper?.enrichedAt ?? null, now, staleMs)) continue;
    }
    selected.push({
      paperId: String(paper?.paperId || ""),
      doi,
      title,
      hasAbstract: paper?.hasAbstract === true,
      enrichedAt: paper?.enrichedAt ?? null,
    });
    if (selected.length >= limit) break;
  }
  return selected;
}

export function classifyEnrichment(fields) {
  const abstract = String(fields?.abstract || "").trim();
  const keywords = Array.isArray(fields?.keywords) ? fields.keywords.filter((value) => String(value || "").trim()) : [];
  const meshTerms = Array.isArray(fields?.meshTerms) ? fields.meshTerms.filter((value) => String(value || "").trim()) : [];
  if (abstract) return "enriched-with-abstract";
  if (keywords.length) return "keywords-only";
  if (meshTerms.length) return "mesh-only";
  return "not-found";
}

export function buildIngestDraft(paper, fields) {
  const draft = { doi: paper.doi, title: paper.title, keywords: [] };
  const abstract = String(fields?.abstract || "").trim();
  const keywords = [...new Set((fields?.keywords ?? []).map((value) => String(value || "").trim()).filter(Boolean))];
  const meshTerms = [...new Set((fields?.meshTerms ?? []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (abstract) draft.abstract = abstract.slice(0, MAX_ABSTRACT_CHARS);
  draft.keywords = keywords.slice(0, MAX_TERMS);
  if (meshTerms.length) draft.meshTerms = meshTerms.slice(0, MAX_TERMS);
  return draft;
}

function defaultSleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function mergeFields(primary, fallback) {
  const keywords = [];
  const seenKw = new Set();
  for (const value of [...(primary.keywords ?? []), ...(fallback.keywords ?? [])]) addTerm(keywords, seenKw, value);
  const meshTerms = [];
  const seenMesh = new Set();
  for (const value of [...(primary.meshTerms ?? []), ...(fallback.meshTerms ?? [])]) addTerm(meshTerms, seenMesh, value);
  return {
    abstract: String(primary.abstract || fallback.abstract || "").trim(),
    keywords: keywords.slice(0, MAX_TERMS),
    meshTerms: meshTerms.slice(0, MAX_TERMS),
  };
}

function emptyFields() {
  return { abstract: "", keywords: [], meshTerms: [] };
}

export function resolveCenterConfig(env = process.env, argv = process.argv) {
  const centerUrl = (argumentFrom(argv, "center-url", env.DENTALBOOK_ADMIN_CENTER_URL ?? env.DENTALBOOK_CENTER_URL ?? "http://127.0.0.1:7342")).replace(/\/$/u, "");
  const token = String(env.DENTALBOOK_ADMIN_CENTER_BEARER || env.DENTALBOOK_CENTER_BEARER || argumentFrom(argv, "bearer") || "").trim();
  return { centerUrl, token };
}

async function readBody(response) {
  const text = await response.text();
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (contentType.includes("json") || text.startsWith("{") || text.startsWith("[")) {
    try {
      return { text, json: JSON.parse(text) };
    } catch {
      throw new Error(`Malformed JSON from ${response.url ?? "upstream"}`);
    }
  }
  return { text, json: undefined };
}

export async function fetchWithRetry(url, options = {}) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const sleepFn = options.sleep ?? defaultSleep;
  const retries = options.retries ?? 1;
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const headers = { "user-agent": UA, ...(options.headers ?? {}) };
  let lastError = new Error(`HTTP request failed: ${url}`);
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(url, { method: options.method ?? "GET", signal: controller.signal, headers, body: options.body });
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < retries) {
          await sleepFn(1000 * (attempt + 1));
          continue;
        }
        throw lastError;
      }
      if (!response.ok) {
        const body = await readBody(response).catch(() => ({ json: undefined, text: "" }));
        const message = body.json?.message ?? body.text ?? response.status;
        const error = new Error(`${body.json?.errorCode ?? response.status}: ${message}`);
        error.status = response.status;
        error.body = body.json;
        throw error;
      }
      const body = await readBody(response);
      if (options.as === "json") {
        if (body.json === undefined) throw new Error(`Malformed JSON from ${url}`);
        return body.json;
      }
      if (options.as === "text") return body.text;
      return body.json ?? body.text;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError.name === "AbortError") lastError = new Error(`Timed out fetching ${url}`);
      const status = lastError.status;
      const retryable = status === 429 || (typeof status === "number" && status >= 500) || lastError.message.startsWith("HTTP 429") || lastError.message.startsWith("HTTP 5");
      if (attempt < retries && retryable) {
        await sleepFn(1000 * (attempt + 1));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function centerPost(centerUrl, token, path, body, options) {
  const payload = await fetchWithRetry(`${centerUrl}${path}`, {
    ...options,
    method: "POST",
    as: "json",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-dentalbook-host": "admin",
    },
    body: JSON.stringify(body),
    retries: 0,
  });
  if (!payload || payload.ok === false) {
    throw new Error(`${payload?.errorCode ?? "upstream"}: ${payload?.message ?? `${path} failed`}`);
  }
  return payload;
}

export async function listLibraryPapers(centerUrl, token, options = {}) {
  const papers = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    const page = await centerPost(centerUrl, token, "/v1/papers/list", { query: "", limit: LIST_PAGE_SIZE, offset }, options);
    if (!Array.isArray(page.items)) throw new Error("Malformed papers list: items must be an array.");
    total = Number.isInteger(page.total) ? page.total : offset + page.items.length;
    for (const item of page.items) papers.push(item);
    if (page.items.length === 0) break;
    offset += page.items.length;
    if (page.items.length < LIST_PAGE_SIZE) break;
  }
  return papers;
}

export async function listPapersByDois(centerUrl, token, dois, options = {}) {
  const papers = [];
  const seen = new Set();
  for (const raw of dois) {
    const doi = canonicalDoi(raw);
    if (!doi || seen.has(doi)) continue;
    seen.add(doi);
    const page = await centerPost(centerUrl, token, "/v1/papers/list", { query: doi, limit: 5, offset: 0 }, options);
    if (!Array.isArray(page.items)) throw new Error("Malformed papers list: items must be an array.");
    for (const item of page.items) {
      const paper = item?.paper ?? item;
      if (canonicalDoi(paper?.doi) === doi) {
        papers.push(item);
        break;
      }
    }
  }
  return papers;
}

function openAlexUrl(dois) {
  const filter = `doi:${dois.map((doi) => canonicalDoi(doi)).join("|")}`;
  return `https://api.openalex.org/works?filter=${encodeURIComponent(filter)}&per-page=${OPENALEX_BATCH}&mailto=${encodeURIComponent(MAILTO)}`;
}

function pubmedSearchUrl(doi) {
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=1&tool=dentalbook-enrich&email=${encodeURIComponent(MAILTO)}&term=${encodeURIComponent(`${canonicalDoi(doi)}[doi]`)}`;
}

function pubmedFetchUrl(pmid) {
  return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&rettype=abstract&retmode=xml&tool=dentalbook-enrich&email=${encodeURIComponent(MAILTO)}&id=${encodeURIComponent(pmid)}`;
}

export async function fetchOpenAlexBatch(dois, options = {}) {
  if (dois.length === 0) return new Map();
  const payload = await fetchWithRetry(openAlexUrl(dois), { ...options, as: "json" });
  if (!payload || !Array.isArray(payload.results)) throw new Error("Malformed OpenAlex response: results must be an array.");
  const byDoi = new Map();
  for (const work of payload.results) {
    const extracted = extractOpenAlexEnrichment(work);
    if (extracted.doi) byDoi.set(extracted.doi, extracted);
  }
  return byDoi;
}

export async function fetchPubmedFallback(doi, options = {}) {
  const search = await fetchWithRetry(pubmedSearchUrl(doi), { ...options, as: "json" });
  const ids = search?.esearchresult?.idlist;
  if (!Array.isArray(ids) || ids.length === 0) return emptyFields();
  const pmid = String(ids[0] || "").trim();
  if (!pmid) return emptyFields();
  if (options.sleep && options.pubmedMinIntervalMs) await options.sleep(options.pubmedMinIntervalMs);
  const xml = await fetchWithRetry(pubmedFetchUrl(pmid), { ...options, as: "text" });
  if (typeof xml !== "string") throw new Error("Malformed PubMed efetch response: expected XML text.");
  return parsePubmedXml(xml);
}

function emptyReport() {
  return {
    scanned: 0,
    candidates: 0,
    "enriched-with-abstract": 0,
    "keywords-only": 0,
    "mesh-only": 0,
    "not-found": 0,
    errors: 0,
    skippedIngest: 0,
    sources: {
      openalex: { works: 0, abstracts: 0, keywords: 0, mesh: 0 },
      pubmed: { lookups: 0, abstracts: 0, keywords: 0, mesh: 0 },
    },
    receiptIds: [],
    notFoundDois: [],
    errorDois: [],
    dryRun: false,
  };
}

function printReport(report, stdout = process.stdout) {
  stdout.write(
    [
      `scanned=${report.scanned} candidates=${report.candidates}`,
      `enriched-with-abstract=${report["enriched-with-abstract"]} keywords-only=${report["keywords-only"]} mesh-only=${report["mesh-only"]}`,
      `not-found=${report["not-found"]} errors=${report.errors} skippedIngest=${report.skippedIngest}`,
      `openalex works=${report.sources.openalex.works} abstracts=${report.sources.openalex.abstracts} keywords=${report.sources.openalex.keywords} mesh=${report.sources.openalex.mesh}`,
      `pubmed lookups=${report.sources.pubmed.lookups} abstracts=${report.sources.pubmed.abstracts} keywords=${report.sources.pubmed.keywords} mesh=${report.sources.pubmed.mesh}`,
      `receiptIds=${report.receiptIds.join(",") || "(none)"}`,
      report.notFoundDois.length ? `notFoundDois=${report.notFoundDois.join(",")}` : "",
      report.errorDois.length ? `errorDois=${report.errorDois.join(",")}` : "",
      report.dryRun ? "dry-run=true (no writes)" : "",
    ].filter(Boolean).join("\n") + "\n",
  );
  stdout.write(`${JSON.stringify(report)}\n`);
}

export async function runEnrichment(options = {}) {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const resolved = resolveCenterConfig(env, argv);
  const centerUrl = options.centerUrl ?? resolved.centerUrl;
  const token = options.token ?? resolved.token;
  const all = options.all ?? hasFlagFrom(argv, "all");
  const limitRaw = options.limit ?? argumentFrom(argv, "limit", "");
  const limit = limitRaw === "" || limitRaw == null ? undefined : Number(limitRaw);
  const dryRun = options.dryRun ?? hasFlagFrom(argv, "dry-run");
  const now = options.now ?? new Date();
  const fetchFn = options.fetch ?? globalThis.fetch;
  const sleepFn = options.sleep ?? defaultSleep;
  const stdout = options.stdout ?? process.stdout;
  const pubmedMinIntervalMs = options.pubmedMinIntervalMs ?? PUBMED_MIN_INTERVAL_MS;
  const openAlexMinIntervalMs = options.openAlexMinIntervalMs ?? OPENALEX_MIN_INTERVAL_MS;
  const requestOptions = { fetch: fetchFn, sleep: sleepFn, timeoutMs: options.timeoutMs ?? FETCH_TIMEOUT_MS };

  if (!token) throw new Error("DENTALBOOK_ADMIN_CENTER_BEARER is required (or DENTALBOOK_CENTER_BEARER / --bearer=).");
  if (limitRaw != null && limitRaw !== "" && (!Number.isInteger(limit) || limit < 0)) throw new Error("--limit must be a non-negative integer.");

  const doiFile = options.doiFile ?? argumentFrom(argv, "doi-file", "");
  let listed;
  if (doiFile) {
    const text = await readFile(resolve(doiFile), "utf8");
    const dois = text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    if (dois.length === 0) throw new Error(`--doi-file ${doiFile} contains no DOIs.`);
    listed = await listPapersByDois(centerUrl, token, dois, requestOptions);
  } else {
    listed = await listLibraryPapers(centerUrl, token, requestOptions);
  }
  const candidates = selectCandidates(listed, { all, limit, now });
  const report = emptyReport();
  report.scanned = listed.length;
  report.candidates = candidates.length;
  report.dryRun = dryRun;

  if (dryRun) {
    stdout.write(`dry-run candidates=${candidates.length} of scanned=${listed.length}\n`);
    for (const paper of candidates) {
      stdout.write(`- ${paper.doi} ${paper.title} hasAbstract=${paper.hasAbstract} enrichedAt=${paper.enrichedAt ?? "null"}\n`);
    }
    printReport(report, stdout);
    return report;
  }

  const byDoi = new Map(candidates.map((paper) => [paper.doi, { paper, fields: emptyFields(), openalex: emptyFields(), pubmed: emptyFields() }]));
  const doiList = [...byDoi.keys()];
  const openAlexBatches = chunk(doiList, OPENALEX_BATCH);
  for (const [index, batch] of openAlexBatches.entries()) {
    if (index > 0 && openAlexMinIntervalMs > 0) await sleepFn(openAlexMinIntervalMs);
    let works;
    try {
      works = await fetchOpenAlexBatch(batch, requestOptions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const doi of batch) byDoi.get(doi).openalexError = message;
      continue;
    }
    report.sources.openalex.works += works.size;
    for (const doi of batch) {
      const extracted = works.get(doi) ?? emptyFields();
      const entry = byDoi.get(doi);
      entry.openalex = extracted;
      if (extracted.abstract) report.sources.openalex.abstracts += 1;
      if (extracted.keywords.length) report.sources.openalex.keywords += 1;
      if (extracted.meshTerms.length) report.sources.openalex.mesh += 1;
    }
  }

  let lastPubmedAt = 0;
  async function politePubmed(doi) {
    const wait = pubmedMinIntervalMs - (Date.now() - lastPubmedAt);
    if (wait > 0) await sleepFn(wait);
    lastPubmedAt = Date.now();
    const fields = await fetchPubmedFallback(doi, { ...requestOptions, pubmedMinIntervalMs, sleep: sleepFn });
    lastPubmedAt = Date.now();
    return fields;
  }

  for (const doi of doiList) {
    const entry = byDoi.get(doi);
    entry.fields = mergeFields(entry.openalex, emptyFields());
    if (entry.fields.keywords.length) continue;
    report.sources.pubmed.lookups += 1;
    try {
      const pubmed = await politePubmed(doi);
      entry.pubmed = pubmed;
      entry.pubmedOk = true;
      if (pubmed.abstract) report.sources.pubmed.abstracts += 1;
      if (pubmed.keywords.length) report.sources.pubmed.keywords += 1;
      if (pubmed.meshTerms.length) report.sources.pubmed.mesh += 1;
      entry.fields = mergeFields(entry.openalex, pubmed);
    } catch (error) {
      entry.pubmedError = error instanceof Error ? error.message : String(error);
      entry.pubmedOk = false;
      entry.fields = mergeFields(entry.openalex, emptyFields());
    }
  }

  const drafts = [];
  for (const doi of doiList) {
    const entry = byDoi.get(doi);
    const kind = classifyEnrichment(entry.fields);
    const attempted = entry.pubmedOk === true || !entry.openalexError;
    if (kind === "not-found") {
      if (!attempted) {
        report.errors += 1;
        report.errorDois.push(doi);
        continue;
      }
      report["not-found"] += 1;
      report.notFoundDois.push(doi);
      drafts.push(buildIngestDraft(entry.paper, entry.fields));
      continue;
    }
    report[kind] += 1;
    drafts.push(buildIngestDraft(entry.paper, entry.fields));
  }

  for (const batch of chunk(drafts, INGEST_BATCH)) {
    if (batch.length === 0) continue;
    const result = await centerPost(centerUrl, token, "/v1/papers/ingest-metadata", { papers: batch }, requestOptions);
    if (typeof result.receiptId === "string" && result.receiptId) report.receiptIds.push(result.receiptId);
    report.skippedIngest += Number(result.data?.skipped ?? result.skipped ?? 0);
  }

  printReport(report, stdout);
  return report;
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

async function main() {
  await runEnrichment();
}

if (isDirectRun()) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
