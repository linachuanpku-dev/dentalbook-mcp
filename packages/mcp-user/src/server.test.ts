import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { USER_TOOL_NAMES, UI_RESOURCE_URIS, type PaperWithPdfProof } from "@dentalbook/domain-contracts";
import { createDentalbookUserServer, type UserApplicationPort } from "./server.js";

async function connectedClient(application?: UserApplicationPort) {
  const server = await createDentalbookUserServer(application ? { application } : {});
  const client = new Client({ name: "dentalbook-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("registers system and implemented shared-library tools", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => { await client.close(); await server.close(); });
  const response = await client.listTools();
  assert.deepEqual(response.tools.map((tool) => tool.name).sort(), [...USER_TOOL_NAMES].sort());
  assert.equal(response.tools.some((tool) => tool.name === "authors.resolve"), false);
});

test("health distinguishes an alive unconfigured process from business readiness", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => { await client.close(); await server.close(); });
  const health = await client.callTool({ name: "system.health", arguments: {} });
  const caps = await client.callTool({ name: "system.capabilities", arguments: {} });
  assert.equal((health.structuredContent as { businessReady: boolean }).businessReady, false);
  assert.equal((caps.structuredContent as { businessToolsRegistered: boolean }).businessToolsRegistered, true);
});

test("an unconfigured business call fails instead of returning scaffold data", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "papers.get", arguments: { identifier: "paper:test" } });
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { errorCode: string }).errorCode, "upstream_unavailable");
});

test("business tools return actual paper states and receipts from the application", async (t) => {
  const paper: PaperWithPdfProof = {
    paper: { paperId: "paper:test", doi: "10.1000/test", title: "Test paper" },
    pdfProof: { status: "central_cached", fileSha256: "a".repeat(64), byteSize: 123, mimeVerified: true, verifiedAt: "2026-08-17T00:00:00.000Z" },
  };
  const application: UserApplicationPort = {
    async health() { return true; },
    async getPaper() { return paper; },
    async listPapers() { return { items: [paper], total: 1, limit: 50, offset: 0, stats: { sharedPapers: 1, sharedPdfs: 1, metadataOnly: 0, localPdfs: 0 } }; },
    async searchPapers() { return { items: [paper], total: 1, limit: 50, offset: 0, stats: { sharedPapers: 1, sharedPdfs: 1, metadataOnly: 0, localPdfs: 0 }, resolvedAuthorId: "author:test" }; },
    async stats() { return { sharedPapers: 1, sharedPdfs: 1, metadataOnly: 0, localPdfs: 0 }; },
    async listAuthors() { return { items: [{ authorId: "author:test", name: "Test Author", institution: "Test University", paperCount: 1, sourceStatuses: [] }], total: 1, limit: 50, offset: 0 }; },
    async getAuthor() { return { authorId: "author:test", name: "Test Author", institution: "Test University", paperCount: 1, sourceStatuses: [], papers: [paper.paper], works: [], notes: [], relations: [] }; },
    async submitAuthorNote() { return { ok: true, receiptId: "author_note_test", data: { authorId: "author:test", name: "Test Author", paperCount: 1, sourceStatuses: [], papers: [paper.paper], works: [], notes: [], relations: [] } }; },
    async submitAuthorRelation() { return { ok: true, receiptId: "author_relation_test", data: { relation: { relationId: "relation_test", authorId: "author:test", mentor: "Mentor", students: ["Student"], status: "pending" as const, submittedBy: "user-b", submittedAt: "2026-08-18T00:00:00.000Z" }, author: { authorId: "author:test", name: "Test Author", paperCount: 1, sourceStatuses: [], papers: [paper.paper], works: [], notes: [], relations: [] } } }; },
    async importLocal() { return { ok: true, receiptId: "import_test", data: paper }; },
    async pullPdf() { return { receiptId: "local_sync_test", data: { ...paper, pdfProof: { ...paper.pdfProof, status: "local" } } }; },
  };
  const { client, server } = await connectedClient(application);
  t.after(async () => { await client.close(); await server.close(); });
  const health = await client.callTool({ name: "system.health", arguments: {} });
  const listed = await client.callTool({ name: "papers.list", arguments: {} });
  const searched = await client.callTool({ name: "papers.search", arguments: { author: "author:test", keywords: "test" } });
  const imported = await client.callTool({ name: "papers.import_local", arguments: { path: "/allowed/test.pdf" } });
  const pulled = await client.callTool({ name: "sync.pull_pdf", arguments: { paperId: paper.paper.paperId } });
  const authors = await client.callTool({ name: "authors.list", arguments: { query: "Test" } });
  const author = await client.callTool({ name: "authors.get", arguments: { identifier: "author:test" } });
  const note = await client.callTool({ name: "authors.submit_note", arguments: { authorId: "author:test", kind: "abbreviation", body: "T.A. is the accepted abbreviation." } });
  const relation = await client.callTool({ name: "authors.submit_relation", arguments: { authorId: "author:test", mentor: "Mentor", students: ["Student"] } });
  assert.equal((health.structuredContent as { businessReady: boolean }).businessReady, true);
  assert.equal((listed.structuredContent as { total: number }).total, 1);
  assert.equal((searched.structuredContent as { resolvedAuthorId: string }).resolvedAuthorId, "author:test");
  assert.equal((imported.structuredContent as { receiptId: string }).receiptId, "import_test");
  assert.equal((pulled.structuredContent as { pdfProof: { status: string } }).pdfProof.status, "local");
  assert.equal((authors.structuredContent as { total: number }).total, 1);
  assert.equal((author.structuredContent as { author: { authorId: string } }).author.authorId, "author:test");
  assert.equal((note.structuredContent as { receiptId: string }).receiptId, "author_note_test");
  assert.equal((relation.structuredContent as { receiptId: string }).receiptId, "author_relation_test");
});

test("UI probe points to the versioned MCP App resource", async (t) => {
  const { client, server } = await connectedClient();
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "system.render_ui_probe", arguments: {} });
  assert.equal((result.structuredContent as { resourceUri: string }).resourceUri, UI_RESOURCE_URIS.probe);
  const resource = await client.readResource({ uri: UI_RESOURCE_URIS.probe });
  const content = resource.contents[0];
  assert.ok(content && "text" in content);
  assert.equal(content.mimeType, "text/html;profile=mcp-app");
  assert.match(content.text, /tools\/call/);
});

test("library renderer exposes the real list resource and download action", async (t) => {
  const paper: PaperWithPdfProof = {
    paper: { paperId: "paper:test", doi: "10.1000/test", title: "Test paper" },
    pdfProof: { status: "central_cached", fileSha256: "a".repeat(64), byteSize: 123, mimeVerified: true },
  };
  const application: UserApplicationPort = {
    async health() { return true; },
    async getPaper() { return paper; },
    async listPapers() { return { items: [paper], total: 1, limit: 50, offset: 0, stats: { sharedPapers: 1, sharedPdfs: 1, metadataOnly: 0, localPdfs: 0 } }; },
    async searchPapers() { return { items: [paper], total: 1, limit: 50, offset: 0, stats: { sharedPapers: 1, sharedPdfs: 1, metadataOnly: 0, localPdfs: 0 }, resolvedAuthorId: "author:test" }; },
    async stats() { return { sharedPapers: 1, sharedPdfs: 1, metadataOnly: 0, localPdfs: 0 }; },
    async listAuthors() { return { items: [], total: 0, limit: 50, offset: 0 }; },
    async getAuthor() { return { authorId: "author:test", name: "Test Author", paperCount: 1, sourceStatuses: [], papers: [paper.paper], works: [], notes: [], relations: [] }; },
    async submitAuthorNote() { return { ok: true, receiptId: "author_note_test", data: { authorId: "author:test", name: "Test Author", paperCount: 1, sourceStatuses: [], papers: [paper.paper], works: [], notes: [], relations: [] } }; },
    async submitAuthorRelation() { return { ok: true, receiptId: "author_relation_test", data: { relation: { relationId: "relation_test", authorId: "author:test", status: "pending" as const, submittedBy: "user-b", submittedAt: "2026-08-18T00:00:00.000Z" }, author: { authorId: "author:test", name: "Test Author", paperCount: 1, sourceStatuses: [], papers: [paper.paper], works: [], notes: [], relations: [] } } }; },
    async importLocal() { return { ok: true, receiptId: "import_test", data: paper }; },
    async pullPdf() { return { receiptId: "local_sync_test", data: paper }; },
  };
  const { client, server } = await connectedClient(application);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "ui.render_library", arguments: {} });
  assert.equal((result.structuredContent as { resourceUri: string }).resourceUri, UI_RESOURCE_URIS.library);
  assert.equal((result.structuredContent as { total: number }).total, 1);
  const resource = await client.readResource({ uri: UI_RESOURCE_URIS.library });
  const content = resource.contents[0];
  assert.ok(content && "text" in content);
  assert.match(content.text, /sync\.pull_pdf/);
  assert.match(content.text, /Dentalbook library/);
});
