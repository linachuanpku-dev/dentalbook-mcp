import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { startCenterServer } from "../packages/center-service/dist/server.js";
import { AdminCenterClient } from "../packages/mcp-admin/dist/center-client.js";
import { createDentalbookAdminServer } from "../packages/mcp-admin/dist/server.js";
import { UserApplication } from "../packages/mcp-user/dist/application.js";
import { createDentalbookUserServer } from "../packages/mcp-user/dist/server.js";

const doi = "10.0000/dentalbook.e2e.1";
const paperId = `test:doi:${doi}`;
const tokenA = "e2e-user-a-token";
const tokenB = "e2e-user-b-token";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createFixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "dentalbook-shared-e2e-"));
  await Promise.all([
    mkdir(resolve(root, "fixtures/source"), { recursive: true }),
    mkdir(resolve(root, "fixtures/catalog"), { recursive: true }),
    mkdir(resolve(root, "manifests"), { recursive: true }),
    mkdir(resolve(root, "objects/sha256"), { recursive: true }),
    mkdir(resolve(root, "staging"), { recursive: true }),
  ]);
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (const text of [`Dentalbook shared fixture DOI ${doi}`, "User A ingestion, user B cache hit"]) {
    const page = document.addPage([400, 400]);
    page.drawText(text, { x: 30, y: 330, size: 12, font });
  }
  const bytes = await document.save({ useObjectStreams: false });
  const sha256 = hash(bytes);
  const sourceFile = `fixtures/source/${sha256}.pdf`;
  await writeFile(resolve(root, sourceFile), bytes);
  await writeFile(resolve(root, "fixtures/catalog/papers.jsonl"), `${JSON.stringify({ paperId, doi, title: "Dentalbook shared E2E fixture" })}\n`);
  await writeFile(resolve(root, "manifests/library.jsonl"), `${JSON.stringify({
    paperId,
    doi,
    title: "Dentalbook shared E2E fixture",
    sourceFile,
    sha256,
    byteSize: bytes.length,
    pageCount: 2,
  })}\n`);
  return { root, bytes, sha256 };
}

async function connectApplication(application, name) {
  const server = await createDentalbookUserServer({ application });
  const client = new Client({ name, version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function connectAdmin(application) {
  const server = createDentalbookAdminServer(application);
  const client = new Client({ name: "mac-a-admin", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("Mac A admin fetch and Mac B upload both change the shared list visible on the other Mac", async (t) => {
  const fixture = await createFixtureRoot();
  const localA = resolve(fixture.root, "users/a");
  const localB = resolve(fixture.root, "users/b");
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

  const importRoot = resolve(fixture.root, "mac-b-imports");
  await mkdir(importRoot, { recursive: true });
  const common = { apiBaseUrl: center.baseUrl, requestTimeoutMs: 5_000, maxPdfBytes: 10_000_000, allowInsecureLoopback: true, importRoots: [importRoot] };
  const appA = await UserApplication.create({ ...common, bearerToken: tokenA, localDataDir: localA });
  const appB = await UserApplication.create({ ...common, bearerToken: tokenB, localDataDir: localB });
  t.after(() => { appA.close(); appB.close(); });
  const macA = await connectApplication(appA, "mac-a");
  const macB = await connectApplication(appB, "mac-b");
  const admin = await connectAdmin(new AdminCenterClient({ apiBaseUrl: center.baseUrl, bearerToken: tokenA, requestTimeoutMs: 5_000 }));
  t.after(async () => { await macA.client.close(); await macA.server.close(); await macB.client.close(); await macB.server.close(); await admin.client.close(); await admin.server.close(); });

  const before = await macB.client.callTool({ name: "papers.get", arguments: { identifier: doi } });
  assert.equal(before.isError, undefined);
  assert.equal(before.structuredContent.paper.paperId, paperId);
  assert.equal(before.structuredContent.pdfProof.status, "metadata_only");

  const userTools = await macB.client.listTools();
  assert.equal(userTools.tools.some((tool) => tool.name === "admin.papers.fetch_fulltext" || tool.name === "papers.fetch_fulltext"), false);

  const outsideImport = await macB.client.callTool({ name: "papers.import_local", arguments: { path: resolve(fixture.root, "fixtures/source", `${fixture.sha256}.pdf`) } });
  assert.equal(outsideImport.isError, true);
  assert.equal(outsideImport.structuredContent.errorCode, "forbidden");

  const ingested = await admin.client.callTool({ name: "admin.papers.fetch_fulltext", arguments: { identifier: doi } });
  assert.match(ingested.structuredContent.receiptId, /^ingest_/u);
  assert.equal(ingested.structuredContent.paper.paperId, paperId);
  assert.equal(ingested.structuredContent.pdfProof.status, "central_cached");
  assert.equal(ingested.structuredContent.pdfProof.fileSha256, fixture.sha256);

  const afterFetchList = await macB.client.callTool({ name: "papers.list", arguments: {} });
  assert.equal(afterFetchList.structuredContent.stats.sharedPdfs, 1);
  assert.equal(afterFetchList.structuredContent.items[0].pdfProof.status, "central_cached");

  const sharedHit = await macB.client.callTool({ name: "papers.get", arguments: { identifier: paperId } });
  assert.equal(sharedHit.structuredContent.paper.paperId, ingested.structuredContent.paper.paperId);
  assert.equal(sharedHit.structuredContent.pdfProof.status, "central_cached");
  assert.equal(sharedHit.structuredContent.pdfProof.fileSha256, ingested.structuredContent.pdfProof.fileSha256);

  const pulled = await macB.client.callTool({ name: "sync.pull_pdf", arguments: { paperId } });
  assert.match(pulled.structuredContent.receiptId, /^local_sync_/u);
  assert.equal(pulled.structuredContent.pdfProof.status, "local");
  assert.equal(pulled.structuredContent.pdfProof.fileSha256, fixture.sha256);

  const uploadDoi = "10.0000/dentalbook.e2e.upload";
  const uploadDocument = await PDFDocument.create();
  uploadDocument.setTitle("Mac B uploaded E2E paper");
  const uploadFont = await uploadDocument.embedFont(StandardFonts.Helvetica);
  const uploadPage = uploadDocument.addPage([400, 400]);
  uploadPage.drawText(`Mac B upload DOI ${uploadDoi}`, { x: 30, y: 330, size: 12, font: uploadFont });
  const uploadBytes = await uploadDocument.save({ useObjectStreams: false });
  const uploadPath = resolve(importRoot, "mac-b-upload.pdf");
  await writeFile(uploadPath, uploadBytes);
  const uploaded = await macB.client.callTool({ name: "papers.import_local", arguments: { path: uploadPath, doi: uploadDoi, title: "Mac B uploaded E2E paper" } });
  assert.match(uploaded.structuredContent.receiptId, /^import_/u);
  assert.equal(uploaded.structuredContent.pdfProof.status, "central_cached");

  const visibleOnA = await macA.client.callTool({ name: "papers.list", arguments: { query: uploadDoi } });
  assert.equal(visibleOnA.structuredContent.total, 1);
  assert.equal(visibleOnA.structuredContent.items[0].paper.paperId, `doi:${uploadDoi}`);
  assert.equal(visibleOnA.structuredContent.stats.sharedPdfs, 2);

  const localDatabase = new DatabaseSync(resolve(localB, "db/personal.sqlite3"), { readOnly: true });
  t.after(() => localDatabase.close());
  const localRow = localDatabase.prepare("SELECT sha256, byte_size FROM local_assets WHERE paper_id = ?").get(paperId);
  assert.equal(localRow.sha256, fixture.sha256);
  assert.equal(hash(await readFile(resolve(localB, "pdfs/sha256", fixture.sha256.slice(0, 2), fixture.sha256.slice(2, 4), `${fixture.sha256}.pdf`))), fixture.sha256);

  const sharedDatabase = new DatabaseSync(resolve(fixture.root, "db/shared.sqlite3"), { readOnly: true });
  t.after(() => sharedDatabase.close());
  assert.equal(sharedDatabase.prepare("SELECT count(*) AS count FROM pdf_objects").get().count, 2);
  assert.equal(sharedDatabase.prepare("SELECT count(*) AS count FROM receipts WHERE user_id = 'user-a'").get().count, 1);
  assert.equal(sharedDatabase.prepare("SELECT count(*) AS count FROM receipts WHERE user_id = 'user-b' AND action = 'papers.import_local'").get().count, 1);
  assert.equal(sharedDatabase.prepare("SELECT count(*) AS count FROM audit_events WHERE user_id = 'user-b' AND action = 'sync.pull_pdf'").get().count, 1);
});
