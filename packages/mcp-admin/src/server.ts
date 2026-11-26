import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ADMIN_TOOL_NAMES, DENTALBOOK_VERSION, RECEIPT_ERROR_CODES, pickPaperUploads, type AuthorAdminUpsert, type AuthorDetail, type AuthorMergeDetail, type AuthorMergeListResult, type AuthorMergeStatus, type AuthorRelationPost, type AuthorRelationStatus, type CorpusIngestPreview, type DirectoryUserFolder, type DirectoryUserList, type LibraryStats, type PaperMetadataDraft, type PaperMetadataIngest, type PaperWithPdfProof, type Receipt } from "@dentalbook/domain-contracts";
import { AdminServiceError } from "./center-client.js";

export type AdminApplicationPort = {
  health(): Promise<boolean>;
  fetchFulltext(identifier: string): Promise<Receipt<PaperWithPdfProof>>;
  ingestMetadata(papers: PaperMetadataDraft[]): Promise<Receipt<PaperMetadataIngest>>;
  previewCorpusIngest(preview: CorpusIngestPreview): Promise<Receipt<{ confirmationToken: string; expiresAt: string; summary: CorpusIngestPreview }>>;
  stats(): Promise<LibraryStats>;
  upsertAuthor(patch: AuthorAdminUpsert): Promise<Receipt<AuthorDetail>>;
  listAuthorRelations(query: { authorId?: string; status?: AuthorRelationStatus }): Promise<{ items: AuthorRelationPost[]; total: number }>;
  reviewAuthorRelation(relationId: string, decision: "approved" | "rejected"): Promise<Receipt<{ relation: AuthorRelationPost; author: AuthorDetail }>>;
  listAuthorMerges(status?: AuthorMergeStatus): Promise<AuthorMergeListResult>;
  getAuthorMerge(authorId: string): Promise<AuthorMergeDetail>;
  reviewAuthorMerge(authorId: string, decision: "confirmed" | "returned"): Promise<Receipt<AuthorMergeDetail>>;
  listUsers(): Promise<DirectoryUserList>;
  getUser(userId: string): Promise<DirectoryUserFolder>;
};

const paperSchema = z.object({
  paperId: z.string(),
  doi: z.string(),
  title: z.string(),
  hasAbstract: z.boolean().optional(),
  enrichedAt: z.string().nullable().optional(),
  keywords: z.array(z.string()).optional(),
  keywordsStatus: z.enum(["hit", "empty", "none"]).optional(),
});
const paperUploadSchema = z.object({
  role: z.enum(["admin", "user"]),
  uploadedBy: z.string(),
  uploadedAt: z.string(),
  channel: z.enum(["admin_fetch", "user_import"]),
});
const pdfProofSchema = z.object({
  status: z.enum(["local", "central_cached", "metadata_only", "missing"]),
  fileSha256: z.string().optional(),
  byteSize: z.number().int().positive().optional(),
  mimeVerified: z.boolean(),
  verifiedAt: z.string().optional(),
});
const statsSchema = z.object({ sharedPapers: z.number().int().nonnegative(), sharedPdfs: z.number().int().nonnegative(), metadataOnly: z.number().int().nonnegative(), localPdfs: z.number().int().nonnegative() });
const authorRelationSchema = z.object({
  relationId: z.string(),
  authorId: z.string(),
  body: z.string().optional(),
  mentor: z.string().optional(),
  students: z.array(z.string()).optional(),
  status: z.enum(["pending", "approved", "rejected"]),
  submittedBy: z.string(),
  submittedAt: z.string(),
  reviewedBy: z.string().optional(),
  reviewedAt: z.string().optional(),
});

function failure(error: unknown) {
  const code = error instanceof AdminServiceError ? error.code : "upstream_unavailable";
  const message = error instanceof Error ? error.message : "The admin operation failed.";
  return { isError: true, structuredContent: { ok: false, errorCode: code, message }, content: [{ type: "text" as const, text: `${code}: ${message}` }] };
}

export function createDentalbookAdminServer(application?: AdminApplicationPort) {
  const server = new McpServer(
    { name: "dentalbook-admin", version: DENTALBOOK_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "system.health",
    {
      title: "Dentalbook admin health",
      description: "Check the isolated admin MCP and its Linux center connection.",
      inputSchema: {},
      outputSchema: { ok: z.literal(true), service: z.literal("dentalbook-admin"), configured: z.boolean(), centerReachable: z.boolean(), businessReady: z.boolean() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const centerReachable = application ? await application.health() : false;
      const result = { ok: true as const, service: "dentalbook-admin" as const, configured: application !== undefined, centerReachable, businessReady: application !== undefined && centerReachable };
      return { structuredContent: result, content: [{ type: "text", text: result.businessReady ? "Dentalbook admin MCP and center are ready." : "Dentalbook admin MCP is alive, but the center is not ready." }] };
    },
  );

  server.registerTool(
    "system.capabilities",
    {
      title: "Dentalbook admin capabilities",
      description: "List the isolated admin tools that are actually registered.",
      inputSchema: {},
      outputSchema: { businessToolsRegistered: z.literal(true), tools: z.array(z.string()) },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => ({ structuredContent: { businessToolsRegistered: true as const, tools: ADMIN_TOOL_NAMES }, content: [{ type: "text", text: `Registered admin tools: ${ADMIN_TOOL_NAMES.join(", ")}.` }] }),
  );

  server.registerTool(
    "admin.papers.fetch_fulltext",
    {
      title: "Fetch PDF into the shared library",
      description: "As an administrator, validate a configured Linux source PDF and publish it into the shared library.",
      inputSchema: { identifier: z.string().min(1) },
      outputSchema: { ok: z.boolean(), message: z.string(), errorCode: z.enum(RECEIPT_ERROR_CODES).optional(), receiptId: z.string().optional(), paper: paperSchema.optional(), pdfProof: pdfProofSchema.optional(), metadataUpload: paperUploadSchema.optional(), pdfUpload: paperUploadSchema.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ identifier }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.fetchFulltext(identifier);
        if (!result.ok) return failure(new AdminServiceError(result.errorCode === "not_found" || result.errorCode === "forbidden" || result.errorCode === "validation_failed" || result.errorCode === "conflict" ? result.errorCode : "upstream_unavailable", result.message));
        const structuredContent = { ok: true, message: "The PDF is verified in the shared library.", receiptId: result.receiptId, paper: result.data.paper, pdfProof: result.data.pdfProof, ...pickPaperUploads(result.data) };
        return { structuredContent, content: [{ type: "text", text: `Fetched ${result.data.paper.title} into the shared library.` }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "admin.papers.ingest_metadata",
    {
      title: "Ingest metadata-only papers",
      description: "As an administrator, add up to 50 shared catalog records with DOI and title. Optional abstract, keywords, and meshTerms enrich full-text search. Title-only drafts do not erase existing enrichment. Does not attach or invent a PDF.",
      inputSchema: {
        papers: z.array(z.object({
          doi: z.string().min(1),
          title: z.string().min(1).max(500),
          abstract: z.string().max(20_000).optional(),
          keywords: z.array(z.string().max(200)).max(80).optional(),
          meshTerms: z.array(z.string().max(200)).max(80).optional(),
        })).min(1).max(50),
      },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        receiptId: z.string().optional(),
        created: z.number().int().nonnegative().optional(),
        updated: z.number().int().nonnegative().optional(),
        skipped: z.number().int().nonnegative().optional(),
        items: z.array(z.object({ paper: paperSchema, pdfProof: pdfProofSchema, metadataUpload: paperUploadSchema.optional(), pdfUpload: paperUploadSchema.optional() })).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ papers }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.ingestMetadata(papers);
        if (!result.ok) return failure(new AdminServiceError(result.errorCode === "not_found" || result.errorCode === "forbidden" || result.errorCode === "validation_failed" || result.errorCode === "conflict" ? result.errorCode : "upstream_unavailable", result.message));
        return {
          structuredContent: {
            ok: true,
            message: `Ingested ${result.data.created} metadata-only papers.`,
            receiptId: result.receiptId,
            created: result.data.created,
            updated: result.data.updated,
            skipped: result.data.skipped,
            items: result.data.items,
          },
          content: [{ type: "text" as const, text: `Ingested ${result.data.created} metadata-only papers; ${result.data.updated} updated, ${result.data.skipped} skipped.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "admin.papers.ingest_corpus",
    {
      title: "Preview Linux corpus batch import",
      description: "Issue a confirmation token for a fixed warehouse batch (batchSha256 + manifestSha256 + entryCount). Actual PDF uploads run via scripts/linux-corpus-ingest.mjs on Linux.",
      inputSchema: {
        batchSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        entryCount: z.number().int().min(1).max(100_000),
      },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        confirmationToken: z.string().optional(),
        expiresAt: z.string().optional(),
        summary: z.object({
          batchSha256: z.string(),
          manifestSha256: z.string(),
          entryCount: z.number().int(),
        }).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ batchSha256, manifestSha256, entryCount }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.previewCorpusIngest({ batchSha256, manifestSha256, entryCount });
        if (!result.ok) return failure(new AdminServiceError(result.errorCode === "validation_failed" || result.errorCode === "forbidden" ? result.errorCode : "upstream_unavailable", result.message));
        return {
          structuredContent: {
            ok: true,
            message: "Corpus batch confirmation issued.",
            confirmationToken: result.data.confirmationToken,
            expiresAt: result.data.expiresAt,
            summary: result.data.summary,
          },
          content: [{ type: "text" as const, text: `Corpus batch confirmation issued for ${entryCount} entries.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "admin.library.stats",
    {
      title: "Admin shared library counts",
      description: "Read shared paper and PDF counts from the center.",
      inputSchema: {},
      outputSchema: { ok: z.boolean(), message: z.string(), errorCode: z.enum(RECEIPT_ERROR_CODES).optional(), stats: statsSchema.optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const stats = await application.stats();
        return { structuredContent: { ok: true, message: "Admin library counts resolved.", stats }, content: [{ type: "text", text: `${stats.sharedPdfs}/${stats.sharedPapers} shared papers have PDFs.` }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "admin.authors.upsert",
    {
      title: "Update a shared author profile",
      description: "As an administrator, update the verified English name, institution, or English alias candidates for one shared author.",
      inputSchema: {
        authorId: z.string().min(1),
        displayNameEn: z.string().min(1).max(200).optional(),
        institution: z.string().max(200).optional(),
        englishNameVariants: z.array(z.string().min(1).max(200)).max(40).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        receiptId: z.string().optional(),
        author: z.object({
          authorId: z.string(),
          name: z.string(),
          displayNameZh: z.string().optional(),
          displayNameEn: z.string().optional(),
          institution: z.string().optional(),
          identityStatus: z.enum(["imported", "reviewed"]).optional(),
          englishNameVariants: z.array(z.string()).optional(),
          paperCount: z.number().int().nonnegative(),
          papers: z.array(paperSchema),
          works: z.array(z.object({
            doi: z.string(),
            title: z.string(),
            year: z.number().int().optional(),
            byline: z.string().optional(),
            matchBasis: z.string().optional(),
          })),
          notes: z.array(z.object({
            noteId: z.string(),
            kind: z.enum(["mentorship", "abbreviation", "disambiguation"]),
            body: z.string(),
            createdBy: z.string(),
            createdAt: z.string(),
          })),
          relations: z.array(authorRelationSchema),
          openalexId: z.string().optional(),
          orcid: z.string().optional(),
        }).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ authorId, displayNameEn, institution, englishNameVariants }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.upsertAuthor({
          authorId,
          ...(displayNameEn ? { displayNameEn } : {}),
          ...(institution !== undefined ? { institution } : {}),
          ...(englishNameVariants ? { englishNameVariants } : {}),
        });
        if (!result.ok) return failure(new AdminServiceError(result.errorCode === "not_found" || result.errorCode === "forbidden" || result.errorCode === "validation_failed" || result.errorCode === "conflict" ? result.errorCode : "upstream_unavailable", result.message));
        return {
          structuredContent: { ok: true, message: "Author profile updated.", receiptId: result.receiptId, author: result.data },
          content: [{ type: "text" as const, text: `Updated ${result.data.name} in the shared author registry.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "admin.authors.list_relations",
    {
      title: "List author relation submissions",
      description: "List pending, approved, or rejected author-relation comments. Use this queue before reviewing a submission.",
      inputSchema: {
        authorId: z.string().min(1).optional(),
        status: z.enum(["pending", "approved", "rejected"]).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        items: z.array(authorRelationSchema).optional(),
        total: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ authorId, status }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.listAuthorRelations({
          ...(authorId ? { authorId } : {}),
          ...(status ? { status } : {}),
        });
        return {
          structuredContent: { ok: true, message: `Found ${result.total} author relation submissions.`, ...result },
          content: [{ type: "text" as const, text: `${result.total} author relation submissions matched.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "admin.authors.review_relation",
    {
      title: "Review an author relation submission",
      description: "Approve or reject one user-submitted author relation. Approved posts become visible to every authorized reader.",
      inputSchema: {
        relationId: z.string().min(1),
        decision: z.enum(["approved", "rejected"]),
      },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        receiptId: z.string().optional(),
        relation: authorRelationSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ relationId, decision }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.reviewAuthorRelation(relationId, decision);
        if (!result.ok) return failure(new AdminServiceError(result.errorCode === "not_found" || result.errorCode === "forbidden" || result.errorCode === "validation_failed" || result.errorCode === "conflict" ? result.errorCode : "upstream_unavailable", result.message));
        return {
          structuredContent: { ok: true, message: `Author relation ${decision}.`, receiptId: result.receiptId, relation: result.data.relation },
          content: [{ type: "text" as const, text: `${decision === "approved" ? "Approved" : "Rejected"} relation ${result.data.relation.relationId}.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  const mergeSourceSchema = z.enum(["v3", "orcid", "openalex", "crossref", "pubmed"]);
  const mergeRunSchema = z.object({
    runId: z.string(),
    authorId: z.string(),
    status: z.enum(["pending", "confirmed", "returned"]),
    createdBy: z.string(),
    createdAt: z.string(),
    reviewedBy: z.string().optional(),
    reviewedAt: z.string().optional(),
    workCount: z.number().int().nonnegative(),
    papersIngested: z.number().int().nonnegative(),
    identityPinned: z.boolean(),
    sourcesComplete: z.boolean(),
    queries: z.array(z.object({
      source: mergeSourceSchema,
      queriedAt: z.string(),
      hitCount: z.number().int().nonnegative(),
      empty: z.boolean(),
      error: z.string().optional(),
    })),
    conflicts: z.array(z.object({ kind: z.string(), body: z.string() })),
    notes: z.string().optional(),
  });
  const mergeSummarySchema = z.object({
    authorId: z.string(),
    name: z.string(),
    displayNameZh: z.string().optional(),
    displayNameEn: z.string().optional(),
    orcid: z.string().optional(),
    openalexId: z.string().optional(),
    status: z.enum(["pending", "confirmed", "returned"]),
    identityPinned: z.boolean(),
    sourcesComplete: z.boolean(),
    workCount: z.number().int().nonnegative(),
    updatedAt: z.string(),
  });

  server.registerTool(
    "admin.authors.list_merges",
    {
      title: "List author metadata merge reviews",
      description: "List authors that have a v3/ORCID/OpenAlex/Crossref/PubMed metadata merge waiting for or already through admin review. Does not fetch external APIs.",
      inputSchema: {
        status: z.enum(["pending", "confirmed", "returned"]).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        items: z.array(mergeSummarySchema).optional(),
        total: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ status }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.listAuthorMerges(status);
        return {
          structuredContent: { ok: true, message: `Found ${result.total} author merge records.`, ...result },
          content: [{ type: "text" as const, text: `${result.total} author merge records matched.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "admin.authors.get_merge",
    {
      title: "Read one author metadata merge",
      description: "Show identity pin status, per-source query history, work union, and conflicts for one author merge. Does not call OpenAlex, ORCID, Crossref, or PubMed.",
      inputSchema: { authorId: z.string().min(1) },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        author: z.object({
          authorId: z.string(),
          name: z.string(),
          paperCount: z.number().int().nonnegative(),
          papers: z.array(paperSchema),
          works: z.array(z.object({
            doi: z.string(),
            title: z.string(),
            year: z.number().int().optional(),
            byline: z.string().optional(),
            matchBasis: z.string().optional(),
            sources: z.array(mergeSourceSchema).optional(),
          })),
          notes: z.array(z.object({
            noteId: z.string(),
            kind: z.enum(["mentorship", "abbreviation", "disambiguation"]),
            body: z.string(),
            createdBy: z.string(),
            createdAt: z.string(),
          })),
          relations: z.array(authorRelationSchema),
        }).optional(),
        latest: mergeRunSchema.optional(),
        history: z.array(mergeRunSchema).optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ authorId }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.getAuthorMerge(authorId);
        return {
          structuredContent: { ok: true, message: `Merge history for ${result.author.name}.`, ...result },
          content: [{ type: "text" as const, text: `${result.author.name}: ${result.latest.status}, ${result.latest.workCount} works, sourcesComplete=${result.latest.sourcesComplete}.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "admin.authors.review_merge",
    {
      title: "Confirm or return an author metadata merge",
      description: "Confirm a completed multi-source author+works merge, or return it to pending review. Does not register authors.resolve or hydrate tools.",
      inputSchema: {
        authorId: z.string().min(1),
        decision: z.enum(["confirmed", "returned"]),
      },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        receiptId: z.string().optional(),
        latest: mergeRunSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ authorId, decision }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.reviewAuthorMerge(authorId, decision);
        if (!result.ok) return failure(new AdminServiceError(result.errorCode === "not_found" || result.errorCode === "forbidden" || result.errorCode === "validation_failed" || result.errorCode === "conflict" ? result.errorCode : "upstream_unavailable", result.message));
        return {
          structuredContent: { ok: true, message: `Author merge ${decision}.`, receiptId: result.receiptId, latest: result.data.latest },
          content: [{ type: "text" as const, text: `${decision === "confirmed" ? "Confirmed" : "Returned"} merge for ${result.data.author.name}.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  const directoryUserSchema = z.object({
    userId: z.string(),
    displayName: z.string().optional(),
    role: z.enum(["admin", "user"]),
    lastSeenAt: z.string().optional(),
  });
  const directoryFolderSchema = directoryUserSchema.extend({
    agents: z.array(z.object({ host: z.string(), lastSeenAt: z.string() })),
    papers: z.array(z.object({
      paperId: z.string(),
      doi: z.string().optional(),
      title: z.string().optional(),
      lastRequestedAt: z.string(),
      actions: z.array(z.string()),
    })),
    activity: z.array(z.union([
      z.object({
        kind: z.literal("search"),
        queries: z.array(z.string()),
        startedAt: z.string(),
        endedAt: z.string(),
        count: z.number().int().positive(),
      }),
      z.object({
        kind: z.literal("paper"),
        paperId: z.string(),
        doi: z.string().optional(),
        title: z.string().optional(),
        action: z.string(),
        at: z.string(),
        host: z.string().optional(),
      }),
    ])),
  });

  server.registerTool(
    "admin.users.list",
    {
      title: "List directory users",
      description: "List token users as admin folders, with display name, role, and last center activity.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        items: z.array(directoryUserSchema).optional(),
        total: z.number().int().nonnegative().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const result = await application.listUsers();
        return {
          structuredContent: { ok: true, message: `Found ${result.total} directory users.`, ...result },
          content: [{ type: "text" as const, text: `${result.total} directory users.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "admin.users.get",
    {
      title: "Open a directory user folder",
      description: "Show one user's agents and a time-ordered activity of search queries and paper requests. Search queries are not treated as papers.",
      inputSchema: { userId: z.string().min(1) },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        user: directoryFolderSchema.optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ userId }) => {
      if (!application) return failure(new AdminServiceError("upstream_unavailable", "The Dentalbook admin MCP is not configured."));
      try {
        const user = await application.getUser(userId);
        return {
          structuredContent: { ok: true, message: `Opened folder for ${user.displayName ?? user.userId}.`, user },
          content: [{ type: "text" as const, text: `${user.displayName ?? user.userId}: ${user.agents.length} agents, ${user.activity.length} activity items.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  return server;
}
