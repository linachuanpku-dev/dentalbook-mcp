import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { authorFoldKeys, foldAuthorToken, parseKeywordMatch } from "./author-folds.js";
import { loadCenterUsers, startCenterServer } from "./server.js";
import { CenterStore } from "./store.js";

const DEMO_AUTHOR_ID = "cn.demo.hosp.omfs.001";
const DEMO_V3_ALIAS = "demo:anchor-001";

test("author folds collapse spacing and western order without single surnames", () => {
  assert.equal(foldAuthorToken("Guang-Yan Yu"), "guangyanyu");
  assert.ok(authorFoldKeys("Guang-Yan Yu").includes("yuguangyan"));
  assert.ok(authorFoldKeys("Sam Wang").includes("pengxin"));
  assert.deepEqual(authorFoldKeys("Yu"), []);
  assert.equal(parseKeywordMatch("crown/plant"), "\"crown\" OR \"plant\"");
});

const doi = "10.0000/dentalbook.fixture.1";
const paperId = `test:doi:${doi}`;
const tokenA = "center-test-user-a";
const tokenB = "center-test-user-b";

function hash(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "dentalbook-center-test-"));
  await Promise.all([
    mkdir(resolve(root, "fixtures/source"), { recursive: true }),
    mkdir(resolve(root, "fixtures/catalog"), { recursive: true }),
    mkdir(resolve(root, "manifests"), { recursive: true }),
    mkdir(resolve(root, "objects/sha256"), { recursive: true }),
    mkdir(resolve(root, "staging"), { recursive: true }),
    mkdir(resolve(root, "web"), { recursive: true }),
  ]);
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of [`Dentalbook fixture DOI ${doi}`, "Second page for strong validation"]) {
    const page = document.addPage([400, 400]);
    page.drawText(text, { x: 30, y: 330, size: 12, font });
  }
  const bytes = await document.save({ useObjectStreams: false });
  const sha256 = hash(bytes);
  const sourceFile = `fixtures/source/${sha256}.pdf`;
  await writeFile(resolve(root, sourceFile), bytes);
  await writeFile(resolve(root, "fixtures/catalog/papers.jsonl"), `${JSON.stringify({
    schemaVersion: "dentalbook-test-catalog/v1",
    paperId,
    doi,
    title: "Dentalbook deterministic fixture",
    authors: [
      { authorId: "author:ada-test", name: "Ada Test", institution: "Dentalbook University" },
      "Bert Fixture",
    ],
    pdfStatus: "metadata_only",
  })}\n`);
  await writeFile(resolve(root, "manifests/library.jsonl"), `${JSON.stringify({
    schemaVersion: "dentalbook-test-library/v1",
    testAssetId: "fixture-1",
    paperId,
    doi,
    title: "Dentalbook deterministic fixture",
    sourceFile,
    sha256,
    byteSize: bytes.length,
    pageCount: 2,
    mimeVerified: true,
    identityCheck: "doi_in_pdf_text",
    baselineStatus: "metadata_only",
    expectedAfterIngest: "central_cached",
    expectedAfterUserPull: "local",
  })}\n`);
  await writeFile(resolve(root, "web/index.html"), "<!doctype html><title>Dentalbook Web</title><script src=\"/app.deadbeef.js\"></script>");
  await writeFile(resolve(root, "web/app.js"), "document.body.dataset.ready = 'true';");
  await writeFile(resolve(root, "web/app.deadbeef.js"), "document.body.dataset.hashed = 'true';");
  return { root, sha256, bytes };
}

async function jsonRequest(baseUrl: string, path: string, token: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  });
}

test("user A ingestion becomes a shared central cache hit for user B", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: fixture.root,
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import"] },
    ],
  });
  t.after(async () => center.close());

  const before = await jsonRequest(center.baseUrl, "/v1/papers/get", tokenB, { identifier: doi });
  assert.equal(before.status, 200);
  const beforeBody = await before.json() as { paper: { paperId: string }; pdfProof: { status: string }; metadataUpload?: { role: string; uploadedBy: string; channel: string; uploadedAt: string } };
  assert.equal(beforeBody.paper.paperId, paperId);
  assert.equal(beforeBody.pdfProof.status, "metadata_only");
  assert.equal(beforeBody.metadataUpload?.role, "admin");
  assert.equal(beforeBody.metadataUpload?.uploadedBy, "catalog");
  assert.equal(beforeBody.metadataUpload?.channel, "admin_fetch");
  assert.ok(beforeBody.metadataUpload?.uploadedAt);
  const catalogMetadataAt = beforeBody.metadataUpload?.uploadedAt;

  const denied = await jsonRequest(center.baseUrl, "/v1/papers/fetch-fulltext", tokenB, { identifier: doi });
  assert.equal(denied.status, 403);

  const metaDenied = await jsonRequest(center.baseUrl, "/v1/papers/ingest-metadata", tokenB, {
    papers: [{ doi: "10.0000/dentalbook.meta.1", title: "Metadata-only paper" }],
  });
  assert.equal(metaDenied.status, 403);

  const metadata = await jsonRequest(center.baseUrl, "/v1/papers/ingest-metadata", tokenA, {
    papers: [
      { doi: "10.0000/dentalbook.meta.1", title: "<em>Metadata</em> only paper" },
      { doi: "10.0000/dentalbook.meta.2", title: "Second metadata only paper" },
    ],
  });
  const metadataBody = await metadata.json() as { receiptId: string; data: { created: number; items: Array<{ paper: { paperId: string; title: string; keywordsStatus?: string }; pdfProof: { status: string }; metadataUpload?: { role: string; uploadedBy: string; channel: string }; pdfUpload?: unknown }> } };
  assert.equal(metadata.status, 200);
  assert.match(metadataBody.receiptId, /^metadata_/u);
  assert.equal(metadataBody.data.created, 2);
  assert.equal(metadataBody.data.items[0]?.paper.title, "Metadata only paper");
  assert.equal(metadataBody.data.items[0]?.pdfProof.status, "metadata_only");
  assert.equal(metadataBody.data.items[0]?.metadataUpload?.role, "admin");
  assert.equal(metadataBody.data.items[0]?.metadataUpload?.uploadedBy, "user-a");
  assert.equal(metadataBody.data.items[0]?.metadataUpload?.channel, "admin_fetch");
  assert.equal(metadataBody.data.items[0]?.paper.keywordsStatus, "none");
  assert.equal(metadataBody.data.items[0]?.pdfUpload, undefined);
  assert.equal(metadataBody.data.items[1]?.paper.paperId, "doi:10.0000/dentalbook.meta.2");
  assert.equal(metadataBody.data.items[1]?.metadataUpload?.channel, "admin_fetch");
  assert.equal(metadataBody.data.items[1]?.pdfUpload, undefined);

  const ingest = await jsonRequest(center.baseUrl, "/v1/papers/fetch-fulltext", tokenA, { identifier: doi });
  assert.equal(ingest.status, 200);
  const ingestBody = await ingest.json() as { ok: boolean; receiptId: string; data: { pdfProof: { status: string; fileSha256: string } } };
  assert.equal(ingestBody.ok, true);
  assert.match(ingestBody.receiptId, /^ingest_/u);
  assert.equal(ingestBody.data.pdfProof.status, "central_cached");
  assert.equal(ingestBody.data.pdfProof.fileSha256, fixture.sha256);

  const after = await jsonRequest(center.baseUrl, "/v1/papers/get", tokenB, { identifier: doi });
  const afterBody = await after.json() as { paper: { paperId: string }; pdfProof: { status: string; fileSha256: string }; metadataUpload?: { role: string; uploadedBy: string; channel: string; uploadedAt: string }; pdfUpload?: { role: string; uploadedBy: string; channel: string; uploadedAt: string } };
  assert.equal(afterBody.paper.paperId, paperId);
  assert.equal(afterBody.pdfProof.status, "central_cached");
  assert.equal(afterBody.pdfProof.fileSha256, fixture.sha256);
  assert.equal(afterBody.metadataUpload?.role, "admin");
  assert.equal(afterBody.metadataUpload?.uploadedBy, "catalog");
  assert.equal(afterBody.metadataUpload?.channel, "admin_fetch");
  assert.equal(afterBody.metadataUpload?.uploadedAt, catalogMetadataAt);
  assert.equal(afterBody.pdfUpload?.role, "admin");
  assert.equal(afterBody.pdfUpload?.uploadedBy, "user-a");
  assert.equal(afterBody.pdfUpload?.channel, "admin_fetch");
  assert.ok(afterBody.pdfUpload?.uploadedAt);

  const download = await jsonRequest(center.baseUrl, "/v1/papers/download", tokenB, { paperId });
  assert.equal(download.status, 200);
  const downloaded = new Uint8Array(await download.arrayBuffer());
  assert.equal(hash(downloaded), fixture.sha256);
  assert.equal(download.headers.get("x-dentalbook-sha256"), fixture.sha256);

  const objectPath = resolve(fixture.root, "objects/sha256", fixture.sha256.slice(0, 2), fixture.sha256.slice(2, 4), `${fixture.sha256}.pdf`);
  assert.equal(hash(await readFile(objectPath)), fixture.sha256);
  const database = new DatabaseSync(resolve(fixture.root, "db/shared.sqlite3"), { readOnly: true });
  t.after(() => database.close());
  assert.equal((database.prepare("SELECT count(*) AS count FROM papers").get() as { count: number }).count, 3);
  assert.equal((database.prepare("SELECT count(*) AS count FROM pdf_objects").get() as { count: number }).count, 1);
  assert.equal((database.prepare("SELECT count(*) AS count FROM audit_events").get() as { count: number }).count, 5);
  assert.equal((database.prepare("SELECT count(*) AS count FROM receipts WHERE action = 'admin.papers.ingest_metadata'").get() as { count: number }).count, 2);
});

test("a user PDF upload increases the shared list and remains content-addressed", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: fixture.root,
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import"] },
    ],
  });
  t.after(async () => center.close());

  const uploadDoi = "10.0000/dentalbook.upload.1";
  const document = await PDFDocument.create();
  document.setTitle("User uploaded Dentalbook paper");
  document.setSubject(`Journal article, https://doi.org/${uploadDoi}`);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([400, 400]);
  page.drawText("Uploaded PDF with DOI stored in document metadata", { x: 30, y: 330, size: 12, font });
  const bytes = await document.save({ useObjectStreams: false });
  const uploadSha = hash(bytes);

  const before = await jsonRequest(center.baseUrl, "/v1/library/stats", tokenB, {});
  const beforeBody = await before.json() as { sharedPapers: number; sharedPdfs: number };
  assert.equal(beforeBody.sharedPapers, 1);
  assert.equal(beforeBody.sharedPdfs, 0);

  const upload = await fetch(`${center.baseUrl}/v1/papers/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenB}`,
      "content-type": "application/pdf",
      "content-length": String(bytes.length),
      "x-dentalbook-doi": uploadDoi,
      "x-dentalbook-title-base64": Buffer.from("User uploaded Dentalbook paper").toString("base64url"),
    },
    body: Uint8Array.from(bytes).buffer,
  });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json() as { receiptId: string; data: { paper: { paperId: string }; pdfProof: { status: string; fileSha256: string }; metadataUpload?: { role: string; uploadedBy: string; channel: string }; pdfUpload?: { role: string; uploadedBy: string; channel: string } } };
  assert.match(uploaded.receiptId, /^import_/u);
  assert.equal(uploaded.data.paper.paperId, `doi:${uploadDoi}`);
  assert.equal(uploaded.data.pdfProof.status, "central_cached");
  assert.equal(uploaded.data.pdfProof.fileSha256, uploadSha);
  assert.equal(uploaded.data.metadataUpload?.role, "user");
  assert.equal(uploaded.data.metadataUpload?.uploadedBy, "user-b");
  assert.equal(uploaded.data.metadataUpload?.channel, "user_import");
  assert.equal(uploaded.data.pdfUpload?.role, "user");
  assert.equal(uploaded.data.pdfUpload?.uploadedBy, "user-b");
  assert.equal(uploaded.data.pdfUpload?.channel, "user_import");

  const duplicate = await fetch(`${center.baseUrl}/v1/papers/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenB}`,
      "content-type": "application/pdf",
      "content-length": String(bytes.length),
      "x-dentalbook-doi": uploadDoi,
      "x-dentalbook-title-base64": Buffer.from("User uploaded Dentalbook paper").toString("base64url"),
    },
    body: Uint8Array.from(bytes).buffer,
  });
  assert.equal(duplicate.status, 200);

  const list = await jsonRequest(center.baseUrl, "/v1/papers/list", tokenA, { query: "uploaded", limit: 50, offset: 0 });
  const listed = await list.json() as { total: number; items: Array<{ paper: { paperId: string }; metadataUpload?: { role: string; channel: string }; pdfUpload?: { role: string; channel: string } }>; stats: { sharedPapers: number; sharedPdfs: number } };
  assert.equal(listed.total, 1);
  assert.equal(listed.items[0]?.paper.paperId, `doi:${uploadDoi}`);
  assert.equal(listed.items[0]?.metadataUpload?.role, "user");
  assert.equal(listed.items[0]?.metadataUpload?.channel, "user_import");
  assert.equal(listed.items[0]?.pdfUpload?.role, "user");
  assert.equal(listed.items[0]?.pdfUpload?.channel, "user_import");
  assert.equal(listed.stats.sharedPapers, 2);
  assert.equal(listed.stats.sharedPdfs, 1);

  const database = new DatabaseSync(resolve(fixture.root, "db/shared.sqlite3"), { readOnly: true });
  t.after(() => database.close());
  assert.equal((database.prepare("SELECT count(*) AS count FROM pdf_objects WHERE sha256 = ?").get(uploadSha) as { count: number }).count, 1);
  assert.equal((database.prepare("SELECT count(*) AS count FROM receipts WHERE user_id = 'user-b' AND action = 'papers.import_local'").get() as { count: number }).count, 2);
});

test("standalone web authenticates, lists real papers and authors, and downloads a verified PDF", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: fixture.root,
    webDir: resolve(fixture.root, "web"),
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import"] },
    ],
  });
  t.after(async () => center.close());

  const page = await fetch(`${center.baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Dentalbook Web/u);
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u);
  const docs = await fetch(`${center.baseUrl}/docs`);
  assert.equal(docs.status, 200);
  const docsHtml = await docs.text();
  assert.match(docsHtml, /Dentalbook Web/u);
  assert.match(docsHtml, /app\.deadbeef\.js/u);
  const hashed = await fetch(`${center.baseUrl}/app.deadbeef.js`);
  assert.equal(hashed.status, 200);
  assert.match(await hashed.text(), /hashed/u);
  assert.equal(hashed.headers.get("cache-control"), "no-store");

  const unauthenticated = await fetch(`${center.baseUrl}/web/api/v1/papers`);
  assert.equal(unauthenticated.status, 401);

  const login = await fetch(`${center.baseUrl}/web/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tokenB }),
  });
  assert.equal(login.status, 200);
  const doctorSession = await login.json() as { canViewUsers?: boolean };
  assert.equal(doctorSession.canViewUsers, false);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie?.startsWith("dentalbook_session=")) throw new Error("The web login did not return a session cookie.");
  assert.equal(cookie.includes(tokenB), false);
  const doctorUsers = await fetch(`${center.baseUrl}/web/api/v1/users`, { headers: { cookie } });
  assert.equal(doctorUsers.status, 403);

  const adminLogin = await fetch(`${center.baseUrl}/web/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tokenA }),
  });
  const adminSession = await adminLogin.json() as { canViewUsers?: boolean };
  assert.equal(adminLogin.status, 200);
  assert.equal(adminSession.canViewUsers, true);
  const adminCookie = adminLogin.headers.get("set-cookie")?.split(";", 1)[0];
  if (!adminCookie?.startsWith("dentalbook_session=")) throw new Error("The admin web login did not return a session cookie.");
  const adminUsers = await fetch(`${center.baseUrl}/web/api/v1/users`, { headers: { cookie: adminCookie } });
  assert.equal(adminUsers.status, 200);

  const papers = await fetch(`${center.baseUrl}/web/api/v1/papers?limit=20`, { headers: { cookie } });
  const paperBody = await papers.json() as { total: number; stats: { sharedPapers: number }; items: Array<{ paper: { keywordsStatus?: string }; metadataUpload?: { role: string; uploadedBy: string; channel: string; uploadedAt: string }; pdfUpload?: unknown }> };
  assert.equal(papers.status, 200);
  assert.equal(paperBody.total, 1);
  assert.equal(paperBody.stats.sharedPapers, 1);
  assert.equal(paperBody.items[0]?.paper.keywordsStatus, "none");
  assert.equal(paperBody.items[0]?.metadataUpload?.role, "admin");
  assert.equal(paperBody.items[0]?.metadataUpload?.uploadedBy, "catalog");
  assert.equal(paperBody.items[0]?.metadataUpload?.channel, "admin_fetch");
  assert.ok(paperBody.items[0]?.metadataUpload?.uploadedAt);
  assert.equal(paperBody.items[0]?.pdfUpload, undefined);
  const catalogMetadataAt = paperBody.items[0]?.metadataUpload?.uploadedAt;

  const authors = await fetch(`${center.baseUrl}/web/api/v1/authors?query=Dentalbook`, { headers: { cookie } });
  const authorBody = await authors.json() as { total: number; items: Array<{ authorId: string; paperCount: number }> };
  assert.equal(authors.status, 200);
  assert.equal(authorBody.total, 1);
  assert.equal(authorBody.items[0]?.authorId, "author:ada-test");
  assert.equal(authorBody.items[0]?.paperCount, 1);

  const ingest = await jsonRequest(center.baseUrl, "/v1/papers/fetch-fulltext", tokenA, { identifier: paperId });
  assert.equal(ingest.status, 200);
  const papersAfter = await fetch(`${center.baseUrl}/web/api/v1/papers?limit=20`, { headers: { cookie } });
  const papersAfterBody = await papersAfter.json() as { items: Array<{ metadataUpload?: { role: string; uploadedBy: string; channel: string; uploadedAt: string }; pdfUpload?: { role: string; uploadedBy: string; channel: string; uploadedAt: string } }> };
  assert.equal(papersAfter.status, 200);
  assert.equal(papersAfterBody.items[0]?.metadataUpload?.role, "admin");
  assert.equal(papersAfterBody.items[0]?.metadataUpload?.uploadedBy, "catalog");
  assert.equal(papersAfterBody.items[0]?.metadataUpload?.channel, "admin_fetch");
  assert.equal(papersAfterBody.items[0]?.metadataUpload?.uploadedAt, catalogMetadataAt);
  assert.equal(papersAfterBody.items[0]?.pdfUpload?.role, "admin");
  assert.equal(papersAfterBody.items[0]?.pdfUpload?.uploadedBy, "user-a");
  assert.equal(papersAfterBody.items[0]?.pdfUpload?.channel, "admin_fetch");
  assert.ok(papersAfterBody.items[0]?.pdfUpload?.uploadedAt);
  const pdf = await fetch(`${center.baseUrl}/web/api/v1/papers/${encodeURIComponent(paperId)}/pdf`, { headers: { cookie } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("x-dentalbook-sha256"), fixture.sha256);
  assert.equal(hash(new Uint8Array(await pdf.arrayBuffer())), fixture.sha256);
});

test("author registry seeds three-layer fixtures and accepts admin upsert plus user notes", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(resolve(fixture.root, "fixtures/authors"), { recursive: true });
  const authors = Array.from({ length: 10 }, (_, index) => ({
    authorId: `author:fixture-${index + 1}`,
    displayNameZh: `夹具作者${index + 1}`,
    displayNameEn: `Fixture Author ${index + 1}`,
    institution: "Dentalbook Test Hospital",
    identityStatus: "imported",
    englishNameVariants: [`F. Author ${index + 1}`, `Author Fixture ${index + 1}`],
    works: [{ doi: `10.0000/dentalbook.author.${index + 1}`, title: `Fixture work ${index + 1}`, year: 2024, byline: `Fixture Author ${index + 1}`, matchBasis: "en_name" }],
  }));
  await writeFile(resolve(fixture.root, "fixtures/authors/anonymous-10.jsonl"), `${authors.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const center = await startCenterServer({
    rootDir: fixture.root,
    webDir: resolve(fixture.root, "web"),
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch", "authors:admin"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import", "authors:contribute"] },
    ],
  });
  t.after(async () => center.close());

  const listed = await jsonRequest(center.baseUrl, "/v1/authors/list", tokenB, { query: "夹具作者", limit: 20, offset: 0 });
  const listBody = await listed.json() as { total: number; items: Array<{ authorId: string; displayNameZh?: string; paperCount: number; sourceStatuses?: Array<{ source: string; state: string }>; importEvents?: unknown[] }> };
  assert.equal(listed.status, 200);
  assert.equal(listBody.total, 10);
  assert.equal(listBody.items[0]?.displayNameZh?.startsWith("夹具作者"), true);
  assert.equal(listBody.items[0]?.paperCount, 1);
  assert.equal(listBody.items[0]?.importEvents, undefined);
  assert.equal(listBody.items[0]?.sourceStatuses?.find((item) => item.source === "v3")?.state, "hit");
  assert.equal(listBody.items[0]?.sourceStatuses?.find((item) => item.source === "orcid")?.state, "none");

  const adminListed = await jsonRequest(center.baseUrl, "/v1/authors/list", tokenA, { query: "夹具作者1", limit: 5, offset: 0 });
  const adminListBody = await adminListed.json() as { items: Array<{ importEvents?: Array<{ kind: string; source: string; hitCount: number }> }> };
  assert.equal(adminListed.status, 200);
  assert.ok(adminListBody.items[0]?.importEvents?.some((event) => event.kind === "roster" && event.source === "v3" && event.hitCount === 1));

  const detail = await jsonRequest(center.baseUrl, "/v1/authors/get", tokenB, { identifier: "author:fixture-1" });
  const detailBody = await detail.json() as { author: { displayNameZh: string; englishNameVariants: string[]; works: Array<{ title: string }>; notes: unknown[] } };
  assert.equal(detail.status, 200);
  assert.equal(detailBody.author.displayNameZh, "夹具作者1");
  assert.deepEqual(detailBody.author.englishNameVariants, ["Author Fixture 1", "F. Author 1"]);
  assert.equal(detailBody.author.works[0]?.title, "Fixture work 1");
  assert.equal(detailBody.author.notes.length, 0);

  const denied = await jsonRequest(center.baseUrl, "/v1/authors/upsert", tokenB, { authorId: "author:fixture-1", displayNameEn: "Reviewed Author 1" });
  assert.equal(denied.status, 403);

  const upsert = await jsonRequest(center.baseUrl, "/v1/authors/upsert", tokenA, {
    authorId: "author:fixture-1",
    displayNameEn: "Reviewed Author 1",
    englishNameVariants: ["R. Author 1"],
  });
  const upsertBody = await upsert.json() as { ok: boolean; receiptId: string; data: { displayNameEn: string; identityStatus: string; englishNameVariants: string[] } };
  assert.equal(upsert.status, 200);
  assert.match(upsertBody.receiptId, /^author_admin_/u);
  assert.equal(upsertBody.data.displayNameEn, "Reviewed Author 1");
  assert.equal(upsertBody.data.identityStatus, "reviewed");
  assert.ok(upsertBody.data.englishNameVariants.includes("R. Author 1"));

  const noteDenied = await jsonRequest(center.baseUrl, "/v1/authors/submit-note", tokenA, { authorId: "author:fixture-1", kind: "abbreviation", body: "RA1 is the accepted abbreviation." });
  assert.equal(noteDenied.status, 403);

  const note = await jsonRequest(center.baseUrl, "/v1/authors/submit-note", tokenB, { authorId: "author:fixture-1", kind: "abbreviation", body: "RA1 is the accepted abbreviation." });
  const noteBody = await note.json() as { receiptId: string; data: { notes: Array<{ kind: string; body: string }> } };
  assert.equal(note.status, 200);
  assert.match(noteBody.receiptId, /^author_note_/u);
  assert.equal(noteBody.data.notes[0]?.kind, "abbreviation");

  const publicBefore = await jsonRequest(center.baseUrl, "/v1/authors/get", tokenB, { identifier: "author:fixture-1" });
  const publicBeforeBody = await publicBefore.json() as { author: { relations: unknown[] } };
  assert.equal(publicBeforeBody.author.relations.length, 0);

  const relationDenied = await jsonRequest(center.baseUrl, "/v1/authors/submit-relation", tokenA, {
    authorId: "author:fixture-1",
    mentor: "Mentor A",
    students: ["Student A"],
  });
  assert.equal(relationDenied.status, 403);

  const submitted = await jsonRequest(center.baseUrl, "/v1/authors/submit-relation", tokenB, {
    authorId: "author:fixture-1",
    mentor: "Mentor A",
    students: ["Student A", "Student B"],
    body: "Observed mentorship from the shared clinic record.",
  });
  const submittedBody = await submitted.json() as {
    receiptId: string;
    data: { relation: { relationId: string; status: string; submittedBy: string; submittedAt: string; mentor?: string; students?: string[] }; author: { relations: unknown[] } };
  };
  assert.equal(submitted.status, 200);
  assert.match(submittedBody.receiptId, /^author_relation_/u);
  assert.equal(submittedBody.data.relation.status, "pending");
  assert.equal(submittedBody.data.relation.submittedBy, "user-b");
  assert.ok(submittedBody.data.relation.submittedAt);
  assert.equal(submittedBody.data.relation.mentor, "Mentor A");
  assert.deepEqual(submittedBody.data.relation.students, ["Student A", "Student B"]);
  assert.equal(submittedBody.data.author.relations.length, 0);

  const listedRelations = await jsonRequest(center.baseUrl, "/v1/authors/relations", tokenA, { authorId: "author:fixture-1", status: "pending" });
  const listedBody = await listedRelations.json() as { total: number; items: Array<{ relationId: string }> };
  assert.equal(listedRelations.status, 200);
  assert.equal(listedBody.total, 1);

  const reviewDenied = await jsonRequest(center.baseUrl, "/v1/authors/review-relation", tokenB, { relationId: listedBody.items[0]?.relationId, decision: "approved" });
  assert.equal(reviewDenied.status, 403);

  const reviewed = await jsonRequest(center.baseUrl, "/v1/authors/review-relation", tokenA, { relationId: listedBody.items[0]?.relationId, decision: "approved" });
  const reviewedBody = await reviewed.json() as { receiptId: string; data: { relation: { status: string; reviewedBy: string; reviewedAt: string } } };
  assert.equal(reviewed.status, 200);
  assert.match(reviewedBody.receiptId, /^author_review_/u);
  assert.equal(reviewedBody.data.relation.status, "approved");
  assert.equal(reviewedBody.data.relation.reviewedBy, "user-a");
  assert.ok(reviewedBody.data.relation.reviewedAt);

  const publicAfter = await jsonRequest(center.baseUrl, "/v1/authors/get", tokenB, { identifier: "author:fixture-1" });
  const publicAfterBody = await publicAfter.json() as { author: { relations: Array<{ mentor?: string; students?: string[]; submittedBy: string; reviewedBy?: string }> } };
  assert.equal(publicAfter.status, 200);
  assert.equal(publicAfterBody.author.relations.length, 1);
  assert.equal(publicAfterBody.author.relations[0]?.mentor, "Mentor A");
  assert.deepEqual(publicAfterBody.author.relations[0]?.students, ["Student A", "Student B"]);
  assert.equal(publicAfterBody.author.relations[0]?.submittedBy, "user-b");
  assert.equal(publicAfterBody.author.relations[0]?.reviewedBy, "user-a");

  const page = await fetch(`${center.baseUrl}/authors/${encodeURIComponent("author:fixture-1")}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Dentalbook Web/u);
});

test("admin author merge review records v3 and four-source queries without registering resolve", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(resolve(fixture.root, "fixtures/authors"), { recursive: true });
  const queriedAt = "2026-08-18T00:00:00.000Z";
  await writeFile(resolve(fixture.root, "fixtures/authors/merge-focus.jsonl"), `${JSON.stringify({
    authorId: DEMO_AUTHOR_ID,
    displayNameZh: "俞光岩",
    displayNameEn: "Guang-Yan Yu",
    institution: "示例口腔医院",
    countryCode: "cn",
    universityCode: "pku",
    hospitalCode: "pkuss",
    disciplineCode: "omfs",
    aliases: [DEMO_V3_ALIAS],
    openalexId: "A5082812729",
    orcid: "0000-0000-0000-0414",
    identityStatus: "imported",
    works: [{ doi: "10.0000/dentalbook.yu.1", title: "Yu fixture work", year: 2024, byline: "Guang-Yan Yu", matchBasis: "v3", sources: ["v3"] }],
    merge: {
      createdBy: "fixture",
      queries: [
        { source: "v3", queriedAt, hitCount: 1, empty: false },
        { source: "orcid", queriedAt, hitCount: 0, empty: true },
        { source: "openalex", queriedAt, hitCount: 0, empty: true },
        { source: "crossref", queriedAt, hitCount: 0, empty: true },
        { source: "pubmed", queriedAt, hitCount: 0, empty: true },
      ],
      conflicts: [{ kind: "name_check", body: "Confirm Guang-Yan Yu against the PKU roster." }],
    },
  })}\n`);
  const center = await startCenterServer({
    rootDir: fixture.root,
    webDir: resolve(fixture.root, "web"),
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch", "authors:admin"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import", "authors:contribute"] },
    ],
  });
  t.after(async () => center.close());

  const denied = await jsonRequest(center.baseUrl, "/v1/authors/merges/list", tokenB, {});
  assert.equal(denied.status, 403);

  const listed = await jsonRequest(center.baseUrl, "/v1/authors/merges/list", tokenA, {});
  const listedBody = await listed.json() as { total: number; items: Array<{ authorId: string; status: string; sourcesComplete: boolean; identityPinned: boolean }> };
  assert.equal(listed.status, 200);
  assert.equal(listedBody.total, 1);
  assert.equal(listedBody.items[0]?.authorId, DEMO_AUTHOR_ID);
  assert.equal(listedBody.items[0]?.status, "pending");
  assert.equal(listedBody.items[0]?.sourcesComplete, true);
  assert.equal(listedBody.items[0]?.identityPinned, true);

  const ingest = await jsonRequest(center.baseUrl, "/v1/authors/merges/ingest", tokenA, {
    authorId: DEMO_AUTHOR_ID,
    displayNameZh: "俞光岩",
    displayNameEn: "Guang-Yan Yu",
    openalexId: "A5082812729",
    works: [{ doi: "10.0000/dentalbook.yu.2", title: "OpenAlex extra work", year: 2025, sources: ["openalex"], matchBasis: "openalex" }],
    queries: [
      { source: "v3", queriedAt, hitCount: 1, empty: false },
      { source: "orcid", queriedAt, hitCount: 0, empty: true },
      { source: "openalex", queriedAt, hitCount: 1, empty: false },
      { source: "crossref", queriedAt, hitCount: 0, empty: true },
      { source: "pubmed", queriedAt, hitCount: 0, empty: true },
    ],
  });
  const ingestBody = await ingest.json() as { receiptId: string; data: { latest: { papersIngested: number; workCount: number }; author: { works: Array<{ doi: string; sources?: string[] }> } } };
  assert.equal(ingest.status, 200);
  assert.match(ingestBody.receiptId, /^author_merge_/u);
  assert.equal(ingestBody.data.latest.workCount, 2);
  assert.equal(ingestBody.data.latest.papersIngested, 2);
  assert.ok(ingestBody.data.author.works.some((work) => work.doi === "10.0000/dentalbook.yu.1" && work.sources?.includes("v3")));
  assert.ok(ingestBody.data.author.works.some((work) => work.doi === "10.0000/dentalbook.yu.2" && work.sources?.includes("openalex")));

  const publicAuthor = await jsonRequest(center.baseUrl, "/v1/authors/get", tokenB, { identifier: DEMO_V3_ALIAS });
  const publicBody = await publicAuthor.json() as { author: { authorId: string; authorIdAliases?: string[]; countryCode?: string; universityCode?: string; hospitalCode?: string; disciplineCode?: string; sourceStatuses?: Array<{ source: string; state: string }>; importEvents?: unknown[]; works: Array<{ doi: string; library?: { paper: { doi: string; paperId: string }; pdfProof: { status: string } } }>; papers: Array<{ doi: string }>; merge?: unknown } };
  assert.equal(publicAuthor.status, 200);
  assert.equal(publicBody.author.authorId, DEMO_AUTHOR_ID);
  assert.equal(publicBody.author.importEvents, undefined);
  assert.equal(publicBody.author.sourceStatuses?.find((item) => item.source === "v3")?.state, "hit");
  assert.equal(publicBody.author.sourceStatuses?.find((item) => item.source === "orcid")?.state, "empty");
  assert.equal(publicBody.author.sourceStatuses?.find((item) => item.source === "openalex")?.state, "hit");
  assert.deepEqual(publicBody.author.authorIdAliases, [DEMO_V3_ALIAS]);
  assert.equal(publicBody.author.countryCode, "cn");
  assert.equal(publicBody.author.universityCode, "pku");
  assert.equal(publicBody.author.hospitalCode, "pkuss");
  assert.equal(publicBody.author.disciplineCode, "omfs");
  assert.equal(publicBody.author.works.length, 2);
  assert.equal(publicBody.author.merge, undefined);
  assert.equal(publicBody.author.papers.length, 2);
  assert.ok(publicBody.author.works.every((work) => work.library?.paper.doi === work.doi && work.library.pdfProof.status === "metadata_only"));

  const confirmed = await jsonRequest(center.baseUrl, "/v1/authors/merges/review", tokenA, { authorId: DEMO_AUTHOR_ID, decision: "confirmed" });
  const confirmedBody = await confirmed.json() as { receiptId: string; data: { latest: { status: string } } };
  assert.equal(confirmed.status, 200);
  assert.match(confirmedBody.receiptId, /^author_merge_review_/u);
  assert.equal(confirmedBody.data.latest.status, "confirmed");

  const returned = await jsonRequest(center.baseUrl, "/v1/authors/merges/review", tokenA, { authorId: DEMO_AUTHOR_ID, decision: "returned" });
  const returnedBody = await returned.json() as { data: { latest: { status: string } } };
  assert.equal(returned.status, 200);
  assert.equal(returnedBody.data.latest.status, "returned");

  const paper = await jsonRequest(center.baseUrl, "/v1/papers/get", tokenB, { identifier: "doi:10.0000/dentalbook.yu.2" });
  assert.equal(paper.status, 200);

  const bulkyWorks = Array.from({ length: 400 }, (_, index) => ({
    doi: `10.0000/dentalbook.yu.bulk.${index}`,
    title: `Bulk OpenAlex work ${index} ${"x".repeat(120)}`,
    year: 2020,
    sources: ["openalex"],
    matchBasis: "openalex",
  }));
  const bulky = await jsonRequest(center.baseUrl, "/v1/authors/merges/ingest", tokenA, {
    authorId: DEMO_AUTHOR_ID,
    works: bulkyWorks,
    queries: [
      { source: "v3", queriedAt, hitCount: 1, empty: false },
      { source: "orcid", queriedAt, hitCount: 0, empty: true },
      { source: "openalex", queriedAt, hitCount: bulkyWorks.length, empty: false },
      { source: "crossref", queriedAt, hitCount: 0, empty: true },
      { source: "pubmed", queriedAt, hitCount: 0, empty: true },
    ],
  });
  const bulkyBody = await bulky.json() as { data: { latest: { workCount: number } } };
  assert.equal(bulky.status, 200);
  assert.ok(bulkyBody.data.latest.workCount >= 400);
});

test("papers.search resolves Yu aliases onto the same maxillary set and does not fall back", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(resolve(fixture.root, "fixtures/authors"), { recursive: true });
  await writeFile(resolve(fixture.root, "fixtures/authors/merge-focus.jsonl"), `${JSON.stringify({
    authorId: DEMO_AUTHOR_ID,
    displayNameZh: "俞光岩",
    displayNameEn: "Guang-Yan Yu",
    institution: "示例口腔医院",
    countryCode: "cn",
    universityCode: "pku",
    hospitalCode: "pkuss",
    disciplineCode: "omfs",
    aliases: [DEMO_V3_ALIAS],
    identityStatus: "imported",
    englishNameVariants: ["Yu Guangyan", "Guangyan Yu"],
    works: [
      { doi: "10.0000/dentalbook.yu.max", title: "Maxillary reconstruction after tumor resection", year: 2024, sources: ["v3"] },
      { doi: "10.0000/dentalbook.yu.cancers", title: "Locally advanced maxillary cancers", year: 2022, sources: ["v3"] },
      { doi: "10.0000/dentalbook.yu.other", title: "Salivary gland adenoma review", year: 2023, sources: ["v3"] },
    ],
    merge: {
      createdBy: "fixture",
      queries: [{ source: "v3", queriedAt: "2026-08-18T00:00:00.000Z", hitCount: 2, empty: false }],
    },
  })}\n`);
  const catalogPath = resolve(fixture.root, "fixtures/catalog/papers.jsonl");
  const catalog = await readFile(catalogPath, "utf8");
  await writeFile(catalogPath, `${catalog}${JSON.stringify({
    paperId: "doi:10.0000/dentalbook.yu.max",
    doi: "10.0000/dentalbook.yu.max",
    title: "Maxillary reconstruction after tumor resection",
  })}\n${JSON.stringify({
    paperId: "doi:10.0000/dentalbook.yu.cancers",
    doi: "10.0000/dentalbook.yu.cancers",
    title: "Locally advanced maxillary cancers",
  })}\n${JSON.stringify({
    paperId: "doi:10.0000/dentalbook.yu.other",
    doi: "10.0000/dentalbook.yu.other",
    title: "Salivary gland adenoma review",
  })}\n${JSON.stringify({
    paperId: "doi:10.0000/dentalbook.other.max",
    doi: "10.0000/dentalbook.other.max",
    title: "Unrelated maxillary implant trial",
  })}\n`);
  const center = await startCenterServer({
    rootDir: fixture.root,
    webDir: resolve(fixture.root, "web"),
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:fetch", "authors:admin"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read"] },
    ],
  });
  t.after(async () => center.close());

  const aliases = ["Guang-Yan Yu", "guangyan yu", DEMO_V3_ALIAS, DEMO_AUTHOR_ID, "俞光岩", "Yu Guangyan"];
  const doiSets: string[][] = [];
  for (const author of aliases) {
    const listed = await jsonRequest(center.baseUrl, "/v1/authors/list", tokenB, { query: author });
    const listedBody = await listed.json() as { items: Array<{ authorId: string }> };
    assert.equal(listed.status, 200);
    assert.ok(listedBody.items.some((item) => item.authorId === DEMO_AUTHOR_ID));
    const searched = await jsonRequest(center.baseUrl, "/v1/papers/search", tokenB, { author, keywords: "maxillary", limit: 50, offset: 0 });
    const body = await searched.json() as { resolvedAuthorId?: string; items?: Array<{ paper: { doi: string } }>; errorCode?: string };
    assert.equal(searched.status, 200, `${author} search failed: ${JSON.stringify(body)}`);
    assert.equal(body.resolvedAuthorId, DEMO_AUTHOR_ID);
    const dois = (body.items ?? []).map((item) => item.paper.doi).sort();
    assert.deepEqual(dois, ["10.0000/dentalbook.yu.cancers", "10.0000/dentalbook.yu.max"]);
    doiSets.push(dois);
  }
  assert.ok(doiSets.every((set) => JSON.stringify(set) === JSON.stringify(doiSets[0])));
  const cancers = await jsonRequest(center.baseUrl, "/v1/papers/search", tokenB, { author: "Guang-Yan Yu", keywords: "cancer" });
  const cancersBody = await cancers.json() as { items?: Array<{ paper: { doi: string } }> };
  assert.equal(cancers.status, 200);
  assert.deepEqual((cancersBody.items ?? []).map((item) => item.paper.doi).sort(), ["10.0000/dentalbook.yu.cancers"]);

  const missing = await jsonRequest(center.baseUrl, "/v1/papers/search", tokenB, { author: "Liu Yunsong", keywords: "maxillary" });
  const missingBody = await missing.json() as { errorCode?: string; items?: unknown[] };
  assert.equal(missing.status, 404);
  assert.equal(missingBody.errorCode, "not_found");
  assert.equal(missingBody.items, undefined);
});

test("relocateAuthorId preserves works and maps the old id as an alias", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(resolve(fixture.root, "fixtures/authors"), { recursive: true });
  await writeFile(resolve(fixture.root, "fixtures/authors/merge-focus.jsonl"), `${JSON.stringify({
    authorId: DEMO_V3_ALIAS,
    displayNameZh: "俞光岩",
    displayNameEn: "Guang-Yan Yu",
    institution: "示例口腔医院",
    countryCode: "cn",
    universityCode: "pku",
    hospitalCode: "pkuss",
    disciplineCode: "omfs",
    works: [{ doi: "10.0000/dentalbook.yu.relocate", title: "Relocate fixture work", year: 2024, sources: ["v3"] }],
  })}\n`);
  const store = await CenterStore.open(fixture.root);
  t.after(() => store.close());
  assert.equal(store.health().schemaVersion, "12");
  const before = store.getAuthor(DEMO_V3_ALIAS);
  assert.equal(before.authorId, DEMO_V3_ALIAS);
  assert.equal(before.works.length, 1);
  store.relocateAuthorId(DEMO_V3_ALIAS, DEMO_AUTHOR_ID);
  const byAlias = store.getAuthor(DEMO_V3_ALIAS);
  assert.equal(byAlias.authorId, DEMO_AUTHOR_ID);
  assert.equal(byAlias.works.length, 1);
  assert.equal(byAlias.works[0]?.doi, "10.0000/dentalbook.yu.relocate");
  assert.deepEqual(byAlias.authorIdAliases, [DEMO_V3_ALIAS]);
  assert.equal(byAlias.countryCode, "cn");
  assert.equal(byAlias.universityCode, "pku");
  assert.equal(byAlias.hospitalCode, "pkuss");
  assert.equal(byAlias.disciplineCode, "omfs");
  const byCanonical = store.getAuthor(DEMO_AUTHOR_ID);
  assert.equal(byCanonical.authorId, DEMO_AUTHOR_ID);
  assert.equal(byCanonical.works.length, 1);
});

test("author fixture relocates an old v3 id onto the minted authorId without nesting transactions", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(resolve(fixture.root, "fixtures/authors"), { recursive: true });
  await writeFile(resolve(fixture.root, "fixtures/authors/old.jsonl"), `${JSON.stringify({
    authorId: DEMO_V3_ALIAS,
    displayNameZh: "俞光岩",
    displayNameEn: "Guang-Yan Yu",
    works: [{ doi: "10.0000/dentalbook.yu.seed", title: "Seed work", year: 2023, sources: ["v3"] }],
    merge: {
      createdBy: "fixture",
      queries: [{ source: "v3", queriedAt: "2026-08-19T00:00:00.000Z", hitCount: 1, empty: false }],
    },
  })}\n`);
  const first = await CenterStore.open(fixture.root);
  first.close();
  await writeFile(resolve(fixture.root, "fixtures/authors/old.jsonl"), `${JSON.stringify({
    authorId: DEMO_AUTHOR_ID,
    aliases: [DEMO_V3_ALIAS],
    displayNameZh: "俞光岩",
    displayNameEn: "Guang-Yan Yu",
    countryCode: "cn",
    universityCode: "pku",
    hospitalCode: "pkuss",
    disciplineCode: "omfs",
  })}\n`);
  const store = await CenterStore.open(fixture.root);
  t.after(() => store.close());
  const author = store.getAuthor(DEMO_V3_ALIAS);
  assert.equal(author.authorId, DEMO_AUTHOR_ID);
  assert.equal(author.works.length, 1);
  assert.equal(author.works[0]?.doi, "10.0000/dentalbook.yu.seed");
});

test("author fixtures omit works without wiping author_works", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(resolve(fixture.root, "fixtures/authors"), { recursive: true });
  await writeFile(resolve(fixture.root, "fixtures/authors/keep-works.jsonl"), `${JSON.stringify({
    authorId: "author:keep-works",
    displayNameZh: "保留作品",
    displayNameEn: "Keep Works",
    orcid: "0000-0000-0000-0999",
    works: [{ doi: "10.0000/dentalbook.keep.1", title: "Keep fixture work", year: 2024, sources: ["v3"] }],
  })}\n`);
  const first = await CenterStore.open(fixture.root);
  assert.equal(first.getAuthor("author:keep-works").works.length, 1);
  first.close();
  await writeFile(resolve(fixture.root, "fixtures/authors/keep-works.jsonl"), `${JSON.stringify({
    authorId: "author:keep-works",
    displayNameZh: "保留作品",
    displayNameEn: "Keep Works",
    orcid: "0000-0000-0000-0999",
  })}\n`);
  const store = await CenterStore.open(fixture.root);
  t.after(() => store.close());
  const author = store.getAuthor("author:keep-works");
  assert.equal(author.works.length, 1);
  assert.equal(author.works[0]?.doi, "10.0000/dentalbook.keep.1");
  assert.equal(author.paperCount, 1);
});

test("works ingest unions by DOI and records admin-only v3 import times", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(resolve(fixture.root, "fixtures/authors"), { recursive: true });
  await writeFile(resolve(fixture.root, "fixtures/authors/merge-focus.jsonl"), `${JSON.stringify({
    authorId: DEMO_AUTHOR_ID,
    displayNameZh: "俞光岩",
    displayNameEn: "Guang-Yan Yu",
    aliases: [DEMO_V3_ALIAS],
    orcid: "0000-0000-0000-0414",
    works: Array.from({ length: 362 }, (_, index) => ({
      doi: `10.0000/dentalbook.yu.seed.${index + 1}`,
      title: `Yu seed work ${index + 1}`,
      year: 2020,
      sources: ["v3"],
    })),
    merge: {
      createdBy: "fixture",
      queries: [
        { source: "v3", queriedAt: "2026-08-18T00:00:00.000Z", hitCount: 362, empty: false },
        { source: "orcid", queriedAt: "2026-08-18T00:00:00.000Z", hitCount: 0, empty: true },
        { source: "openalex", queriedAt: "2026-08-18T00:00:00.000Z", hitCount: 1, empty: false },
        { source: "crossref", queriedAt: "2026-08-18T00:00:00.000Z", hitCount: 0, empty: true },
        { source: "pubmed", queriedAt: "2026-08-18T00:00:00.000Z", hitCount: 0, empty: true },
      ],
    },
  })}\n${JSON.stringify({
    authorId: "author:orcid-hit",
    displayNameZh: "有号作者",
    displayNameEn: "Orcid Author",
    orcid: "0000-0002-1825-0097",
  })}\n`);
  const center = await startCenterServer({
    rootDir: fixture.root,
    webDir: resolve(fixture.root, "web"),
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch", "authors:admin"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import", "authors:contribute"] },
    ],
  });
  t.after(async () => center.close());

  const denied = await jsonRequest(center.baseUrl, "/v1/authors/works/ingest", tokenB, { authorId: "author:orcid-hit", works: [] });
  assert.equal(denied.status, 403);

  const orcidIngest = await jsonRequest(center.baseUrl, "/v1/authors/works/ingest", tokenA, {
    authorId: "author:orcid-hit",
    works: [
      { doi: "10.0000/dentalbook.orcid.1", title: "ORCID matched work", year: 2024, sources: ["v3"], matchBasis: "orcid" },
      { doi: "10.0000/dentalbook.orcid.2", title: "Second ORCID work", year: 2023, sources: ["v3"], matchBasis: "orcid" },
    ],
  });
  const orcidBody = await orcidIngest.json() as { receiptId: string; data: { paperCount: number; sourceStatuses: Array<{ source: string; state: string }>; importEvents?: Array<{ kind: string; source: string }> } };
  assert.equal(orcidIngest.status, 200);
  assert.match(orcidBody.receiptId, /^author_works_ingest_/u);
  assert.ok(orcidBody.data.paperCount > 0);
  assert.equal(orcidBody.data.sourceStatuses.find((item) => item.source === "v3")?.state, "hit");

  const emptyIngest = await jsonRequest(center.baseUrl, "/v1/authors/works/ingest", tokenA, { authorId: "author:orcid-hit", works: [] });
  assert.equal(emptyIngest.status, 200);

  const yuIngest = await jsonRequest(center.baseUrl, "/v1/authors/works/ingest", tokenA, {
    authorId: DEMO_V3_ALIAS,
    works: [{ doi: "10.0000/dentalbook.yu.extra", title: "Extra v3 work", year: 2025, sources: ["v3"] }],
  });
  const yuBody = await yuIngest.json() as { data: { works: Array<{ doi: string }>; sourceStatuses: Array<{ source: string; state: string }>; importEvents?: Array<{ kind: string; source: string; occurredAt: string }> } };
  assert.equal(yuIngest.status, 200);
  assert.ok(yuBody.data.works.length >= 362);
  assert.equal(yuBody.data.sourceStatuses.find((item) => item.source === "v3")?.state, "hit");
  assert.ok(yuBody.data.importEvents?.some((event) => event.kind === "roster" && event.source === "v3"));
  assert.ok(yuBody.data.importEvents?.some((event) => event.kind === "works" && event.source === "v3"));
  assert.ok((yuBody.data.importEvents?.filter((event) => event.source === "v3").length ?? 0) >= 2);

  const doctor = await jsonRequest(center.baseUrl, "/v1/authors/list", tokenB, { query: "俞光岩", limit: 5, offset: 0 });
  const doctorBody = await doctor.json() as { items: Array<{ importEvents?: unknown[]; sourceStatuses?: Array<{ source: string; state: string }> }> };
  assert.equal(doctor.status, 200);
  assert.equal(doctorBody.items[0]?.importEvents, undefined);
  assert.equal(doctorBody.items[0]?.sourceStatuses?.find((item) => item.source === "v3")?.state, "hit");

  const admin = await jsonRequest(center.baseUrl, "/v1/authors/list", tokenA, { query: "俞光岩", limit: 5, offset: 0 });
  const adminBody = await admin.json() as { items: Array<{ importEvents?: Array<{ kind: string; source: string }> }> };
  assert.equal(admin.status, 200);
  assert.ok((adminBody.items[0]?.importEvents?.filter((event) => event.source === "v3").length ?? 0) >= 2);
});

async function uploadPdf(baseUrl: string, token: string, bytes: Uint8Array, uploadDoi: string, title: string) {
  return fetch(`${baseUrl}/v1/papers/import`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/pdf",
      "content-length": String(bytes.length),
      "x-dentalbook-doi": uploadDoi,
      "x-dentalbook-title-base64": Buffer.from(title).toString("base64url"),
    },
    body: Uint8Array.from(bytes).buffer,
  });
}

async function buildPdfWithDoi(uploadDoi: string, title: string, bodyText: string) {
  const document = await PDFDocument.create();
  document.setTitle(title);
  document.setSubject(`Journal article, https://doi.org/${uploadDoi}`);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([400, 400]);
  page.drawText(bodyText, { x: 30, y: 330, size: 12, font });
  const bytes = await document.save({ useObjectStreams: false });
  return { bytes, sha256: hash(bytes) };
}

test("the same DOI can keep multiple verified PDF versions in parallel", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: fixture.root,
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import"] },
    ],
  });
  t.after(async () => center.close());

  const uploadDoi = "10.0000/dentalbook.multi.1";
  const first = await buildPdfWithDoi(uploadDoi, "Parallel version A", "First parallel PDF version");
  const second = await buildPdfWithDoi(uploadDoi, "Parallel version B", "Second parallel PDF version");
  assert.notEqual(first.sha256, second.sha256);

  const firstUpload = await uploadPdf(center.baseUrl, tokenB, first.bytes, uploadDoi, "Parallel version A");
  assert.equal(firstUpload.status, 200);
  const secondUpload = await uploadPdf(center.baseUrl, tokenB, second.bytes, uploadDoi, "Parallel version B");
  assert.equal(secondUpload.status, 200);
  const secondBody = await secondUpload.json() as { alreadyPresent?: boolean; data: { pdfs?: Array<{ sha256: string }> } };
  assert.equal(secondBody.alreadyPresent, false);

  const paper = await jsonRequest(center.baseUrl, "/v1/papers/get", tokenA, { identifier: uploadDoi });
  const paperBody = await paper.json() as { pdfProof: { status: string; fileSha256?: string }; pdfs?: Array<{ sha256: string; byteSize: number }> };
  assert.equal(paper.status, 200);
  assert.equal(paperBody.pdfProof.status, "central_cached");
  assert.equal(paperBody.pdfProof.fileSha256, undefined);
  assert.equal(paperBody.pdfs?.length, 2);
  assert.deepEqual(new Set(paperBody.pdfs?.map((pdf) => pdf.sha256)), new Set([first.sha256, second.sha256]));

  const firstDownload = await jsonRequest(center.baseUrl, "/v1/papers/download", tokenA, { paperId: `doi:${uploadDoi}`, sha256: first.sha256 });
  assert.equal(firstDownload.status, 200);
  assert.equal(hash(new Uint8Array(await firstDownload.arrayBuffer())), first.sha256);

  const secondDownload = await jsonRequest(center.baseUrl, "/v1/papers/download", tokenA, { paperId: `doi:${uploadDoi}`, sha256: second.sha256 });
  assert.equal(secondDownload.status, 200);
  assert.equal(hash(new Uint8Array(await secondDownload.arrayBuffer())), second.sha256);

  const ambiguous = await jsonRequest(center.baseUrl, "/v1/papers/download", tokenA, { paperId: `doi:${uploadDoi}` });
  assert.equal(ambiguous.status, 400);

  const duplicate = await uploadPdf(center.baseUrl, tokenB, first.bytes, uploadDoi, "Parallel version A");
  const duplicateBody = await duplicate.json() as { alreadyPresent: boolean };
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.alreadyPresent, true);

  const database = new DatabaseSync(resolve(fixture.root, "db/shared.sqlite3"), { readOnly: true });
  t.after(() => database.close());
  assert.equal((database.prepare("SELECT count(*) AS count FROM pdf_objects").get() as { count: number }).count, 2);
  assert.equal((database.prepare("SELECT count(*) AS count FROM paper_pdf WHERE paper_id = ?").get(`doi:${uploadDoi}`) as { count: number }).count, 2);
});

test("the same SHA cannot be linked to two different DOIs", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: fixture.root,
    port: 0,
    allowInsecureLoopback: true,
    users: [{ userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import"] }],
  });
  t.after(async () => center.close());

  const firstDoi = "10.0000/dentalbook.identity.a";
  const secondDoi = "10.0000/dentalbook.identity.b";
  const document = await PDFDocument.create();
  document.setTitle("Identity conflict paper");
  document.setSubject(`Journal article, https://doi.org/${firstDoi} alternate https://doi.org/${secondDoi}`);
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([400, 400]);
  page.drawText(`Primary DOI ${firstDoi} and alternate DOI ${secondDoi}`, { x: 30, y: 330, size: 12, font });
  const bytes = await document.save({ useObjectStreams: false });
  const pdfSha = hash(bytes);

  const firstUpload = await uploadPdf(center.baseUrl, tokenB, bytes, firstDoi, "Identity conflict paper");
  assert.equal(firstUpload.status, 200);

  const conflict = await uploadPdf(center.baseUrl, tokenB, bytes, secondDoi, "Identity conflict paper");
  assert.equal(conflict.status, 409);
  const conflictBody = await conflict.json() as { errorCode: string };
  assert.equal(conflictBody.errorCode, "conflict");

  const database = new DatabaseSync(resolve(fixture.root, "db/shared.sqlite3"), { readOnly: true });
  t.after(() => database.close());
  assert.equal((database.prepare("SELECT count(*) AS count FROM paper_pdf WHERE sha256 = ?").get(pdfSha) as { count: number }).count, 1);
});

test("admin fetch appends a fixture PDF without replacing an existing user upload", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: fixture.root,
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read", "fulltext:import"] },
    ],
  });
  t.after(async () => center.close());

  const userPdf = await buildPdfWithDoi(doi, "User scan before admin fetch", "User uploaded scan with same DOI");
  assert.notEqual(userPdf.sha256, fixture.sha256);
  const userUpload = await uploadPdf(center.baseUrl, tokenB, userPdf.bytes, doi, "User scan before admin fetch");
  assert.equal(userUpload.status, 200);

  const fetch = await jsonRequest(center.baseUrl, "/v1/papers/fetch-fulltext", tokenA, { identifier: paperId });
  assert.equal(fetch.status, 200);
  const fetchBody = await fetch.json() as { alreadyPresent?: boolean; data: { pdfs?: Array<{ sha256: string }> } };
  assert.equal(fetchBody.alreadyPresent, false);
  assert.equal(fetchBody.data.pdfs?.length, 2);
  assert.ok(fetchBody.data.pdfs?.some((pdf) => pdf.sha256 === userPdf.sha256));
  assert.ok(fetchBody.data.pdfs?.some((pdf) => pdf.sha256 === fixture.sha256));

  const repeatFetch = await jsonRequest(center.baseUrl, "/v1/papers/fetch-fulltext", tokenA, { identifier: paperId });
  const repeatBody = await repeatFetch.json() as { alreadyPresent: boolean; data: { pdfs?: Array<{ sha256: string }> } };
  assert.equal(repeatFetch.status, 200);
  assert.equal(repeatBody.alreadyPresent, true);
  assert.equal(repeatBody.data.pdfs?.length, 2);
});

test("enrichment fields update a verified-PDF paper without touching its title", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: fixture.root,
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch"] },
    ],
  });
  t.after(async () => center.close());

  const fetched = await jsonRequest(center.baseUrl, "/v1/papers/fetch-fulltext", tokenA, { identifier: paperId });
  assert.equal(fetched.status, 200);

  const enriched = await jsonRequest(center.baseUrl, "/v1/papers/ingest-metadata", tokenA, {
    papers: [{ doi, title: "Attempted title overwrite", abstract: "Enrichment abstract for a pdf-backed paper." }],
  });
  const enrichedBody = await enriched.json() as { data: { updated: number; skipped: number } };
  assert.equal(enriched.status, 200);
  assert.equal(enrichedBody.data.updated, 1);
  assert.equal(enrichedBody.data.skipped, 0);

  const listed = await jsonRequest(center.baseUrl, "/v1/papers/list", tokenA, { query: doi, limit: 5, offset: 0 });
  const listedBody = await listed.json() as { items: Array<{ paper: { title: string; hasAbstract?: boolean } }> };
  assert.equal(listed.status, 200);
  assert.equal(listedBody.items[0]?.paper.title, "Dentalbook deterministic fixture");
  assert.equal(listedBody.items[0]?.paper.hasAbstract, true);

  const titleOnly = await jsonRequest(center.baseUrl, "/v1/papers/ingest-metadata", tokenA, {
    papers: [{ doi, title: "Another title overwrite attempt" }],
  });
  const titleOnlyBody = await titleOnly.json() as { data: { updated: number; skipped: number } };
  assert.equal(titleOnly.status, 200);
  assert.equal(titleOnlyBody.data.updated, 0);
  assert.equal(titleOnlyBody.data.skipped, 1);

  const after = await jsonRequest(center.baseUrl, "/v1/papers/list", tokenA, { query: doi, limit: 5, offset: 0 });
  const afterBody = await after.json() as { items: Array<{ paper: { title: string; hasAbstract?: boolean } }> };
  assert.equal(afterBody.items[0]?.paper.title, "Dentalbook deterministic fixture");
  assert.equal(afterBody.items[0]?.paper.hasAbstract, true);
});

test("corpus preview token authorizes parallel admin corpus imports", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: fixture.root,
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch"] },
    ],
  });
  t.after(async () => center.close());

  const batchSha256 = "a".repeat(64);
  const manifestSha256 = "b".repeat(64);
  const preview = await jsonRequest(center.baseUrl, "/v1/papers/ingest-corpus/preview", tokenA, {
    batchSha256,
    manifestSha256,
    entryCount: 2,
  });
  assert.equal(preview.status, 200);
  const previewBody = await preview.json() as { confirmationToken: string; summary: { entryCount: number } };
  assert.ok(previewBody.confirmationToken);
  assert.equal(previewBody.summary.entryCount, 2);

  const uploadDoi = "10.0000/dentalbook.corpus.1";
  const first = await buildPdfWithDoi(uploadDoi, "Corpus import A", "First corpus PDF version");
  const second = await buildPdfWithDoi(uploadDoi, "Corpus import B", "Second corpus PDF version");
  const headers = {
    authorization: `Bearer ${tokenA}`,
    "content-type": "application/pdf",
    "x-dentalbook-doi": uploadDoi,
    "x-dentalbook-confirmation-token": previewBody.confirmationToken,
    "x-dentalbook-batch-sha256": batchSha256,
    "x-dentalbook-manifest-sha256": manifestSha256,
    "x-dentalbook-entry-count": "2",
  };

  const firstUpload = await fetch(`${center.baseUrl}/v1/papers/import`, {
    method: "POST",
    headers: {
      ...headers,
      "content-length": String(first.bytes.length),
      "x-dentalbook-title-base64": Buffer.from("Corpus import A").toString("base64url"),
    },
    body: Uint8Array.from(first.bytes).buffer,
  });
  assert.equal(firstUpload.status, 200);

  const secondUpload = await fetch(`${center.baseUrl}/v1/papers/import`, {
    method: "POST",
    headers: {
      ...headers,
      "content-length": String(second.bytes.length),
      "x-dentalbook-title-base64": Buffer.from("Corpus import B").toString("base64url"),
    },
    body: Uint8Array.from(second.bytes).buffer,
  });
  const secondBody = await secondUpload.json() as { alreadyPresent?: boolean; data: { pdfs?: Array<{ sha256: string }> } };
  assert.equal(secondUpload.status, 200);
  assert.equal(secondBody.alreadyPresent, false);
  assert.equal(secondBody.data.pdfs?.length, 2);

  const database = new DatabaseSync(resolve(fixture.root, "db/shared.sqlite3"), { readOnly: true });
  t.after(() => database.close());
  assert.equal((database.prepare("SELECT count(*) AS count FROM receipts WHERE action = 'admin.papers.ingest_corpus'").get() as { count: number }).count, 2);
});

test("serves MCP release artifacts when releasesDir is configured", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const releasesDir = resolve(fixture.root, "mcp-releases");
  await mkdir(releasesDir, { recursive: true });
  await writeFile(resolve(releasesDir, "manifest.json"), `${JSON.stringify({
    version: "0.1.0",
    sha256: "deadbeef",
    upgradeRecommended: false,
    upgradeRequired: true,
    upgradeHint: "Upgrade required for this test.",
    upgradeUrl: "https://dentalbook.example.com/docs#upgrade",
    notes: "",
  })}\n`);
  await writeFile(resolve(releasesDir, "install-mcp-user.sh"), "#!/bin/sh\necho dentalbook-install\n");
  await writeFile(resolve(releasesDir, "latest.tar.gz"), Buffer.from("fake-tarball"));
  const center = await startCenterServer({
    rootDir: fixture.root,
    releasesDir,
    port: 0,
    allowInsecureLoopback: true,
    users: [{ userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read"] }],
  });
  t.after(async () => center.close());

  const manifest = await fetch(`${center.baseUrl}/releases/mcp-user/manifest.json`);
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json() as { version: string }).version, "0.1.0");

  const install = await fetch(`${center.baseUrl}/install/mcp-user.sh`);
  assert.equal(install.status, 200);
  assert.match(await install.text(), /dentalbook-install/);

  const tarball = await fetch(`${center.baseUrl}/releases/mcp-user/latest.tar.gz`);
  assert.equal(tarball.status, 200);
  assert.equal(await tarball.text(), "fake-tarball");
});

test("loadCenterUsers accepts older files without displayName", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dentalbook-users-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = resolve(root, "users.json");
  await writeFile(path, `${JSON.stringify({
    users: [{ userId: "legacy-user", tokenSha256: hash("legacy-token-value"), scopes: ["catalog:read"] }],
  })}\n`);
  const users = await loadCenterUsers(path);
  assert.equal(users[0]?.userId, "legacy-user");
  assert.equal(users[0]?.displayName, undefined);
});

test("admin user folders aggregate requested papers and hosts", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  const center = await startCenterServer({
    rootDir: fixture.root,
    webDir: resolve(fixture.root, "web"),
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:read", "fulltext:fetch", "admin:audit"], displayName: "林管理员" },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read", "fulltext:read"] },
    ],
  });
  t.after(async () => center.close());

  const usersPage = await fetch(`${center.baseUrl}/users`);
  assert.equal(usersPage.status, 200);

  const listedWithoutPaper = await jsonRequest(center.baseUrl, "/v1/papers/list", tokenB, { query: "orthognathic surgery" });
  assert.equal(listedWithoutPaper.status, 200);

  const got = await jsonRequest(center.baseUrl, "/v1/papers/get", tokenB, { identifier: paperId });
  assert.equal(got.status, 200);

  const doctorDenied = await jsonRequest(center.baseUrl, "/v1/admin/users/list", tokenB, {});
  assert.equal(doctorDenied.status, 403);

  const doctorLogin = await fetch(`${center.baseUrl}/web/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tokenB }),
  });
  const doctorCookie = doctorLogin.headers.get("set-cookie")?.split(";", 1)[0];
  if (!doctorCookie?.startsWith("dentalbook_session=")) throw new Error("The doctor web login did not return a session cookie.");
  const doctorWebUsers = await fetch(`${center.baseUrl}/web/api/v1/users`, { headers: { cookie: doctorCookie } });
  assert.equal(doctorWebUsers.status, 403);

  const emptyList = await jsonRequest(center.baseUrl, "/v1/papers/list", tokenB, { query: "" });
  assert.equal(emptyList.status, 200);

  const folderWithoutHost = await jsonRequest(center.baseUrl, "/v1/admin/users/get", tokenA, { userId: "user-b" });
  const folderWithoutHostBody = await folderWithoutHost.json() as {
    user: {
      userId: string;
      displayName?: string;
      role: string;
      agents: Array<{ host: string }>;
      papers: Array<{ paperId: string; title?: string; actions: string[] }>;
      activity: Array<{ kind: string; queries?: string[]; paperId?: string; title?: string; action?: string }>;
    };
  };
  assert.equal(folderWithoutHost.status, 200);
  assert.equal(folderWithoutHostBody.user.userId, "user-b");
  assert.equal(folderWithoutHostBody.user.displayName, undefined);
  assert.equal(folderWithoutHostBody.user.role, "user");
  assert.equal(folderWithoutHostBody.user.agents.length, 0);
  assert.equal(folderWithoutHostBody.user.papers.length, 1);
  assert.equal(folderWithoutHostBody.user.papers[0]?.paperId, paperId);
  assert.equal(folderWithoutHostBody.user.papers[0]?.title, "Dentalbook deterministic fixture");
  assert.deepEqual(folderWithoutHostBody.user.papers[0]?.actions, ["papers.get"]);
  const searches = folderWithoutHostBody.user.activity.filter((item) => item.kind === "search");
  const paperEvents = folderWithoutHostBody.user.activity.filter((item) => item.kind === "paper");
  assert.equal(searches.length, 1);
  assert.deepEqual(searches[0]?.queries, ["orthognathic surgery"]);
  assert.equal(folderWithoutHostBody.user.activity.some((item) => item.queries?.includes("*")), false);
  assert.equal(paperEvents.length, 1);
  assert.equal(paperEvents[0]?.paperId, paperId);
  assert.equal(paperEvents[0]?.action, "papers.get");

  const invalidHost = await jsonRequest(center.baseUrl, "/v1/papers/get", tokenB, { identifier: paperId }, { "x-dentalbook-host": "evil-ide" });
  assert.equal(invalidHost.status, 200);
  const hosted = await jsonRequest(center.baseUrl, "/v1/papers/get", tokenB, { identifier: paperId }, { "x-dentalbook-host": "cursor" });
  assert.equal(hosted.status, 200);

  const listed = await jsonRequest(center.baseUrl, "/v1/admin/users/list", tokenA, {});
  const listedBody = await listed.json() as { total: number; items: Array<{ userId: string; displayName?: string; role: string; lastSeenAt?: string }> };
  assert.equal(listed.status, 200);
  assert.equal(listedBody.total, 2);
  assert.equal(listedBody.items.find((item) => item.userId === "user-a")?.displayName, "林管理员");
  assert.equal(listedBody.items.find((item) => item.userId === "user-a")?.role, "admin");
  assert.equal(listedBody.items.find((item) => item.userId === "user-b")?.role, "user");
  assert.ok(listedBody.items.find((item) => item.userId === "user-b")?.lastSeenAt);

  const folder = await jsonRequest(center.baseUrl, "/v1/admin/users/get", tokenA, { userId: "user-b" });
  const folderBody = await folder.json() as { user: { agents: Array<{ host: string }>; papers: Array<{ paperId: string }> } };
  assert.equal(folder.status, 200);
  assert.deepEqual(folderBody.user.agents.map((agent) => agent.host), ["cursor"]);
  assert.equal(folderBody.user.papers.length, 1);

  const adminLogin = await fetch(`${center.baseUrl}/web/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: tokenA }),
  });
  const adminSession = await adminLogin.json() as { canViewUsers?: boolean; displayName?: string };
  assert.equal(adminLogin.status, 200);
  assert.equal(adminSession.canViewUsers, true);
  assert.equal(adminSession.displayName, "林管理员");
  const adminCookie = adminLogin.headers.get("set-cookie")?.split(";", 1)[0];
  if (!adminCookie?.startsWith("dentalbook_session=")) throw new Error("The admin web login did not return a session cookie.");
  const webUsers = await fetch(`${center.baseUrl}/web/api/v1/users`, { headers: { cookie: adminCookie } });
  const webUsersBody = await webUsers.json() as { total: number };
  assert.equal(webUsers.status, 200);
  assert.equal(webUsersBody.total, 2);
  const webFolder = await fetch(`${center.baseUrl}/web/api/v1/users/user-b`, { headers: { cookie: adminCookie } });
  const webFolderBody = await webFolder.json() as { user: { agents: Array<{ host: string }> } };
  assert.equal(webFolder.status, 200);
  assert.deepEqual(webFolderBody.user.agents.map((agent) => agent.host), ["cursor"]);
});

test("papers.search matches abstracts, preserves enrichment on title-only re-ingest, and ranks title hits first", async (t) => {
  const fixture = await createFixtureRoot();
  t.after(async () => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(resolve(fixture.root, "fixtures/authors"), { recursive: true });
  await writeFile(resolve(fixture.root, "fixtures/authors/enrich-search.jsonl"), `${JSON.stringify({
    authorId: "author:enrich-search",
    displayNameEn: "Enrich Search",
    works: [
      { doi: "10.0000/dentalbook.enrich.title", title: "zygoftstest implant survival", year: 2024, sources: ["v3"] },
      { doi: "10.0000/dentalbook.enrich.abstract", title: "Unrelated salivary adenoma paper", year: 2023, sources: ["v3"] },
      { doi: "10.0000/dentalbook.enrich.recall", title: "adenomatoidftstest reconstruction", year: 2022, sources: ["v3"] },
    ],
  })}\n`);
  const catalogPath = resolve(fixture.root, "fixtures/catalog/papers.jsonl");
  const catalog = await readFile(catalogPath, "utf8");
  await writeFile(catalogPath, `${catalog}${JSON.stringify({
    paperId: "doi:10.0000/dentalbook.enrich.title",
    doi: "10.0000/dentalbook.enrich.title",
    title: "zygoftstest implant survival",
  })}\n${JSON.stringify({
    paperId: "doi:10.0000/dentalbook.enrich.abstract",
    doi: "10.0000/dentalbook.enrich.abstract",
    title: "Unrelated salivary adenoma paper",
  })}\n${JSON.stringify({
    paperId: "doi:10.0000/dentalbook.enrich.recall",
    doi: "10.0000/dentalbook.enrich.recall",
    title: "adenomatoidftstest reconstruction",
  })}\n`);
  const center = await startCenterServer({
    rootDir: fixture.root,
    webDir: resolve(fixture.root, "web"),
    port: 0,
    allowInsecureLoopback: true,
    users: [
      { userId: "user-a", tokenSha256: hash(tokenA), scopes: ["catalog:read", "fulltext:fetch"] },
      { userId: "user-b", tokenSha256: hash(tokenB), scopes: ["catalog:read"] },
    ],
  });
  t.after(async () => center.close());

  const titleOnly = await jsonRequest(center.baseUrl, "/v1/papers/ingest-metadata", tokenA, {
    papers: [{ doi: "10.0000/dentalbook.enrich.metaonly", title: "Metadata only enrichment fixture" }],
  });
  const titleOnlyBody = await titleOnly.json() as { data: { created: number; items: Array<{ paper: { title: string }; pdfProof: { status: string } }> } };
  assert.equal(titleOnly.status, 200);
  assert.equal(titleOnlyBody.data.created, 1);
  assert.equal(titleOnlyBody.data.items[0]?.paper.title, "Metadata only enrichment fixture");
  assert.equal(titleOnlyBody.data.items[0]?.pdfProof.status, "metadata_only");

  const recall = await jsonRequest(center.baseUrl, "/v1/papers/search", tokenB, {
    author: "author:enrich-search",
    keywords: "adenomatoidftstest",
  });
  const recallBody = await recall.json() as { items?: Array<{ paper: { doi: string } }> };
  assert.equal(recall.status, 200);
  assert.deepEqual((recallBody.items ?? []).map((item) => item.paper.doi), ["10.0000/dentalbook.enrich.recall"]);

  const invalid = await jsonRequest(center.baseUrl, "/v1/papers/ingest-metadata", tokenA, {
    papers: [{ doi: "10.0000/dentalbook.enrich.abstract", title: "Unrelated salivary adenoma paper", keywords: "not-an-array" }],
  });
  const invalidBody = await invalid.json() as { errorCode?: string };
  assert.equal(invalid.status, 400);
  assert.equal(invalidBody.errorCode, "validation_failed");

  const enriched = await jsonRequest(center.baseUrl, "/v1/papers/ingest-metadata", tokenA, {
    papers: [{
      doi: "10.0000/dentalbook.enrich.abstract",
      title: "Unrelated salivary adenoma paper",
      abstract: "This review covers zygoftstest flap harvest and flapharvestftstest planning.",
      keywords: ["zygomatic flap"],
      meshTerms: ["meshzygoftstest"],
    }],
  });
  const enrichedBody = await enriched.json() as { data: { updated: number } };
  assert.equal(enriched.status, 200);
  assert.equal(enrichedBody.data.updated, 1);

  const abstractOnly = await jsonRequest(center.baseUrl, "/v1/papers/search", tokenB, {
    author: "author:enrich-search",
    keywords: "flapharvestftstest",
  });
  const abstractOnlyBody = await abstractOnly.json() as { items?: Array<{ paper: { doi: string; hasAbstract?: boolean } }> };
  assert.equal(abstractOnly.status, 200);
  assert.deepEqual((abstractOnlyBody.items ?? []).map((item) => item.paper.doi), ["10.0000/dentalbook.enrich.abstract"]);
  assert.equal(abstractOnlyBody.items?.[0]?.paper.hasAbstract, true);

  const mesh = await jsonRequest(center.baseUrl, "/v1/papers/search", tokenB, {
    author: "author:enrich-search",
    keywords: "meshzygoftstest",
  });
  const meshBody = await mesh.json() as { items?: Array<{ paper: { doi: string } }> };
  assert.equal(mesh.status, 200);
  assert.deepEqual((meshBody.items ?? []).map((item) => item.paper.doi), ["10.0000/dentalbook.enrich.abstract"]);

  const ranked = await jsonRequest(center.baseUrl, "/v1/papers/search", tokenB, {
    author: "author:enrich-search",
    keywords: "zygoftstest",
  });
  const rankedBody = await ranked.json() as { items?: Array<{ paper: { doi: string; hasAbstract?: boolean } }> };
  assert.equal(ranked.status, 200);
  assert.deepEqual((rankedBody.items ?? []).map((item) => item.paper.doi), [
    "10.0000/dentalbook.enrich.title",
    "10.0000/dentalbook.enrich.abstract",
  ]);
  assert.equal(rankedBody.items?.[0]?.paper.hasAbstract, false);
  assert.equal(rankedBody.items?.[1]?.paper.hasAbstract, true);

  const reingest = await jsonRequest(center.baseUrl, "/v1/papers/ingest-metadata", tokenA, {
    papers: [{ doi: "10.0000/dentalbook.enrich.abstract", title: "Unrelated salivary adenoma paper" }],
  });
  assert.equal(reingest.status, 200);

  const stillAbstract = await jsonRequest(center.baseUrl, "/v1/papers/search", tokenB, {
    author: "author:enrich-search",
    keywords: "flapharvestftstest",
  });
  const stillAbstractBody = await stillAbstract.json() as { items?: Array<{ paper: { doi: string; hasAbstract?: boolean } }> };
  assert.equal(stillAbstract.status, 200);
  assert.deepEqual((stillAbstractBody.items ?? []).map((item) => item.paper.doi), ["10.0000/dentalbook.enrich.abstract"]);
  assert.equal(stillAbstractBody.items?.[0]?.paper.hasAbstract, true);

  const database = new DatabaseSync(resolve(fixture.root, "db/shared.sqlite3"), { readOnly: true });
  t.after(() => database.close());
  const stored = database.prepare("SELECT abstract, keywords, mesh_terms, enriched_at, metadata_uploaded_by, metadata_channel FROM papers WHERE doi = ?")
    .get("10.0000/dentalbook.enrich.abstract") as { abstract: string; keywords: string; mesh_terms: string; enriched_at: string | null; metadata_uploaded_by: string; metadata_channel: string };
  assert.match(stored.abstract, /flapharvestftstest/u);
  assert.equal(stored.keywords, "zygomatic flap");
  assert.equal(stored.mesh_terms, "meshzygoftstest");
  assert.ok(stored.enriched_at);
  assert.equal(stored.metadata_uploaded_by, "catalog");
  assert.equal(stored.metadata_channel, "admin_fetch");
});
