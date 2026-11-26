import assert from "node:assert/strict";
import test from "node:test";
import { USER_TOOL_NAMES, type PaperWithPdfProof } from "@dentalbook/domain-contracts";
import { startUserMcpHttp } from "./http.js";
import type { UserApplicationPort } from "./server.js";

const token = "center-test-user-a-token";
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

async function started() {
  return startUserMcpHttp({ application, bearerToken: token, host: "127.0.0.1", port: 0 });
}

test("the generic Streamable HTTP MCP requires a Bearer token and stays on loopback", async (t) => {
  const http = await started();
  t.after(() => http.close());
  assert.equal(http.host, "127.0.0.1");
  const health = await fetch(`${http.baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { service: string }).service, "dentalbook-user");
  const denied = await fetch(`${http.baseUrl}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 401);
  const wrong = await fetch(`${http.baseUrl}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer not-the-user-token", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(wrong.status, 401);
});

test("the generic /mcp interface exposes the same registered user tools", async (t) => {
  const http = await started();
  t.after(() => http.close());
  const initialize = await fetch(`${http.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "http-test", version: "0.1.0" } },
    }),
  });
  assert.equal(initialize.status, 200);
  const session = initialize.headers.get("mcp-session-id");
  assert.ok(session);
  await initialize.arrayBuffer();
  await fetch(`${http.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": session,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  const listed = await fetch(`${http.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-session-id": session,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  assert.equal(listed.status, 200);
  const payload = await listed.json() as { result?: { tools?: Array<{ name: string }> } };
  assert.deepEqual((payload.result?.tools ?? []).map((tool) => tool.name).sort(), [...USER_TOOL_NAMES].sort());
});
