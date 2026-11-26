import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startCenterServer } from "../packages/center-service/dist/server.js";
import {
  buildIngestDraft,
  classifyEnrichment,
  extractOpenAlexEnrichment,
  parsePubmedXml,
  reconstructAbstract,
  resolveCenterConfig,
  runEnrichment,
  selectCandidates,
  STALE_MS,
} from "../scripts/enrich-papers-metadata.mjs";

const OPENALEX_DOI = "10.1000/dentalbook.enrich.openalex";
const PUBMED_DOI = "10.1000/dentalbook.enrich.pubmed";
const MISSING_DOI = "10.1000/dentalbook.enrich.missing";
const ALREADY_DOI = "10.1000/dentalbook.enrich.already";
const tokenA = "enrich-test-user-a";

const openAlexWorkFixture = {
  doi: `https://doi.org/${OPENALEX_DOI}`,
  abstract_inverted_index: {
    Zygomatic: [0],
    implants: [1],
    improve: [2],
    maxillary: [3],
    reconstruction: [4],
  },
  keywords: [{ display_name: "zygomatic implant" }],
  concepts: [
    { display_name: "Surgery", score: 0.91 },
    { display_name: "Too weak", score: 0.12 },
  ],
  mesh: [{ descriptor_name: "Dental Implants" }, { descriptor_name: "zygomatic implant" }],
};

const pubmedXmlFixture = `<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>555001</PMID>
      <Article>
        <Abstract>
          <AbstractText Label="BACKGROUND">Free flap harvest planning.</AbstractText>
          <AbstractText Label="METHODS">A retrospective cohort of 12 patients.</AbstractText>
        </Abstract>
      </Article>
      <KeywordList Owner="NOTNLM">
        <Keyword MajorTopicYN="N">free flap</Keyword>
        <Keyword MajorTopicYN="Y">harvest planning</Keyword>
      </KeywordList>
      <MeshHeadingList>
        <MeshHeading>
          <DescriptorName UI="D005437" MajorTopicYN="Y">Free Tissue Flaps</DescriptorName>
        </MeshHeading>
        <MeshHeading>
          <DescriptorName UI="D005437">Free Tissue Flaps</DescriptorName>
        </MeshHeading>
      </MeshHeadingList>
    </MedlineCitation>
  </PubmedArticle>
</PubmedArticleSet>
`;

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

test("reconstructAbstract rebuilds OpenAlex inverted index text by position", () => {
  assert.equal(reconstructAbstract(null), "");
  assert.equal(reconstructAbstract([]), "");
  assert.equal(
    reconstructAbstract(openAlexWorkFixture.abstract_inverted_index),
    "Zygomatic implants improve maxillary reconstruction",
  );
  assert.equal(
    reconstructAbstract({ despite: [0, 3], growing: [1], interest: [2] }),
    "despite growing interest despite",
  );
});

test("extractOpenAlexEnrichment keeps keywords, high-score concepts, and MeSH", () => {
  const extracted = extractOpenAlexEnrichment(openAlexWorkFixture);
  assert.equal(extracted.doi, OPENALEX_DOI);
  assert.equal(extracted.abstract, "Zygomatic implants improve maxillary reconstruction");
  assert.deepEqual(extracted.keywords, ["zygomatic implant", "Surgery"]);
  assert.deepEqual(extracted.meshTerms, ["Dental Implants", "zygomatic implant"]);
});

test("parsePubmedXml concatenates AbstractText and dedupes DescriptorName", () => {
  const parsed = parsePubmedXml(pubmedXmlFixture);
  assert.equal(parsed.abstract, "BACKGROUND Free flap harvest planning. METHODS A retrospective cohort of 12 patients.");
  assert.deepEqual(parsed.meshTerms, ["Free Tissue Flaps"]);
  assert.deepEqual(parsed.keywords, ["free flap", "harvest planning"]);
});

test("selectCandidates keeps papers without abstracts until a 60-day stale window", () => {
  const now = Date.parse("2026-08-19T00:00:00.000Z");
  const papers = [
    { paper: { doi: "10.1/has-abstract", title: "Has abstract", hasAbstract: true, enrichedAt: null } },
    { paper: { doi: "10.1/fresh-miss", title: "Fresh miss", hasAbstract: false, enrichedAt: "2026-08-01T00:00:00.000Z" } },
    { paper: { doi: "10.1/stale-miss", title: "Stale miss", hasAbstract: false, enrichedAt: "2026-06-01T00:00:00.000Z" } },
    { paper: { doi: "10.1/never", title: "Never tried", hasAbstract: false, enrichedAt: null } },
    { paper: { doi: "10.1/no-title", title: "   ", hasAbstract: false, enrichedAt: null } },
  ];
  const selected = selectCandidates(papers, { now, staleMs: STALE_MS });
  assert.deepEqual(selected.map((item) => item.doi), ["10.1/stale-miss", "10.1/never"]);
  const all = selectCandidates(papers, { all: true, now });
  assert.deepEqual(all.map((item) => item.doi), ["10.1/has-abstract", "10.1/fresh-miss", "10.1/stale-miss", "10.1/never"]);
  const limited = selectCandidates(papers, { all: true, limit: 1, now });
  assert.deepEqual(limited.map((item) => item.doi), ["10.1/has-abstract"]);
});

test("classifyEnrichment and buildIngestDraft omit empty fields", () => {
  assert.equal(classifyEnrichment({ abstract: "text" }), "enriched-with-abstract");
  assert.equal(classifyEnrichment({ keywords: ["a"] }), "keywords-only");
  assert.equal(classifyEnrichment({ meshTerms: ["m"] }), "mesh-only");
  assert.equal(classifyEnrichment({}), "not-found");
  assert.deepEqual(
    buildIngestDraft({ doi: "10.1/x", title: "Existing title" }, { abstract: "  ", keywords: [], meshTerms: ["Mesh"] }),
    { doi: "10.1/x", title: "Existing title", keywords: [], meshTerms: ["Mesh"] },
  );
});

test("resolveCenterConfig uses the same admin URL and bearer env names as other scripts", () => {
  const resolved = resolveCenterConfig({
    DENTALBOOK_ADMIN_CENTER_URL: "https://127.0.0.1:17342/",
    DENTALBOOK_ADMIN_CENTER_BEARER: "from-sidecar-token",
  }, []);
  assert.equal(resolved.centerUrl, "https://127.0.0.1:17342");
  assert.equal(resolved.token, "from-sidecar-token");
  const fallback = resolveCenterConfig({
    DENTALBOOK_CENTER_URL: "http://127.0.0.1:7342",
    DENTALBOOK_CENTER_BEARER: "legacy",
  }, ["node", "script", "--bearer=cli-token"]);
  assert.equal(fallback.token, "legacy");
  const cli = resolveCenterConfig({}, ["node", "script", "--center-url=http://127.0.0.1:9", "--bearer=cli-token"]);
  assert.equal(cli.centerUrl, "http://127.0.0.1:9");
  assert.equal(cli.token, "cli-token");
});

async function createEmptyCenterRoot() {
  const root = await mkdtemp(join(tmpdir(), "dentalbook-enrich-"));
  await Promise.all([
    mkdir(resolve(root, "fixtures/catalog"), { recursive: true }),
    mkdir(resolve(root, "manifests"), { recursive: true }),
    mkdir(resolve(root, "objects/sha256"), { recursive: true }),
    mkdir(resolve(root, "staging"), { recursive: true }),
  ]);
  await writeFile(resolve(root, "fixtures/catalog/papers.jsonl"), "");
  await writeFile(resolve(root, "manifests/library.jsonl"), "");
  return root;
}

function mockUpstreamFetch(centerBase) {
  return async (url, init) => {
    const href = String(url);
    if (href.startsWith(centerBase)) return globalThis.fetch(url, init);
    if (href.startsWith("https://api.openalex.org/works")) {
      const filter = new URL(href).searchParams.get("filter") ?? "";
      const dois = filter.replace(/^doi:/u, "").split("|").filter(Boolean);
      const results = [];
      if (dois.includes(OPENALEX_DOI)) results.push(openAlexWorkFixture);
      return jsonResponse({ results, meta: { count: results.length } });
    }
    if (href.startsWith("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi")) {
      const term = new URL(href).searchParams.get("term") ?? "";
      if (term.includes(PUBMED_DOI)) return jsonResponse({ esearchresult: { idlist: ["555001"] } });
      return jsonResponse({ esearchresult: { idlist: [] } });
    }
    if (href.startsWith("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi")) {
      return textResponse(pubmedXmlFixture);
    }
    throw new Error(`Test fetch hit the network: ${href}`);
  };
}

test("local center dry-run and ingest write-back use list hasAbstract/enrichedAt without live APIs", async (t) => {
  const root = await createEmptyCenterRoot();
  t.after(async () => rm(root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: root,
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:fetch"] },
    ],
  });
  t.after(async () => center.close());

  const seed = await fetch(`${center.baseUrl}/v1/papers/ingest-metadata`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
    body: JSON.stringify({
      papers: [
        { doi: OPENALEX_DOI, title: "OpenAlex zygomatic fixture" },
        { doi: PUBMED_DOI, title: "PubMed flap fixture" },
        { doi: MISSING_DOI, title: "No upstream fixture" },
        { doi: ALREADY_DOI, title: "Already enriched fixture", abstract: "Existing abstract text." },
      ],
    }),
  });
  assert.equal(seed.status, 200);

  const listed = await fetch(`${center.baseUrl}/v1/papers/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "", limit: 50, offset: 0 }),
  });
  const listedBody = await listed.json();
  assert.equal(listed.status, 200);
  const byDoi = Object.fromEntries(listedBody.items.map((item) => [item.paper.doi, item.paper]));
  assert.equal(byDoi[OPENALEX_DOI].hasAbstract, false);
  assert.equal(byDoi[OPENALEX_DOI].enrichedAt, null);
  assert.equal(byDoi[ALREADY_DOI].hasAbstract, true);
  assert.ok(byDoi[ALREADY_DOI].enrichedAt);

  const chunks = [];
  const stdout = { write(value) { chunks.push(String(value)); return true; } };
  const fetchFn = mockUpstreamFetch(center.baseUrl);
  const dry = await runEnrichment({
    centerUrl: center.baseUrl,
    token: tokenA,
    dryRun: true,
    fetch: fetchFn,
    sleep: async () => {},
    pubmedMinIntervalMs: 0,
    openAlexMinIntervalMs: 0,
    stdout,
  });
  assert.equal(dry.candidates, 3);
  assert.equal(dry["enriched-with-abstract"], 0);
  assert.match(chunks.join(""), /dry-run=true/u);

  const report = await runEnrichment({
    centerUrl: center.baseUrl,
    token: tokenA,
    fetch: fetchFn,
    sleep: async () => {},
    pubmedMinIntervalMs: 0,
    openAlexMinIntervalMs: 0,
    stdout,
  });
  assert.equal(report.scanned, 4);
  assert.equal(report.candidates, 3);
  assert.equal(report["enriched-with-abstract"], 2);
  assert.equal(report["not-found"], 1);
  assert.equal(report.errors, 0);
  assert.equal(report.sources.openalex.abstracts, 1);
  assert.equal(report.sources.pubmed.abstracts, 1);
  assert.equal(report.sources.pubmed.keywords, 1);
  assert.equal(report.notFoundDois[0], MISSING_DOI);
  assert.ok(report.receiptIds.length >= 1);
  assert.match(report.receiptIds[0], /^metadata_/u);

  const after = await fetch(`${center.baseUrl}/v1/papers/list`, {
    method: "POST",
    headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
    body: JSON.stringify({ query: "", limit: 50, offset: 0 }),
  });
  const afterBody = await after.json();
  const afterByDoi = Object.fromEntries(afterBody.items.map((item) => [item.paper.doi, item.paper]));
  assert.equal(afterByDoi[OPENALEX_DOI].hasAbstract, true);
  assert.deepEqual(afterByDoi[OPENALEX_DOI].keywords, ["zygomatic implant", "Surgery"]);
  assert.equal(afterByDoi[OPENALEX_DOI].keywordsStatus, "hit");
  assert.ok(afterByDoi[OPENALEX_DOI].enrichedAt);
  assert.equal(afterByDoi[PUBMED_DOI].hasAbstract, true);
  assert.deepEqual(afterByDoi[PUBMED_DOI].keywords, ["free flap", "harvest planning"]);
  assert.equal(afterByDoi[PUBMED_DOI].keywordsStatus, "hit");
  assert.equal(afterByDoi[MISSING_DOI].hasAbstract, false);
  assert.equal(afterByDoi[MISSING_DOI].keywordsStatus, "empty");
  assert.ok(afterByDoi[MISSING_DOI].enrichedAt);
});

test("missing bearer is a hard failure", async () => {
  await assert.rejects(
    () => runEnrichment({ centerUrl: "http://127.0.0.1:9", token: "", env: {}, argv: ["node", "script"] }),
    /DENTALBOOK_ADMIN_CENTER_BEARER/u,
  );
});
