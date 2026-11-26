import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ADMIN_TOOL_NAMES, type PaperWithPdfProof } from "@dentalbook/domain-contracts";
import { createDentalbookAdminServer, type AdminApplicationPort } from "./server.js";

async function connected(application?: AdminApplicationPort) {
  const server = createDentalbookAdminServer(application);
  const client = new Client({ name: "admin-test", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

test("registers only the isolated implemented admin surface", async (t) => {
  const { server, client } = await connected();
  t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [...ADMIN_TOOL_NAMES].sort());
  assert.equal(tools.tools.some((tool) => tool.name === "papers.import_local"), false);
  assert.equal(tools.tools.some((tool) => tool.name === "authors.resolve"), false);
});

test("admin fetch returns a real center receipt", async (t) => {
  const paper: PaperWithPdfProof = {
    paper: { paperId: "test:doi:10.1/admin", doi: "10.1/admin", title: "Admin fixture" },
    pdfProof: { status: "central_cached", fileSha256: "b".repeat(64), byteSize: 456, mimeVerified: true },
  };
  const application: AdminApplicationPort = {
    async health() { return true; },
    async fetchFulltext() { return { ok: true, receiptId: "ingest_admin", data: paper }; },
    async ingestMetadata() {
      return {
        ok: true,
        receiptId: "metadata_admin",
        data: { created: 1, updated: 0, skipped: 0, items: [{ paper: paper.paper, pdfProof: { status: "metadata_only", mimeVerified: false } }] },
      };
    },
    async previewCorpusIngest() {
      return {
        ok: true,
        receiptId: "corpus_preview_test",
        data: {
          confirmationToken: "token-test",
          expiresAt: "2026-08-19T00:00:00.000Z",
          summary: { batchSha256: "a".repeat(64), manifestSha256: "b".repeat(64), entryCount: 10000 },
        },
      };
    },
    async stats() { return { sharedPapers: 2, sharedPdfs: 1, metadataOnly: 1, localPdfs: 0 }; },
    async upsertAuthor() {
      return {
        ok: true,
        receiptId: "author_admin_test",
        data: { authorId: "author:test", name: "Test Author", paperCount: 0, sourceStatuses: [], papers: [], works: [], notes: [], relations: [] },
      };
    },
    async listAuthorRelations() {
      return { items: [{ relationId: "relation_test", authorId: "author:test", mentor: "Mentor", status: "pending" as const, submittedBy: "user-b", submittedAt: "2026-08-18T00:00:00.000Z" }], total: 1 };
    },
    async reviewAuthorRelation() {
      return {
        ok: true,
        receiptId: "author_review_test",
        data: {
          relation: { relationId: "relation_test", authorId: "author:test", mentor: "Mentor", status: "approved" as const, submittedBy: "user-b", submittedAt: "2026-08-18T00:00:00.000Z", reviewedBy: "user-a", reviewedAt: "2026-08-18T00:01:00.000Z" },
          author: { authorId: "author:test", name: "Test Author", paperCount: 0, sourceStatuses: [], papers: [], works: [], notes: [], relations: [] },
        },
      };
    },
    async listAuthorMerges() {
      return {
        items: [{
          authorId: "author:test",
          name: "Test Author",
          status: "pending" as const,
          identityPinned: true,
          sourcesComplete: true,
          workCount: 2,
          updatedAt: "2026-08-18T00:00:00.000Z",
        }],
        total: 1,
      };
    },
    async getAuthorMerge() {
      return {
        author: { authorId: "author:test", name: "Test Author", paperCount: 2, sourceStatuses: [], papers: [], works: [], notes: [], relations: [] },
        latest: {
          runId: "merge_test",
          authorId: "author:test",
          status: "pending" as const,
          createdBy: "user-a",
          createdAt: "2026-08-18T00:00:00.000Z",
          workCount: 2,
          papersIngested: 1,
          identityPinned: true,
          sourcesComplete: true,
          queries: [{ source: "v3" as const, queriedAt: "2026-08-18T00:00:00.000Z", hitCount: 2, empty: false }],
          conflicts: [],
        },
        history: [],
      };
    },
    async reviewAuthorMerge() {
      return {
        ok: true,
        receiptId: "author_merge_review_test",
        data: {
          author: { authorId: "author:test", name: "Test Author", paperCount: 2, sourceStatuses: [], papers: [], works: [], notes: [], relations: [] },
          latest: {
            runId: "merge_test",
            authorId: "author:test",
            status: "confirmed" as const,
            createdBy: "user-a",
            createdAt: "2026-08-18T00:00:00.000Z",
            reviewedBy: "user-a",
            reviewedAt: "2026-08-18T00:01:00.000Z",
            workCount: 2,
            papersIngested: 1,
            identityPinned: true,
            sourcesComplete: true,
            queries: [{ source: "v3" as const, queriedAt: "2026-08-18T00:00:00.000Z", hitCount: 2, empty: false }],
            conflicts: [],
          },
          history: [],
        },
      };
    },
    async listUsers() {
      return { items: [{ userId: "user-b", displayName: "林医生", role: "user" as const, lastSeenAt: "2026-08-18T00:00:00.000Z" }], total: 1 };
    },
    async getUser() {
      return {
        userId: "user-b",
        displayName: "林医生",
        role: "user" as const,
        lastSeenAt: "2026-08-18T00:00:00.000Z",
        agents: [{ host: "cursor" as const, lastSeenAt: "2026-08-18T00:00:00.000Z" }],
        papers: [{ paperId: paper.paper.paperId, doi: paper.paper.doi, title: paper.paper.title, lastRequestedAt: "2026-08-18T00:00:00.000Z", actions: ["papers.get"] }],
        activity: [
          { kind: "search" as const, queries: ["orthognathic surgery"], startedAt: "2026-08-18T00:00:00.000Z", endedAt: "2026-08-18T00:00:00.000Z", count: 1 },
          { kind: "paper" as const, paperId: paper.paper.paperId, doi: paper.paper.doi, title: paper.paper.title, action: "papers.get", at: "2026-08-18T00:00:10.000Z" },
        ],
      };
    },
  };
  const { server, client } = await connected(application);
  t.after(async () => { await client.close(); await server.close(); });
  const result = await client.callTool({ name: "admin.papers.fetch_fulltext", arguments: { identifier: paper.paper.paperId } });
  assert.equal((result.structuredContent as { receiptId: string }).receiptId, "ingest_admin");
  const metadata = await client.callTool({
    name: "admin.papers.ingest_metadata",
    arguments: { papers: [{ doi: "10.0000/dentalbook.meta.1", title: "Metadata-only fixture" }] },
  });
  assert.equal((metadata.structuredContent as { receiptId: string }).receiptId, "metadata_admin");
  assert.equal((metadata.structuredContent as { created: number }).created, 1);
  const corpus = await client.callTool({
    name: "admin.papers.ingest_corpus",
    arguments: { batchSha256: "a".repeat(64), manifestSha256: "b".repeat(64), entryCount: 10000 },
  });
  assert.equal((corpus.structuredContent as { confirmationToken: string }).confirmationToken, "token-test");
  const upsert = await client.callTool({ name: "admin.authors.upsert", arguments: { authorId: "author:test", displayNameEn: "Reviewed Author" } });
  assert.equal((upsert.structuredContent as { receiptId: string }).receiptId, "author_admin_test");
  const listed = await client.callTool({ name: "admin.authors.list_relations", arguments: { status: "pending" } });
  assert.equal((listed.structuredContent as { total: number }).total, 1);
  const reviewed = await client.callTool({ name: "admin.authors.review_relation", arguments: { relationId: "relation_test", decision: "approved" } });
  assert.equal((reviewed.structuredContent as { receiptId: string }).receiptId, "author_review_test");
  const merges = await client.callTool({ name: "admin.authors.list_merges", arguments: { status: "pending" } });
  assert.equal((merges.structuredContent as { total: number }).total, 1);
  const merge = await client.callTool({ name: "admin.authors.get_merge", arguments: { authorId: "author:test" } });
  assert.equal((merge.structuredContent as { latest: { runId: string } }).latest.runId, "merge_test");
  const mergeReview = await client.callTool({ name: "admin.authors.review_merge", arguments: { authorId: "author:test", decision: "confirmed" } });
  assert.equal((mergeReview.structuredContent as { receiptId: string }).receiptId, "author_merge_review_test");
  const users = await client.callTool({ name: "admin.users.list", arguments: {} });
  assert.equal((users.structuredContent as { total: number }).total, 1);
  const folder = await client.callTool({ name: "admin.users.get", arguments: { userId: "user-b" } });
  assert.equal((folder.structuredContent as { user: { displayName?: string; agents: unknown[]; activity: unknown[] } }).user.displayName, "林医生");
  assert.equal((folder.structuredContent as { user: { agents: unknown[] } }).user.agents.length, 1);
  assert.equal((folder.structuredContent as { user: { activity: Array<{ kind: string }> } }).user.activity[0]?.kind, "search");
});
