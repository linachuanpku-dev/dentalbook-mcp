import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  DENTALBOOK_VERSION,
  RECEIPT_ERROR_CODES,
  USER_TOOL_NAMES,
  UI_RESOURCE_URIS,
  pickPaperUploads,
  type PaperWithPdfProof,
  type AuthorDetail,
  type AuthorListResult,
  type AuthorNoteDraft,
  type AuthorRelationDraft,
  type AuthorRelationPost,
  type LibraryStats,
  type PaperListResult,
  type PaperSearchResult,
  type Receipt,
  type SystemCapabilities,
} from "@dentalbook/domain-contracts";
import { UserApplication } from "./application.js";
import { UserServiceError } from "./center-client.js";
import { loadUserConfig } from "./config.js";
import { fetchMcpReleaseManifest, localMcpVersion, mcpUpgradeStatus } from "./mcp-release.js";

const resourceFiles = new Map<string, string>([
  [UI_RESOURCE_URIS.probe, "probe.html"],
  [UI_RESOURCE_URIS.library, "library.html"],
  [UI_RESOURCE_URIS.notebooks, "notebooks.html"],
  [UI_RESOURCE_URIS.citations, "citations.html"],
  [UI_RESOURCE_URIS.authorMap, "author-map.html"],
  [UI_RESOURCE_URIS.authorGraph, "author-graph.html"],
]);

const capabilities: SystemCapabilities = {
  protocolVersion: "shared-library-test-v1",
  businessToolsRegistered: true,
  tools: USER_TOOL_NAMES,
  mcpApps: {
    standard: "MCP Apps",
    inline: true,
    fullscreen: "optional_host_capability",
    toolsCall: true,
    businessViews: "library_v1",
  },
  modules: ["system", "notebooks", "papers", "evidence", "citations", "reviews", "authors", "sync", "ui"],
};

export type UserApplicationPort = {
  health(): Promise<boolean>;
  getPaper(identifier: string): Promise<PaperWithPdfProof>;
  listPapers(query?: string, limit?: number, offset?: number): Promise<PaperListResult>;
  searchPapers(author: string, keywords: string, limit?: number, offset?: number): Promise<PaperSearchResult>;
  stats(): Promise<LibraryStats>;
  listAuthors(query?: string, limit?: number, offset?: number): Promise<AuthorListResult>;
  getAuthor(identifier: string): Promise<AuthorDetail>;
  submitAuthorNote(draft: AuthorNoteDraft): Promise<Receipt<AuthorDetail>>;
  submitAuthorRelation(draft: AuthorRelationDraft): Promise<Receipt<{ relation: AuthorRelationPost; author: AuthorDetail }>>;
  importLocal(path: string, metadata: { doi?: string; title?: string }): Promise<Receipt<PaperWithPdfProof>>;
  pullPdf(paperId: string, sha256?: string): Promise<{ receiptId: string; data: PaperWithPdfProof }>;
};

type CreateServerOptions = {
  application?: UserApplicationPort;
  configPath?: string;
};

const pdfProofSchema = z.object({
  status: z.enum(["local", "central_cached", "metadata_only", "missing"]),
  fileSha256: z.string().optional(),
  byteSize: z.number().int().positive().optional(),
  mimeVerified: z.boolean(),
  verifiedAt: z.string().optional(),
});

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

const paperPdfVersionSchema = z.object({
  sha256: z.string(),
  byteSize: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
  mimeVerified: z.boolean(),
  verifiedAt: z.string(),
  pdfUpload: paperUploadSchema.optional(),
});

const paperResultSchema = {
  ok: z.boolean(),
  message: z.string(),
  errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
  receiptId: z.string().optional(),
  paper: paperSchema.optional(),
  pdfProof: pdfProofSchema.optional(),
  pdfs: z.array(paperPdfVersionSchema).optional(),
  metadataUpload: paperUploadSchema.optional(),
  pdfUpload: paperUploadSchema.optional(),
};

const statsSchema = z.object({
  sharedPapers: z.number().int().nonnegative(),
  sharedPdfs: z.number().int().nonnegative(),
  metadataOnly: z.number().int().nonnegative(),
  localPdfs: z.number().int().nonnegative(),
});

const paperListOutputSchema = {
  ok: z.boolean(),
  message: z.string(),
  errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
  items: z.array(z.object({
    paper: paperSchema,
    pdfProof: pdfProofSchema,
    pdfs: z.array(paperPdfVersionSchema).optional(),
    metadataUpload: paperUploadSchema.optional(),
    pdfUpload: paperUploadSchema.optional(),
  })).optional(),
  total: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
  stats: statsSchema.optional(),
};

const paperSearchOutputSchema = {
  ...paperListOutputSchema,
  resolvedAuthorId: z.string().optional(),
};

const paperWithProofSchema = z.object({
  paper: paperSchema,
  pdfProof: pdfProofSchema,
  pdfs: z.array(paperPdfVersionSchema).optional(),
  metadataUpload: paperUploadSchema.optional(),
  pdfUpload: paperUploadSchema.optional(),
});
const authorWorkSchema = z.object({
  doi: z.string(),
  title: z.string(),
  year: z.number().int().optional(),
  byline: z.string().optional(),
  matchBasis: z.string().optional(),
  sources: z.array(z.enum(["v3", "orcid", "openalex", "crossref", "pubmed"])).optional(),
  library: paperWithProofSchema.optional(),
});
const authorNoteSchema = z.object({
  noteId: z.string(),
  kind: z.enum(["mentorship", "abbreviation", "disambiguation"]),
  body: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
});
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
const authorSchema = z.object({
  authorId: z.string(),
  name: z.string(),
  displayNameZh: z.string().optional(),
  displayNameEn: z.string().optional(),
  institution: z.string().optional(),
  identityStatus: z.enum(["imported", "reviewed"]).optional(),
  englishNameVariants: z.array(z.string()).optional(),
  paperCount: z.number().int().nonnegative(),
  sourceStatuses: z.array(z.object({
    source: z.enum(["v3", "orcid", "openalex", "crossref", "pubmed"]),
    state: z.enum(["hit", "empty", "none"]),
  })).optional(),
});
const authorDetailSchema = authorSchema.extend({
  papers: z.array(paperSchema),
  works: z.array(authorWorkSchema),
  notes: z.array(authorNoteSchema),
  relations: z.array(authorRelationSchema),
  openalexId: z.string().optional(),
  orcid: z.string().optional(),
});

const authorListOutputSchema = {
  ok: z.boolean(),
  message: z.string(),
  errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
  items: z.array(authorSchema).optional(),
  total: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
  offset: z.number().int().nonnegative().optional(),
};

function uiDirectory() {
  const fromEnv = process.env.DENTALBOOK_MCP_UI_DIR ?? process.env.DENTALBOOK_UI_DIR;
  if (fromEnv) return resolve(fromEnv);
  const bundled = fileURLToPath(new URL("../mcp-ui/", import.meta.url));
  if (existsSync(resolve(bundled, "probe.html"))) return bundled;
  return fileURLToPath(new URL("../../../apps/mcp-ui/dist/", import.meta.url));
}

function registerUiResources(server: McpServer) {
  for (const [uri, fileName] of resourceFiles) {
    server.registerResource(
      `dentalbook-${fileName.replace(".html", "")}`,
      uri,
      {
        title: `Dentalbook ${fileName.replace(".html", "")}`,
        description: "Self-contained Dentalbook MCP App resource.",
        mimeType: "text/html;profile=mcp-app",
      },
      async () => {
        const html = await readFile(resolve(uiDirectory(), fileName), "utf8");
        return {
          contents: [
            {
              uri,
              mimeType: "text/html;profile=mcp-app",
              text: html,
              _meta: {
                ui: {
                  prefersBorder: true,
                  csp: { connectDomains: [], resourceDomains: [], frameDomains: [] },
                },
                "openai/widgetDescription": "Dentalbook compatibility probe and scaffold views.",
              },
            },
          ],
        };
      },
    );
  }
}

function success(message: string, value: PaperWithPdfProof, receiptId?: string) {
  const structuredContent = {
    ok: true,
    message,
    ...(receiptId ? { receiptId } : {}),
    paper: value.paper,
    pdfProof: value.pdfProof,
    ...pickPaperUploads(value),
  };
  return { structuredContent, content: [{ type: "text" as const, text: message }] };
}

function failure(error: unknown) {
  const code = error instanceof UserServiceError ? error.code : "upstream_unavailable";
  const message = error instanceof Error ? error.message : "The Dentalbook operation failed.";
  return {
    isError: true,
    structuredContent: { ok: false, errorCode: code, message },
    content: [{ type: "text" as const, text: `${code}: ${message}` }],
  };
}

export async function createDentalbookUserServer(options: CreateServerOptions = {}) {
  let application = options.application;
  const userConfig = await loadUserConfig(options.configPath);
  if (!application && userConfig) application = await UserApplication.create(userConfig);

  const server = new McpServer(
    { name: "dentalbook-user", version: DENTALBOOK_VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );

  registerUiResources(server);

  server.registerTool(
    "system.health",
    {
      title: "Dentalbook health",
      description: "Check the local MCP process and whether its configured Linux center is reachable.",
      inputSchema: {},
      outputSchema: {
        ok: z.literal(true),
        service: z.literal("dentalbook-user"),
        version: z.string(),
        configured: z.boolean(),
        centerReachable: z.boolean(),
        businessReady: z.boolean(),
        localMcpVersion: z.string(),
        latestMcpVersion: z.string().optional(),
        upgradeRecommended: z.boolean(),
        upgradeRequired: z.boolean(),
        upgradeHint: z.string().optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      const configured = application !== undefined;
      const centerReachable = application ? await application.health() : false;
      const localVersion = localMcpVersion();
      const manifest = userConfig?.apiBaseUrl ? await fetchMcpReleaseManifest(userConfig.apiBaseUrl) : undefined;
      const upgrade = mcpUpgradeStatus(localVersion, manifest);
      const result = {
        ok: true as const,
        service: "dentalbook-user" as const,
        version: DENTALBOOK_VERSION,
        configured,
        centerReachable,
        businessReady: configured && centerReachable,
        localMcpVersion: localVersion,
        latestMcpVersion: upgrade.latestMcpVersion,
        upgradeRecommended: upgrade.upgradeRecommended,
        upgradeRequired: upgrade.upgradeRequired,
        upgradeHint: upgrade.upgradeHint,
      };
      const statusText = result.businessReady
        ? upgrade.upgradeRequired
          ? "Dentalbook user MCP is ready, but a required upgrade is available."
          : upgrade.upgradeRecommended
            ? "Dentalbook user MCP is ready; an upgrade is recommended."
            : "Dentalbook user MCP and Linux center are ready."
        : "Dentalbook user MCP is alive, but the Linux center is not ready.";
      return {
        structuredContent: result,
        content: [{ type: "text", text: statusText }],
      };
    },
  );

  server.registerTool(
    "system.capabilities",
    {
      title: "Dentalbook capabilities",
      description: "List registered tools, modules, and MCP Apps support.",
      inputSchema: {},
      outputSchema: {
        protocolVersion: z.literal("shared-library-test-v1"),
        businessToolsRegistered: z.literal(true),
        tools: z.array(z.string()),
        mcpApps: z.object({
          standard: z.literal("MCP Apps"),
          inline: z.literal(true),
          fullscreen: z.literal("optional_host_capability"),
          toolsCall: z.literal(true),
          businessViews: z.literal("library_v1"),
        }),
        modules: z.array(z.string()),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => ({
      structuredContent: capabilities,
      content: [{ type: "text", text: `Registered tools: ${USER_TOOL_NAMES.join(", ")}.` }],
    }),
  );

  server.registerTool(
    "system.render_ui_probe",
    {
      title: "Render Dentalbook UI probe",
      description: "Render the Dentalbook MCP App compatibility probe. It tests inline UI, light-only styling, tools/call, and optional fullscreen only.",
      inputSchema: {},
      outputSchema: {
        kind: z.literal("dentalbook_ui_probe"),
        resourceUri: z.literal(UI_RESOURCE_URIS.probe),
        businessDataIncluded: z.literal(false),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: {
        ui: { resourceUri: UI_RESOURCE_URIS.probe },
        "openai/outputTemplate": UI_RESOURCE_URIS.probe,
        "openai/toolInvocation/invoking": "Checking Dentalbook UI…",
        "openai/toolInvocation/invoked": "Dentalbook UI probe ready",
      },
    },
    async () => {
      const result = { kind: "dentalbook_ui_probe" as const, resourceUri: UI_RESOURCE_URIS.probe, businessDataIncluded: false as const };
      return { structuredContent: result, content: [{ type: "text", text: "Dentalbook UI compatibility probe. No business data is included." }] };
    },
  );

  server.registerTool(
    "papers.get",
    {
      title: "Get paper status",
      description: "Resolve a stable paper identifier and report local, centrally cached, or metadata-only PDF status.",
      inputSchema: { identifier: z.string().min(1) },
      outputSchema: paperResultSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ identifier }) => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        return success("Paper status resolved.", await application.getPaper(identifier));
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "papers.list",
    {
      title: "List shared papers",
      description: "List the shared catalog with each paper's center and current-Mac PDF state.",
      inputSchema: {
        query: z.string().optional().default(""),
        limit: z.number().int().min(1).max(100).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      outputSchema: paperListOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, limit, offset }) => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        const result = await application.listPapers(query, limit, offset);
        const structuredContent = { ok: true, message: `Found ${result.total} shared papers.`, ...result };
        return { structuredContent, content: [{ type: "text", text: `${result.total} shared papers; ${result.stats.sharedPdfs} have downloadable PDFs and ${result.stats.localPdfs} are local on this Mac.` }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "papers.search",
    {
      title: "Search shared papers by author and keywords",
      description: "Resolve an author alias to a catalog person, then search that person's library papers with FTS5 keywords across title, abstract, keywords, MeSH, and DOI (AND/OR, slash as OR). Does not fall back to the full catalog when the author is missing. Supports title: field syntax only via keyword tokens; author is a separate identity field.",
      inputSchema: {
        author: z.string().min(1),
        keywords: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      outputSchema: paperSearchOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ author, keywords, limit, offset }) => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        const result = await application.searchPapers(author, keywords, limit, offset);
        const structuredContent = { ok: true, message: `Found ${result.total} papers for ${result.resolvedAuthorId}.`, ...result };
        return { structuredContent, content: [{ type: "text", text: `${result.total} papers for ${result.resolvedAuthorId}; ${result.stats.sharedPdfs} shared PDFs and ${result.stats.localPdfs} local on this Mac.` }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "library.stats",
    {
      title: "Shared library counts",
      description: "Count shared papers, downloadable center PDFs, metadata-only records, and PDFs local to this Mac.",
      inputSchema: {},
      outputSchema: { ok: z.boolean(), message: z.string(), errorCode: z.enum(RECEIPT_ERROR_CODES).optional(), stats: statsSchema.optional() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        const stats = await application.stats();
        const structuredContent = { ok: true, message: "Shared library counts resolved.", stats };
        return { structuredContent, content: [{ type: "text", text: `${stats.sharedPdfs}/${stats.sharedPapers} shared papers have PDFs; ${stats.localPdfs} are local on this Mac.` }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "authors.list",
    {
      title: "List authors",
      description: "Search the shared Dentalbook author index by author name, institution, or stable authorId. Returns compact structured records suitable for agents and UI clients.",
      inputSchema: {
        query: z.string().optional().default(""),
        limit: z.number().int().min(1).max(100).optional().default(50),
        offset: z.number().int().nonnegative().optional().default(0),
      },
      outputSchema: authorListOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ query, limit, offset }) => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        const result = await application.listAuthors(query, limit, offset);
        const structuredContent = { ok: true, message: `Found ${result.total} authors.`, ...result };
        return { structuredContent, content: [{ type: "text", text: `${result.total} authors matched the shared author index.` }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "authors.get",
    {
      title: "Get author",
      description: "Resolve one shared author by stable authorId or exact name. Works with a DOI are joined to the shared catalog at read time and include the same PDF/status payload as papers.get.",
      inputSchema: { identifier: z.string().min(1) },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        author: authorDetailSchema.optional(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ identifier }) => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        const author = await application.getAuthor(identifier);
        const structuredContent = { ok: true, message: "Author resolved.", author };
        return { structuredContent, content: [{ type: "text", text: `${author.name} has ${author.paperCount} linked papers in Dentalbook.` }] };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "authors.submit_note",
    {
      title: "Submit an author judgment note",
      description: "Append one human-asserted note (mentorship, abbreviation, or disambiguation) to a shared author. Does not change OpenAlex snapshot fields.",
      inputSchema: {
        authorId: z.string().min(1),
        kind: z.enum(["mentorship", "abbreviation", "disambiguation"]),
        body: z.string().min(1).max(2000),
      },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        receiptId: z.string().optional(),
        author: authorDetailSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ authorId, kind, body }) => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        const result = await application.submitAuthorNote({ authorId, kind, body });
        if (!result.ok) return failure(new UserServiceError(result.errorCode, result.message));
        return {
          structuredContent: { ok: true, message: "Author note recorded.", receiptId: result.receiptId, author: result.data },
          content: [{ type: "text" as const, text: `Recorded a ${kind} note for ${result.data.name}.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "authors.submit_relation",
    {
      title: "Submit an author relation comment",
      description: "Upload a mentorship or student comment for one shared author. The post stays pending until an administrator approves it for public display.",
      inputSchema: {
        authorId: z.string().min(1),
        body: z.string().max(2000).optional(),
        mentor: z.string().max(80).optional(),
        students: z.array(z.string().min(1).max(80)).max(20).optional(),
      },
      outputSchema: {
        ok: z.boolean(),
        message: z.string(),
        errorCode: z.enum(RECEIPT_ERROR_CODES).optional(),
        receiptId: z.string().optional(),
        relation: authorRelationSchema.optional(),
        author: authorDetailSchema.optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ authorId, body, mentor, students }) => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        const result = await application.submitAuthorRelation({
          authorId,
          ...(body ? { body } : {}),
          ...(mentor ? { mentor } : {}),
          ...(students ? { students } : {}),
        });
        if (!result.ok) return failure(new UserServiceError(result.errorCode, result.message));
        return {
          structuredContent: { ok: true, message: "Author relation submitted for review.", receiptId: result.receiptId, relation: result.data.relation, author: result.data.author },
          content: [{ type: "text" as const, text: `Submitted a pending relation for ${result.data.author.name}.` }],
        };
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "papers.import_local",
    {
      title: "Upload a local PDF",
      description: "Upload one PDF from an explicitly allowed local folder into the shared library. The center verifies its DOI, PDF structure, and SHA-256.",
      inputSchema: { path: z.string().min(1), doi: z.string().min(1).optional(), title: z.string().min(1).max(500).optional() },
      outputSchema: paperResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ path, doi, title }) => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        const metadata = { ...(doi ? { doi } : {}), ...(title ? { title } : {}) };
        const result = await application.importLocal(path, metadata);
        if (!result.ok) return failure(new UserServiceError(result.errorCode, result.message));
        return success("The local PDF is verified and shared with all authorized users.", result.data, result.receiptId);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "sync.pull_pdf",
    {
      title: "Pull verified PDF",
      description: "Download a center-verified PDF into this Mac user's isolated local store and verify its SHA-256. When multiple versions exist, pass sha256.",
      inputSchema: { paperId: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional() },
      outputSchema: paperResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ paperId, sha256 }) => {
      if (!application) return failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured."));
      try {
        const result = await application.pullPdf(paperId, sha256);
        return success("The verified PDF is now local on this Mac.", result.data, result.receiptId);
      } catch (error) {
        return failure(error);
      }
    },
  );

  server.registerTool(
    "ui.render_library",
    {
      title: "Show current literature list UI",
      description: "Show or open the current Dentalbook literature list UI / shared library UI. Use this when the user asks to display the current literature list, shared literature library, 文献列表界面, or 共享文献库 and wants the real MCP-rendered page with counts, paper rows, and download states.",
      inputSchema: { query: z.string().optional().default("") },
      outputSchema: {
        kind: z.literal("dentalbook_library"),
        resourceUri: z.literal(UI_RESOURCE_URIS.library),
        ...paperListOutputSchema,
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: {
        ui: { resourceUri: UI_RESOURCE_URIS.library },
        "openai/outputTemplate": UI_RESOURCE_URIS.library,
        "openai/toolInvocation/invoking": "Loading shared literature…",
        "openai/toolInvocation/invoked": "Shared literature ready",
      },
    },
    async ({ query }) => {
      if (!application) return { ...failure(new UserServiceError("upstream_unavailable", "The Dentalbook user MCP is not configured.")), structuredContent: { kind: "dentalbook_library", resourceUri: UI_RESOURCE_URIS.library, ok: false, errorCode: "upstream_unavailable", message: "The Dentalbook user MCP is not configured." } };
      try {
        const result = await application.listPapers(query, 50, 0);
        const structuredContent = { kind: "dentalbook_library" as const, resourceUri: UI_RESOURCE_URIS.library, ok: true, message: `Loaded ${result.total} shared papers.`, ...result };
        return { structuredContent, content: [{ type: "text", text: `${result.total} shared papers; ${result.stats.sharedPdfs} PDFs are downloadable.` }] };
      } catch (error) {
        const failed = failure(error);
        return { ...failed, structuredContent: { kind: "dentalbook_library" as const, resourceUri: UI_RESOURCE_URIS.library, ...failed.structuredContent } };
      }
    },
  );

  return server;
}
