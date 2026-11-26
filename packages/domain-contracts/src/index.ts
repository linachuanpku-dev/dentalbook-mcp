export const DENTALBOOK_VERSION = "0.1.0";

export type Receipt<T = Record<string, never>> =
  | { ok: true; receiptId: string; data: T }
  | {
      ok: false;
      errorCode:
        | "not_implemented"
        | "not_found"
        | "confirmation_required"
        | "conflict"
        | "forbidden"
        | "validation_failed"
        | "upstream_unavailable";
      message: string;
      confirmationToken?: string;
    };

export type PdfProof = {
  status: "local" | "central_cached" | "metadata_only" | "missing";
  fileSha256?: string;
  byteSize?: number;
  mimeVerified: boolean;
  verifiedAt?: string;
};

export type PaperKeywordStatus = "hit" | "empty" | "none";

export type PaperSummary = {
  paperId: string;
  doi: string;
  title: string;
  hasAbstract?: boolean;
  enrichedAt?: string | null;
  keywords?: string[];
  keywordsStatus?: PaperKeywordStatus;
};

export type PaperUploadChannel = "admin_fetch" | "user_import";

export type PaperUpload = {
  role: "admin" | "user";
  uploadedBy: string;
  uploadedAt: string;
  channel: PaperUploadChannel;
};

export type PaperPdfVersion = {
  sha256: string;
  byteSize: number;
  pageCount: number;
  mimeVerified: boolean;
  verifiedAt: string;
  pdfUpload?: PaperUpload;
};

export type PaperWithPdfProof = {
  paper: PaperSummary;
  pdfProof: PdfProof;
  pdfs?: PaperPdfVersion[];
  metadataUpload?: PaperUpload;
  pdfUpload?: PaperUpload;
};

export function pickPaperUploads(value: Pick<PaperWithPdfProof, "metadataUpload" | "pdfUpload" | "pdfs">): Pick<PaperWithPdfProof, "metadataUpload" | "pdfUpload" | "pdfs"> {
  return {
    ...(value.metadataUpload ? { metadataUpload: value.metadataUpload } : {}),
    ...(value.pdfUpload ? { pdfUpload: value.pdfUpload } : {}),
    ...(value.pdfs?.length ? { pdfs: value.pdfs } : {}),
  };
}

export type LibraryStats = {
  sharedPapers: number;
  sharedPdfs: number;
  metadataOnly: number;
  localPdfs: number;
};

export type PaperMetadataDraft = {
  doi: string;
  title: string;
  abstract?: string;
  keywords?: string[];
  meshTerms?: string[];
};

export type PaperMetadataIngest = {
  created: number;
  updated: number;
  skipped: number;
  items: PaperWithPdfProof[];
};

export type CorpusIngestPreview = {
  batchSha256: string;
  manifestSha256: string;
  entryCount: number;
};

export type CorpusIngestReceipt = PaperWithPdfProof & {
  alreadyPresent?: boolean;
};

export type PaperListResult = {
  items: PaperWithPdfProof[];
  total: number;
  limit: number;
  offset: number;
  stats: LibraryStats;
};

export type PaperSearchResult = PaperListResult & {
  resolvedAuthorId: string;
};

export type AuthorIdentityStatus = "imported" | "reviewed";

export const AUTHOR_MERGE_SOURCES = ["v3", "orcid", "openalex", "crossref", "pubmed"] as const;
export type AuthorMergeSource = (typeof AUTHOR_MERGE_SOURCES)[number];
export type AuthorSourceState = "hit" | "empty" | "none";
export type AuthorSourceStatus = {
  source: AuthorMergeSource;
  state: AuthorSourceState;
};
export const AUTHOR_SOURCE_EVENT_KINDS = ["roster", "works", "merge_query"] as const;
export type AuthorSourceEventKind = (typeof AUTHOR_SOURCE_EVENT_KINDS)[number];
export type AuthorImportEvent = {
  eventId: string;
  source: AuthorMergeSource;
  kind: AuthorSourceEventKind;
  occurredAt: string;
  hitCount: number;
  empty: boolean;
  notes?: string;
};

export type AuthorMergeStatus = "pending" | "confirmed" | "returned";

export type AuthorWork = {
  doi: string;
  title: string;
  year?: number;
  byline?: string;
  matchBasis?: string;
  sources?: AuthorMergeSource[];
  library?: PaperWithPdfProof;
};

export type AuthorNote = {
  noteId: string;
  kind: "mentorship" | "abbreviation" | "disambiguation";
  body: string;
  createdBy: string;
  createdAt: string;
};

export type AuthorSummary = {
  authorId: string;
  name: string;
  displayNameZh?: string;
  displayNameEn?: string;
  institution?: string;
  identityStatus?: AuthorIdentityStatus;
  englishNameVariants?: string[];
  countryCode?: string;
  universityCode?: string;
  hospitalCode?: string;
  disciplineCode?: string;
  authorIdAliases?: string[];
  paperCount: number;
  sourceStatuses: AuthorSourceStatus[];
  importEvents?: AuthorImportEvent[];
};

export type AuthorRelationStatus = "pending" | "approved" | "rejected";

export type AuthorRelationPost = {
  relationId: string;
  authorId: string;
  body?: string;
  mentor?: string;
  students?: string[];
  status: AuthorRelationStatus;
  submittedBy: string;
  submittedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
};

export type AuthorRelationDraft = {
  authorId: string;
  body?: string;
  mentor?: string;
  students?: string[];
};

export type AuthorDetail = AuthorSummary & {
  papers: PaperSummary[];
  works: AuthorWork[];
  notes: AuthorNote[];
  relations: AuthorRelationPost[];
  openalexId?: string;
  orcid?: string;
};

export type AuthorAdminUpsert = {
  authorId: string;
  displayNameEn?: string;
  institution?: string;
  englishNameVariants?: string[];
};

export type AuthorNoteDraft = {
  authorId: string;
  kind: AuthorNote["kind"];
  body: string;
};

export type AuthorListResult = {
  items: AuthorSummary[];
  total: number;
  limit: number;
  offset: number;
};

export type AuthorMergeSourceQuery = {
  source: AuthorMergeSource;
  queriedAt: string;
  hitCount: number;
  empty: boolean;
  error?: string;
};

export type AuthorMergeConflict = {
  kind: string;
  body: string;
};

export type AuthorMergeRun = {
  runId: string;
  authorId: string;
  status: AuthorMergeStatus;
  createdBy: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  workCount: number;
  papersIngested: number;
  identityPinned: boolean;
  sourcesComplete: boolean;
  queries: AuthorMergeSourceQuery[];
  conflicts: AuthorMergeConflict[];
  notes?: string;
};

export type AuthorMergeSummary = {
  authorId: string;
  name: string;
  displayNameZh?: string;
  displayNameEn?: string;
  orcid?: string;
  openalexId?: string;
  status: AuthorMergeStatus;
  identityPinned: boolean;
  sourcesComplete: boolean;
  workCount: number;
  updatedAt: string;
};

export type AuthorMergeListResult = {
  items: AuthorMergeSummary[];
  total: number;
};

export type AuthorMergeDetail = {
  author: AuthorDetail;
  latest: AuthorMergeRun;
  history: AuthorMergeRun[];
};

export type AuthorWorksIngest = {
  authorId: string;
  works: Array<{
    doi?: string;
    title: string;
    year?: number;
    byline?: string;
    matchBasis?: string;
    sources?: AuthorMergeSource[];
  }>;
  occurredAt?: string;
  notes?: string;
};

export type AuthorMergeIngest = {
  authorId: string;
  displayNameZh?: string;
  displayNameEn?: string;
  institution?: string;
  openalexId?: string;
  orcid?: string;
  englishNameVariants?: string[];
  works: Array<{
    doi?: string;
    title: string;
    year?: number;
    byline?: string;
    matchBasis?: string;
    sources?: AuthorMergeSource[];
  }>;
  queries: AuthorMergeSourceQuery[];
  conflicts?: AuthorMergeConflict[];
  notes?: string;
};

export const AUDIT_HOSTS = ["workbuddy", "trae", "cursor", "codex", "claude", "qoder", "admin", "web"] as const;
export type AuditHost = (typeof AUDIT_HOSTS)[number];

export type DirectoryUserRole = "admin" | "user";

export type DirectoryUser = {
  userId: string;
  displayName?: string;
  role: DirectoryUserRole;
  lastSeenAt?: string;
};

export type DirectoryUserList = {
  items: DirectoryUser[];
  total: number;
};

export type DirectoryAgent = {
  host: AuditHost;
  lastSeenAt: string;
};

export type DirectoryPaper = {
  paperId: string;
  doi?: string;
  title?: string;
  lastRequestedAt: string;
  actions: string[];
};

export type DirectorySearchActivity = {
  kind: "search";
  queries: string[];
  startedAt: string;
  endedAt: string;
  count: number;
};

export type DirectoryPaperActivity = {
  kind: "paper";
  paperId: string;
  doi?: string;
  title?: string;
  action: string;
  at: string;
  host?: AuditHost;
};

export type DirectoryActivity = DirectorySearchActivity | DirectoryPaperActivity;

export type DirectoryUserFolder = DirectoryUser & {
  agents: DirectoryAgent[];
  papers: DirectoryPaper[];
  activity: DirectoryActivity[];
};

export type QuoteProof = {
  status: "exact" | "page_only" | "ocr_candidate" | "not_found";
  paperId: string;
  fileSha256: string;
  pageIndex: number;
  printedPageLabel?: string;
  exactQuote?: string;
  quoteSha256?: string;
  rects?: Array<{ x: number; y: number; width: number; height: number }>;
  textSource: "native_pdf" | "ocr" | "html";
};

export type RelationProvenance = "human_asserted" | "public_dataset" | "algorithm_inferred";

export type AuthorRelation = {
  id: string;
  sourceAuthorId: string;
  targetAuthorId: string;
  kind: "collaborator" | "mentor" | "mentee" | "team_member" | "other";
  provenance: RelationProvenance;
  confidence: number;
  sourcePaperIds: string[];
  changesetId?: string;
};

export type SystemCapabilities = {
  protocolVersion: "shared-library-test-v1";
  businessToolsRegistered: true;
  tools: readonly string[];
  mcpApps: {
    standard: "MCP Apps";
    inline: true;
    fullscreen: "optional_host_capability";
    toolsCall: true;
    businessViews: "library_v1";
  };
  modules: readonly [
    "system",
    "notebooks",
    "papers",
    "evidence",
    "citations",
    "reviews",
    "authors",
    "sync",
    "ui"
  ];
};

export const SYSTEM_TOOL_NAMES = [
  "system.health",
  "system.capabilities",
  "system.render_ui_probe",
] as const;

export const BUSINESS_TOOL_NAMES = [
  "papers.get",
  "papers.list",
  "papers.search",
  "papers.import_local",
  "library.stats",
  "authors.list",
  "authors.get",
  "authors.submit_note",
  "authors.submit_relation",
  "sync.pull_pdf",
  "ui.render_library",
] as const;

export const ADMIN_TOOL_NAMES = [
  "system.health",
  "system.capabilities",
  "admin.papers.fetch_fulltext",
  "admin.papers.ingest_metadata",
  "admin.papers.ingest_corpus",
  "admin.library.stats",
  "admin.authors.upsert",
  "admin.authors.list_relations",
  "admin.authors.review_relation",
  "admin.authors.list_merges",
  "admin.authors.get_merge",
  "admin.authors.review_merge",
  "admin.users.list",
  "admin.users.get",
] as const;

export const USER_TOOL_NAMES = [
  ...SYSTEM_TOOL_NAMES,
  ...BUSINESS_TOOL_NAMES,
] as const;

export const RECEIPT_ERROR_CODES = [
  "not_implemented",
  "not_found",
  "confirmation_required",
  "conflict",
  "forbidden",
  "validation_failed",
  "upstream_unavailable",
] as const;

export const UI_RESOURCE_URIS = {
  probe: "ui://dentalbook/system-probe/v2",
  library: "ui://dentalbook/library/v1",
  notebooks: "ui://dentalbook/notebooks/v1",
  citations: "ui://dentalbook/citations/v1",
  authorMap: "ui://dentalbook/author-map/v1",
  authorGraph: "ui://dentalbook/author-graph/v1",
} as const;
