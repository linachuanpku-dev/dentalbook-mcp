import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuditHost, AuthorAdminUpsert, AuthorDetail, AuthorIdentityStatus, AuthorImportEvent, AuthorListResult, AuthorMergeConflict, AuthorMergeDetail, AuthorMergeIngest, AuthorMergeListResult, AuthorMergeRun, AuthorMergeSource, AuthorMergeSourceQuery, AuthorMergeStatus, AuthorMergeSummary, AuthorNote, AuthorNoteDraft, AuthorRelationDraft, AuthorRelationPost, AuthorRelationStatus, AuthorSourceEventKind, AuthorSourceStatus, AuthorSummary, AuthorWork, AuthorWorksIngest, DirectoryActivity, DirectoryPaper, DirectoryUser, DirectoryUserFolder, DirectoryUserList, LibraryStats, PaperListResult, PaperMetadataDraft, PaperMetadataIngest, PaperPdfVersion, PaperSearchResult, PaperSummary, PaperUpload, PaperUploadChannel, PaperWithPdfProof, PdfProof } from "@dentalbook/domain-contracts";
import { AUTHOR_MERGE_SOURCES } from "@dentalbook/domain-contracts";
import { authorFoldKeys, foldAuthorToken, keywordTokens, parseKeywordMatch } from "./author-folds.js";
import { CenterError } from "./errors.js";
import { assertCorpusConfirmation, ensureConfirmationSchema, issueCorpusConfirmation, type CorpusPreview } from "./confirmation.js";

type PaperSummaryRow = {
  paper_id: string;
  doi: string;
  title: string;
  abstract?: string;
  keywords?: string;
  enriched_at?: string | null;
  keywords_fetched_at?: string;
  metadata_uploaded_at?: string;
  metadata_uploaded_by?: string;
  metadata_role?: string;
  metadata_channel?: string;
};

type MetadataStamp = {
  uploadedAt: string;
  uploadedBy: string;
  role: PaperUpload["role"];
  channel: PaperUploadChannel;
};

const PAPER_QUERY_COLUMNS = "paper_id, doi, title, abstract, keywords, enriched_at, keywords_fetched_at, metadata_uploaded_at, metadata_uploaded_by, metadata_role, metadata_channel";
const PAPER_QUERY_COLUMNS_P = "p.paper_id, p.doi, p.title, p.abstract, p.keywords, p.enriched_at, p.keywords_fetched_at, p.metadata_uploaded_at, p.metadata_uploaded_by, p.metadata_role, p.metadata_channel";

type PdfLinkRow = {
  paper_id: string;
  sha256: string;
  byte_size: number;
  page_count: number;
  mime_verified: number;
  verified_at: string;
};

type UploadReceiptRow = {
  paper_id: string;
  user_id: string;
  action: string;
  sha256: string | null;
  created_at: string;
};

export type FixtureSource = {
  paperId: string;
  sourceFile: string;
  sha256: string;
  byteSize: number;
  pageCount: number;
  doi: string;
};

type CatalogFixture = {
  paperId: string;
  doi: string;
  title: string;
  authors?: Array<string | { authorId?: string; name: string; institution?: string }>;
};

type AuthorFixture = {
  authorId: string;
  displayNameZh?: string;
  displayNameEn?: string;
  institution?: string;
  openalexId?: string;
  orcid?: string;
  identityStatus?: AuthorIdentityStatus;
  englishNameVariants?: string[];
  countryCode?: string;
  universityCode?: string;
  hospitalCode?: string;
  disciplineCode?: string;
  affiliationSource?: string;
  aliases?: string[];
  works?: Array<{ doi?: string; title: string; year?: number; byline?: string; matchBasis?: string; sources?: string[] }>;
  merge?: {
    createdBy?: string;
    queries: Array<{ source: string; queriedAt?: string; hitCount: number; empty?: boolean; error?: string }>;
    conflicts?: Array<{ kind: string; body: string }>;
    notes?: string;
  };
};

type AuthorRow = {
  author_id: string;
  name: string;
  institution: string | null;
  display_name_zh: string;
  display_name_en: string;
  openalex_id: string;
  orcid: string;
  identity_status: AuthorIdentityStatus;
  country_code: string;
  university_code: string;
  hospital_code: string;
  discipline_code: string;
  affiliation_source: string;
};

type AuthorSourceEventRow = {
  event_id: string;
  author_id: string;
  source: AuthorMergeSource;
  kind: AuthorSourceEventKind;
  occurred_at: string;
  hit_count: number;
  empty: number;
  notes: string;
};

type MergedAuthorWork = {
  doi: string;
  title: string;
  year: number | null;
  byline: string;
  matchBasis: string;
  sources: AuthorMergeSource[];
};

const AUTHOR_ROW_COLUMNS = "author_id, name, institution, display_name_zh, display_name_en, openalex_id, orcid, identity_status, country_code, university_code, hospital_code, discipline_code, affiliation_source";

type RelationRow = {
  relation_id: string;
  author_id: string;
  body: string;
  mentor: string;
  students_json: string;
  status: AuthorRelationStatus;
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
};

type ManifestFixture = CatalogFixture & {
  sourceFile: string;
  sha256: string;
  byteSize: number;
  pageCount: number;
};

function parseJsonLines<T>(text: string, label: string): T[] {
  return text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch {
      throw new CenterError("validation_failed", `${label} contains invalid JSON on line ${index + 1}.`, 500);
    }
  });
}

function sanitizeTitle(value: string) {
  return value.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Keywords and MeSH are stored as '; '-joined plain text so FTS5 content columns stay 1:1 with papers. */
function joinTermList(values: string[]): string {
  return values.map((value) => value.trim()).filter(Boolean).join("; ");
}

function splitTermList(value: string | null | undefined): string[] {
  return String(value || "").split(";").map((item) => item.trim()).filter(Boolean);
}

function keywordsStatusFromRow(row: Pick<PaperSummaryRow, "keywords" | "keywords_fetched_at">): PaperSummary["keywordsStatus"] {
  if (splitTermList(row.keywords).length > 0) return "hit";
  if (optionalText(row.keywords_fetched_at)) return "empty";
  return "none";
}

function optionalDraftText(value: unknown, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new CenterError("validation_failed", `${field} must be a string.`, 400);
  const text = sanitizeTitle(value);
  if (text.length > maxLength) throw new CenterError("validation_failed", `${field} is too long.`, 400);
  return text;
}

function optionalDraftTerms(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CenterError("validation_failed", `${field} must be an array of strings.`, 400);
  }
  if (value.length > 80) throw new CenterError("validation_failed", `${field} has too many entries.`, 400);
  const terms = value.map((item) => item.trim()).filter(Boolean);
  if (terms.some((item) => item.length > 200)) throw new CenterError("validation_failed", `${field} contains an entry that is too long.`, 400);
  return joinTermList(terms);
}

function canonicalIdentifier(value: string) {
  return value.trim().toLowerCase().replace(/^doi:\s*/u, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//u, "");
}

function canonicalAuthorId(author: string | { authorId?: string; name: string }) {
  if (typeof author !== "string" && author.authorId?.trim()) return author.authorId.trim();
  const name = typeof author === "string" ? author : author.name;
  return `author:${name.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/gu, "")}`;
}

function looksChinese(value: string) {
  return /\p{Script=Han}/u.test(value);
}

function displayNameFrom(zh: string, en: string, fallback: string) {
  return zh.trim() || en.trim() || fallback.trim();
}

function optionalText(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? undefined : trimmed;
}

function parseMergeSources(value: string | string[] | undefined): AuthorMergeSource[] {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[+,]/u);
  const allowed = new Set<string>(AUTHOR_MERGE_SOURCES);
  return [...new Set(raw.map((item) => item.trim().toLowerCase()).filter((item): item is AuthorMergeSource => allowed.has(item)))];
}

function identityPinned(row: { orcid: string; openalex_id: string; display_name_en: string }) {
  return Boolean(optionalText(row.orcid) || (optionalText(row.openalex_id) && optionalText(row.display_name_en)));
}

const PAPER_REQUEST_ACTIONS = [
  "papers.get",
  "sync.pull_pdf",
  "papers.import_local",
  "web.papers.download",
  "admin.papers.fetch_fulltext",
] as const;
const SEARCH_ACTIONS = ["papers.list", "papers.search"] as const;
const ACTIVITY_EVENT_LIMIT = 200;
const SEARCH_GROUP_MS = 2 * 60 * 1000;

const ADMIN_DIRECTORY_SCOPES = new Set(["admin:audit", "authors:admin", "fulltext:fetch"]);

export type DirectoryAccount = {
  userId: string;
  displayName?: string;
  scopes: string[];
};

function directoryRole(scopes: string[]): DirectoryUser["role"] {
  return scopes.some((scope) => ADMIN_DIRECTORY_SCOPES.has(scope)) ? "admin" : "user";
}

function metadataStampFromAction(userId: string, action: string, uploadedAt: string): MetadataStamp {
  if (action === "papers.import_local") {
    return { uploadedAt, uploadedBy: userId, role: "user", channel: "user_import" };
  }
  return { uploadedAt, uploadedBy: userId, role: "admin", channel: "admin_fetch" };
}

function metadataUploadFromRow(row: PaperSummaryRow): PaperUpload | undefined {
  const uploadedAt = optionalText(row.metadata_uploaded_at);
  if (!uploadedAt) return undefined;
  const channel: PaperUploadChannel = row.metadata_channel === "user_import" ? "user_import" : "admin_fetch";
  const role: PaperUpload["role"] = row.metadata_role === "user" ? "user" : "admin";
  return {
    role,
    uploadedBy: optionalText(row.metadata_uploaded_by) || "catalog",
    uploadedAt,
    channel,
  };
}

function pdfUploadFromReceipt(row: UploadReceiptRow): PaperUpload | undefined {
  if (row.action === "admin.papers.fetch_fulltext" || row.action === "admin.papers.ingest_corpus") {
    return { role: "admin", uploadedBy: row.user_id, uploadedAt: row.created_at, channel: "admin_fetch" };
  }
  if (row.action === "papers.import_local") {
    return { role: "user", uploadedBy: row.user_id, uploadedAt: row.created_at, channel: "user_import" };
  }
  return undefined;
}

function uploadFromReceipt(row: UploadReceiptRow): { metadata?: PaperUpload; pdf?: PaperUpload } {
  if (row.action === "admin.papers.ingest_metadata") {
    return { metadata: { role: "admin", uploadedBy: row.user_id, uploadedAt: row.created_at, channel: "admin_fetch" } };
  }
  if (row.action === "admin.papers.fetch_fulltext" || row.action === "admin.papers.ingest_corpus") {
    return { pdf: { role: "admin", uploadedBy: row.user_id, uploadedAt: row.created_at, channel: "admin_fetch" } };
  }
  if (row.action === "papers.import_local") {
    const upload = { role: "user" as const, uploadedBy: row.user_id, uploadedAt: row.created_at, channel: "user_import" as const };
    return { metadata: upload, pdf: upload };
  }
  return {};
}

function proofFromVersions(pdfs: PaperPdfVersion[]): PdfProof {
  if (pdfs.length === 0) return { status: "metadata_only", mimeVerified: false };
  if (pdfs.length === 1) {
    const pdf = pdfs[0]!;
    return {
      status: "central_cached",
      fileSha256: pdf.sha256,
      byteSize: pdf.byteSize,
      mimeVerified: pdf.mimeVerified,
      verifiedAt: pdf.verifiedAt,
    };
  }
  return { status: "central_cached", mimeVerified: true };
}

export class CenterStore {
  private constructor(
    private readonly db: DatabaseSync,
    public readonly rootDir: string,
  ) {}

  static async open(rootDir: string) {
    const absoluteRoot = resolve(rootDir);
    const dbPath = resolve(absoluteRoot, "db/shared.sqlite3");
    await mkdir(dirname(dbPath), { recursive: true, mode: 0o750 });
    const db = new DatabaseSync(dbPath);
    const store = new CenterStore(db, absoluteRoot);
    store.initializeSchema();
    await store.seedFixtures();
    return store;
  }

  private initializeSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO schema_meta(key, value) VALUES ('schema_version', '5')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
      CREATE TABLE IF NOT EXISTS papers (
        paper_id TEXT PRIMARY KEY,
        doi TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        abstract TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '',
        mesh_terms TEXT NOT NULL DEFAULT '',
        enriched_at TEXT,
        keywords_fetched_at TEXT NOT NULL DEFAULT '',
        metadata_uploaded_at TEXT NOT NULL DEFAULT '',
        metadata_uploaded_by TEXT NOT NULL DEFAULT '',
        metadata_role TEXT NOT NULL DEFAULT '',
        metadata_channel TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fixture_sources (
        paper_id TEXT PRIMARY KEY REFERENCES papers(paper_id),
        source_file TEXT NOT NULL,
        expected_sha256 TEXT NOT NULL,
        expected_byte_size INTEGER NOT NULL,
        expected_page_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pdf_objects (
        sha256 TEXT PRIMARY KEY,
        byte_size INTEGER NOT NULL,
        page_count INTEGER NOT NULL,
        mime_verified INTEGER NOT NULL CHECK (mime_verified IN (0, 1)),
        verified_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_pdf (
        paper_id TEXT NOT NULL REFERENCES papers(paper_id),
        sha256 TEXT NOT NULL REFERENCES pdf_objects(sha256),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (paper_id, sha256)
      );
      CREATE INDEX IF NOT EXISTS idx_paper_pdf_paper ON paper_pdf(paper_id);
      CREATE TABLE IF NOT EXISTS authors (
        author_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        institution TEXT,
        display_name_zh TEXT NOT NULL DEFAULT '',
        display_name_en TEXT NOT NULL DEFAULT '',
        openalex_id TEXT NOT NULL DEFAULT '',
        orcid TEXT NOT NULL DEFAULT '',
        identity_status TEXT NOT NULL DEFAULT 'imported',
        country_code TEXT NOT NULL DEFAULT '',
        university_code TEXT NOT NULL DEFAULT '',
        hospital_code TEXT NOT NULL DEFAULT '',
        discipline_code TEXT NOT NULL DEFAULT '',
        affiliation_source TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS paper_authors (
        paper_id TEXT NOT NULL REFERENCES papers(paper_id) ON DELETE CASCADE,
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY (paper_id, author_id)
      );
      CREATE INDEX IF NOT EXISTS idx_paper_authors_author ON paper_authors(author_id);
      CREATE TABLE IF NOT EXISTS author_name_variants (
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (author_id, name)
      );
      CREATE TABLE IF NOT EXISTS author_works (
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        doi TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        year INTEGER,
        byline TEXT NOT NULL DEFAULT '',
        match_basis TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (author_id, doi, title)
      );
      CREATE INDEX IF NOT EXISTS idx_author_works_author ON author_works(author_id);
      CREATE TABLE IF NOT EXISTS author_notes (
        note_id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_author_notes_author ON author_notes(author_id);
      CREATE TABLE IF NOT EXISTS author_relation_posts (
        relation_id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        body TEXT NOT NULL DEFAULT '',
        mentor TEXT NOT NULL DEFAULT '',
        students_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        submitted_by TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_author_relation_posts_author ON author_relation_posts(author_id, status, submitted_at);
    `);
    this.migrateAuthorsSchema();
    this.migrateAuthorMergeSchema();
    this.migrateAuthorSourceEventsSchema();
    this.migratePaperPdfSchema();
    this.migrateSearchSchema();
    ensureConfirmationSchema(this.db);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS receipts (
        receipt_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        paper_id TEXT NOT NULL,
        sha256 TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_id TEXT,
        result TEXT NOT NULL,
        receipt_id TEXT,
        created_at TEXT NOT NULL,
        host TEXT
      );
    `);
    const auditColumns = this.db.prepare("PRAGMA table_info(audit_events)").all() as Array<{ name: string }>;
    if (!auditColumns.some((column) => column.name === "host")) {
      this.db.exec("ALTER TABLE audit_events ADD COLUMN host TEXT");
    }
    this.migratePaperMetadataStampSchema();
    this.migratePaperKeywordsFetchedSchema();
    this.db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '12') ON CONFLICT(key) DO UPDATE SET value = '12'").run();
  }

  private migrateAuthorsSchema() {
    const columns = this.db.prepare("PRAGMA table_info(authors)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const addColumn = (name: string, ddl: string) => {
      if (!names.has(name)) this.db.exec(`ALTER TABLE authors ADD COLUMN ${ddl}`);
    };
    addColumn("display_name_zh", "display_name_zh TEXT NOT NULL DEFAULT ''");
    addColumn("display_name_en", "display_name_en TEXT NOT NULL DEFAULT ''");
    addColumn("openalex_id", "openalex_id TEXT NOT NULL DEFAULT ''");
    addColumn("orcid", "orcid TEXT NOT NULL DEFAULT ''");
    addColumn("identity_status", "identity_status TEXT NOT NULL DEFAULT 'imported'");
    addColumn("country_code", "country_code TEXT NOT NULL DEFAULT ''");
    addColumn("university_code", "university_code TEXT NOT NULL DEFAULT ''");
    addColumn("hospital_code", "hospital_code TEXT NOT NULL DEFAULT ''");
    addColumn("discipline_code", "discipline_code TEXT NOT NULL DEFAULT ''");
    addColumn("affiliation_source", "affiliation_source TEXT NOT NULL DEFAULT ''");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS author_id_aliases (
        alias TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_author_id_aliases_author ON author_id_aliases(author_id);
      CREATE INDEX IF NOT EXISTS idx_authors_place ON authors(country_code, university_code, hospital_code, discipline_code);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS author_name_variants (
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (author_id, name)
      );
      CREATE TABLE IF NOT EXISTS author_works (
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        doi TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL,
        year INTEGER,
        byline TEXT NOT NULL DEFAULT '',
        match_basis TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (author_id, doi, title)
      );
      CREATE INDEX IF NOT EXISTS idx_author_works_author ON author_works(author_id);
      CREATE TABLE IF NOT EXISTS author_notes (
        note_id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_author_notes_author ON author_notes(author_id);
      CREATE TABLE IF NOT EXISTS author_relation_posts (
        relation_id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        body TEXT NOT NULL DEFAULT '',
        mentor TEXT NOT NULL DEFAULT '',
        students_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL,
        submitted_by TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_author_relation_posts_author ON author_relation_posts(author_id, status, submitted_at);
    `);
    this.db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '4') ON CONFLICT(key) DO UPDATE SET value = '4'").run();
  }

  private migrateAuthorMergeSchema() {
    const workColumns = this.db.prepare("PRAGMA table_info(author_works)").all() as Array<{ name: string }>;
    if (!workColumns.some((column) => column.name === "sources")) {
      this.db.exec("ALTER TABLE author_works ADD COLUMN sources TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS author_merge_runs (
        run_id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT,
        work_count INTEGER NOT NULL DEFAULT 0,
        papers_ingested INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_author_merge_runs_author ON author_merge_runs(author_id, created_at);
      CREATE TABLE IF NOT EXISTS author_merge_source_queries (
        run_id TEXT NOT NULL REFERENCES author_merge_runs(run_id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        queried_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL,
        empty INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (run_id, source)
      );
      CREATE TABLE IF NOT EXISTS author_merge_conflicts (
        conflict_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES author_merge_runs(run_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        body TEXT NOT NULL
      );
    `);
  }

  private migrateAuthorSourceEventsSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS author_source_events (
        event_id TEXT PRIMARY KEY,
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        empty INTEGER NOT NULL DEFAULT 0,
        notes TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_author_source_events_author ON author_source_events(author_id, occurred_at DESC);
    `);
    const existingRoster = this.db.prepare("SELECT author_id FROM author_source_events WHERE source = 'v3' AND kind = 'roster'").all() as Array<{ author_id: string }>;
    const rostered = new Set(existingRoster.map((row) => row.author_id));
    const authors = this.db.prepare("SELECT author_id, created_at FROM authors").all() as Array<{ author_id: string; created_at: string }>;
    const rosterInsert = this.db.prepare(`
      INSERT INTO author_source_events(event_id, author_id, source, kind, occurred_at, hit_count, empty, notes)
      VALUES (?, ?, 'v3', 'roster', ?, 1, 0, 'v3 roster import')
    `);
    for (const author of authors) {
      if (rostered.has(author.author_id)) continue;
      rosterInsert.run(`src_roster_${author.author_id}`, author.author_id, author.created_at);
    }
    this.db.prepare(`
      INSERT INTO author_source_events(event_id, author_id, source, kind, occurred_at, hit_count, empty, notes)
      SELECT 'src_mq_' || q.run_id || '_' || q.source, r.author_id, q.source, 'merge_query', q.queried_at, q.hit_count, q.empty, q.error
      FROM author_merge_source_queries q
      JOIN author_merge_runs r ON r.run_id = q.run_id
      WHERE NOT EXISTS (
        SELECT 1 FROM author_source_events e
        WHERE e.author_id = r.author_id AND e.source = q.source AND e.kind = 'merge_query' AND e.occurred_at = q.queried_at
      )
    `).run();
  }

  private migratePaperPdfSchema() {
    const version = this.db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (version?.value === "5") return;
    const columns = this.db.prepare("PRAGMA table_info(paper_pdf)").all() as Array<{ name: string; pk: number }>;
    const paperIdPk = columns.find((column) => column.name === "paper_id")?.pk === 1;
    const shaPk = columns.some((column) => column.name === "sha256" && column.pk === 1);
    if (paperIdPk && !shaPk && columns.length > 0) {
      this.db.exec(`
        CREATE TABLE paper_pdf_v5 (
          paper_id TEXT NOT NULL REFERENCES papers(paper_id),
          sha256 TEXT NOT NULL REFERENCES pdf_objects(sha256),
          updated_at TEXT NOT NULL,
          PRIMARY KEY (paper_id, sha256)
        );
        INSERT INTO paper_pdf_v5(paper_id, sha256, updated_at) SELECT paper_id, sha256, updated_at FROM paper_pdf;
        DROP TABLE paper_pdf;
        ALTER TABLE paper_pdf_v5 RENAME TO paper_pdf;
        CREATE INDEX IF NOT EXISTS idx_paper_pdf_paper ON paper_pdf(paper_id);
      `);
    }
    this.db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '5') ON CONFLICT(key) DO UPDATE SET value = '5'").run();
  }

  private migratePaperEnrichmentSchema() {
    const columns = this.db.prepare("PRAGMA table_info(papers)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const addColumn = (name: string, ddl: string) => {
      if (!names.has(name)) this.db.exec(`ALTER TABLE papers ADD COLUMN ${ddl}`);
    };
    addColumn("abstract", "abstract TEXT NOT NULL DEFAULT ''");
    addColumn("keywords", "keywords TEXT NOT NULL DEFAULT ''");
    addColumn("mesh_terms", "mesh_terms TEXT NOT NULL DEFAULT ''");
    addColumn("enriched_at", "enriched_at TEXT");
  }

  private migrateSearchSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS author_name_folds (
        fold TEXT NOT NULL,
        author_id TEXT NOT NULL REFERENCES authors(author_id) ON DELETE CASCADE,
        PRIMARY KEY (fold, author_id)
      );
      CREATE INDEX IF NOT EXISTS idx_author_name_folds_author ON author_name_folds(author_id);
    `);
    this.migratePaperEnrichmentSchema();
    const fts = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'papers_fts'").get() as { sql: string } | undefined;
    const currentSql = fts?.sql ?? "";
    const currentShape = currentSql.includes("abstract") && currentSql.includes("keywords") && currentSql.includes("mesh_terms");
    if (!currentShape) {
      this.db.exec(`
        DROP TRIGGER IF EXISTS papers_fts_ai;
        DROP TRIGGER IF EXISTS papers_fts_ad;
        DROP TRIGGER IF EXISTS papers_fts_au;
        DROP TABLE IF EXISTS papers_fts;
        CREATE VIRTUAL TABLE papers_fts USING fts5(
          title,
          abstract,
          keywords,
          mesh_terms,
          doi,
          content='papers',
          content_rowid='rowid',
          tokenize='unicode61'
        );
        CREATE TRIGGER papers_fts_ai AFTER INSERT ON papers BEGIN
          INSERT INTO papers_fts(rowid, title, abstract, keywords, mesh_terms, doi)
          VALUES (new.rowid, new.title, new.abstract, new.keywords, new.mesh_terms, new.doi);
        END;
        CREATE TRIGGER papers_fts_ad AFTER DELETE ON papers BEGIN
          INSERT INTO papers_fts(papers_fts, rowid, title, abstract, keywords, mesh_terms, doi)
          VALUES ('delete', old.rowid, old.title, old.abstract, old.keywords, old.mesh_terms, old.doi);
        END;
        CREATE TRIGGER papers_fts_au AFTER UPDATE OF title, abstract, keywords, mesh_terms, doi ON papers BEGIN
          INSERT INTO papers_fts(papers_fts, rowid, title, abstract, keywords, mesh_terms, doi)
          VALUES ('delete', old.rowid, old.title, old.abstract, old.keywords, old.mesh_terms, old.doi);
          INSERT INTO papers_fts(rowid, title, abstract, keywords, mesh_terms, doi)
          VALUES (new.rowid, new.title, new.abstract, new.keywords, new.mesh_terms, new.doi);
        END;
      `);
      // Rebuild only after (re)creating the index: at catalog scale a full
      // rebuild takes minutes and must not run on every startup.
      this.db.exec("INSERT INTO papers_fts(papers_fts) VALUES ('rebuild')");
    }
  }

  private migratePaperMetadataStampSchema() {
    const columns = this.db.prepare("PRAGMA table_info(papers)").all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    const addColumn = (name: string, ddl: string) => {
      if (!names.has(name)) this.db.exec(`ALTER TABLE papers ADD COLUMN ${ddl}`);
    };
    addColumn("metadata_uploaded_at", "metadata_uploaded_at TEXT NOT NULL DEFAULT ''");
    addColumn("metadata_uploaded_by", "metadata_uploaded_by TEXT NOT NULL DEFAULT ''");
    addColumn("metadata_role", "metadata_role TEXT NOT NULL DEFAULT ''");
    addColumn("metadata_channel", "metadata_channel TEXT NOT NULL DEFAULT ''");
    const pending = this.db.prepare("SELECT count(*) AS count FROM papers WHERE metadata_uploaded_at = ''").get() as { count: number };
    if (pending.count === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const createdAtByPaper = new Map(
        (this.db.prepare("SELECT paper_id, created_at FROM papers WHERE metadata_uploaded_at = ''").all() as Array<{ paper_id: string; created_at: string }>)
          .map((row) => [row.paper_id, row.created_at]),
      );
      const receipts = this.db.prepare(`
        SELECT paper_id, user_id, action, created_at
        FROM receipts
        WHERE action IN ('admin.papers.ingest_metadata', 'papers.import_local')
        ORDER BY created_at ASC
      `).all() as UploadReceiptRow[];
      const update = this.db.prepare(`
        UPDATE papers SET
          metadata_uploaded_at = ?,
          metadata_uploaded_by = ?,
          metadata_role = ?,
          metadata_channel = ?
        WHERE paper_id = ? AND metadata_uploaded_at = ''
      `);
      for (const row of receipts) {
        if (row.action === "papers.import_local" && createdAtByPaper.get(row.paper_id) !== row.created_at) continue;
        const stamp = metadataStampFromAction(row.user_id, row.action, row.created_at);
        update.run(stamp.uploadedAt, stamp.uploadedBy, stamp.role, stamp.channel, row.paper_id);
      }
      this.db.prepare(`
        UPDATE papers SET
          metadata_uploaded_at = created_at,
          metadata_uploaded_by = 'catalog',
          metadata_role = 'admin',
          metadata_channel = 'admin_fetch'
        WHERE metadata_uploaded_at = ''
      `).run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private migratePaperKeywordsFetchedSchema() {
    const columns = this.db.prepare("PRAGMA table_info(papers)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "keywords_fetched_at")) {
      this.db.exec("ALTER TABLE papers ADD COLUMN keywords_fetched_at TEXT NOT NULL DEFAULT ''");
    }
  }

  private rebuildAuthorFolds(authorId: string) {
    const row = this.db.prepare("SELECT author_id, name, display_name_zh, display_name_en FROM authors WHERE author_id = ?").get(authorId) as {
      author_id: string;
      name: string;
      display_name_zh: string;
      display_name_en: string;
    } | undefined;
    if (!row) return;
    const variants = this.db.prepare("SELECT name FROM author_name_variants WHERE author_id = ?").all(authorId) as Array<{ name: string }>;
    const aliases = this.db.prepare("SELECT alias FROM author_id_aliases WHERE author_id = ?").all(authorId) as Array<{ alias: string }>;
    const keys = new Set<string>([row.author_id.trim().toLowerCase()]);
    for (const alias of aliases) keys.add(alias.alias.trim().toLowerCase());
    for (const surface of [row.author_id, row.name, row.display_name_zh, row.display_name_en, ...variants.map((item) => item.name), ...aliases.map((item) => item.alias)]) {
      for (const key of authorFoldKeys(surface)) keys.add(key);
    }
    this.db.prepare("DELETE FROM author_name_folds WHERE author_id = ?").run(authorId);
    const insert = this.db.prepare("INSERT INTO author_name_folds(fold, author_id) VALUES (?, ?) ON CONFLICT(fold, author_id) DO NOTHING");
    for (const key of keys) insert.run(key, authorId);
  }

  private rebuildAllAuthorFolds() {
    const rows = this.db.prepare("SELECT author_id FROM authors").all() as Array<{ author_id: string }>;
    for (const row of rows) this.rebuildAuthorFolds(row.author_id);
  }

  private resolveCanonicalAuthorId(identifier: string): string | undefined {
    const needle = identifier.trim();
    if (!needle) return undefined;
    const byId = this.db.prepare("SELECT author_id FROM authors WHERE author_id = ?").get(needle) as { author_id: string } | undefined;
    if (byId) return byId.author_id;
    const alias = this.db.prepare("SELECT author_id FROM author_id_aliases WHERE alias = ?").get(needle) as { author_id: string } | undefined;
    return alias?.author_id;
  }

  private resolveAuthorIds(author: string): string[] {
    const needle = author.trim();
    if (!needle) return [];
    const ids = new Set<string>();
    const exact = this.db.prepare(`
      SELECT author_id FROM authors
      WHERE author_id = ? OR lower(name) = lower(?) OR lower(display_name_zh) = lower(?) OR lower(display_name_en) = lower(?)
    `).all(needle, needle, needle, needle) as Array<{ author_id: string }>;
    for (const row of exact) ids.add(row.author_id);
    const aliased = this.db.prepare("SELECT author_id FROM author_id_aliases WHERE alias = ?").all(needle) as Array<{ author_id: string }>;
    for (const row of aliased) ids.add(row.author_id);
    for (const fold of authorFoldKeys(needle)) {
      const matched = this.db.prepare("SELECT author_id FROM author_name_folds WHERE fold = ?").all(fold) as Array<{ author_id: string }>;
      for (const row of matched) ids.add(row.author_id);
    }
    const compact = foldAuthorToken(needle);
    if (compact) {
      const matched = this.db.prepare("SELECT author_id FROM author_name_folds WHERE fold = ?").all(compact) as Array<{ author_id: string }>;
      for (const row of matched) ids.add(row.author_id);
    }
    return [...ids];
  }

  private async seedFixtures() {
    const catalogPath = resolve(this.rootDir, "fixtures/catalog/papers.jsonl");
    const manifestPath = resolve(this.rootDir, "manifests/library.jsonl");
    const [catalogText, manifestText] = await Promise.all([
      readFile(catalogPath, "utf8"),
      readFile(manifestPath, "utf8"),
    ]);
    const catalog = parseJsonLines<CatalogFixture>(catalogText, "fixture catalog");
    const manifest = parseJsonLines<ManifestFixture>(manifestText, "fixture manifest");
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const paperStatement = this.db.prepare(`
        INSERT INTO papers(paper_id, doi, title, created_at, updated_at, metadata_uploaded_at, metadata_uploaded_by, metadata_role, metadata_channel)
        VALUES (?, ?, ?, ?, ?, ?, 'catalog', 'admin', 'admin_fetch')
        ON CONFLICT(paper_id) DO UPDATE SET doi = excluded.doi, title = excluded.title, updated_at = excluded.updated_at
      `);
      for (const paper of catalog) {
        paperStatement.run(paper.paperId, canonicalIdentifier(paper.doi), paper.title, now, now, now);
      }
      const authorStatement = this.db.prepare(`
        INSERT INTO authors(author_id, name, institution, display_name_zh, display_name_en, identity_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'imported', ?, ?)
        ON CONFLICT(author_id) DO UPDATE SET
          name = excluded.name,
          institution = COALESCE(excluded.institution, authors.institution),
          display_name_zh = CASE WHEN authors.display_name_zh = '' THEN excluded.display_name_zh ELSE authors.display_name_zh END,
          display_name_en = CASE WHEN authors.display_name_en = '' THEN excluded.display_name_en ELSE authors.display_name_en END,
          updated_at = excluded.updated_at
      `);
      const paperAuthorStatement = this.db.prepare(`
        INSERT INTO paper_authors(paper_id, author_id, position) VALUES (?, ?, ?)
        ON CONFLICT(paper_id, author_id) DO UPDATE SET position = excluded.position
      `);
      for (const paper of catalog) {
        if (!paper.authors) continue;
        this.db.prepare("DELETE FROM paper_authors WHERE paper_id = ?").run(paper.paperId);
        paper.authors.forEach((author, position) => {
          const name = (typeof author === "string" ? author : author.name).trim();
          if (!name) return;
          const authorId = canonicalAuthorId(author);
          const institution = typeof author === "string" ? null : author.institution?.trim() || null;
          const zh = looksChinese(name) ? name : "";
          const en = looksChinese(name) ? "" : name;
          authorStatement.run(authorId, displayNameFrom(zh, en, name), institution, zh, en, now, now);
          paperAuthorStatement.run(paper.paperId, authorId, position);
        });
      }
      const fixtureStatement = this.db.prepare(`
        INSERT INTO fixture_sources(paper_id, source_file, expected_sha256, expected_byte_size, expected_page_count)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(paper_id) DO UPDATE SET
          source_file = excluded.source_file,
          expected_sha256 = excluded.expected_sha256,
          expected_byte_size = excluded.expected_byte_size,
          expected_page_count = excluded.expected_page_count
      `);
      for (const fixture of manifest) {
        fixtureStatement.run(
          fixture.paperId,
          fixture.sourceFile,
          fixture.sha256,
          fixture.byteSize,
          fixture.pageCount,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    await this.seedAuthorFixtures();
    this.rebuildAllAuthorFolds();
  }

  private async seedAuthorFixtures() {
    const authorsDir = resolve(this.rootDir, "fixtures/authors");
    const files = await readdir(authorsDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [] as string[];
      throw error;
    });
    const jsonlFiles = files.filter((file) => extname(file) === ".jsonl").sort();
    if (jsonlFiles.length === 0) return;
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const file of jsonlFiles) {
        const text = await readFile(resolve(authorsDir, file), "utf8");
        const records = parseJsonLines<AuthorFixture>(text, `author fixture ${file}`);
        for (const record of records) this.upsertAuthorFixture(record, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private upsertAuthorFixture(record: AuthorFixture, now: string) {
    const authorId = record.authorId?.trim();
    if (!authorId) throw new CenterError("validation_failed", "An author fixture is missing authorId.", 422);
    const aliases = [...new Set((record.aliases ?? []).map((value) => value.trim()).filter((value) => value && value !== authorId))];
    for (const alias of aliases) {
      const oldRow = this.db.prepare("SELECT author_id FROM authors WHERE author_id = ?").get(alias) as { author_id: string } | undefined;
      if (!oldRow || oldRow.author_id === authorId) continue;
      const dest = this.db.prepare("SELECT author_id FROM authors WHERE author_id = ?").get(authorId) as { author_id: string } | undefined;
      if (dest) {
        throw new CenterError("conflict", `Cannot map alias ${alias} onto ${authorId} because both author rows exist.`, 409);
      }
      this.relocateAuthorIdUnlocked(alias, authorId);
    }
    const zh = record.displayNameZh?.trim() ?? "";
    const en = record.displayNameEn?.trim() ?? "";
    const name = displayNameFrom(zh, en, authorId);
    const institution = record.institution?.trim() || null;
    const identityStatus = record.identityStatus === "reviewed" ? "reviewed" : "imported";
    this.db.prepare(`
      INSERT INTO authors(
        author_id, name, institution, display_name_zh, display_name_en, openalex_id, orcid, identity_status,
        country_code, university_code, hospital_code, discipline_code, affiliation_source, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(author_id) DO UPDATE SET
        name = excluded.name,
        institution = COALESCE(excluded.institution, authors.institution),
        display_name_zh = CASE WHEN excluded.display_name_zh = '' THEN authors.display_name_zh ELSE excluded.display_name_zh END,
        display_name_en = CASE WHEN authors.identity_status = 'reviewed' AND authors.display_name_en != '' THEN authors.display_name_en WHEN excluded.display_name_en = '' THEN authors.display_name_en ELSE excluded.display_name_en END,
        openalex_id = CASE WHEN excluded.openalex_id = '' THEN authors.openalex_id ELSE excluded.openalex_id END,
        orcid = CASE WHEN excluded.orcid = '' THEN authors.orcid ELSE excluded.orcid END,
        identity_status = CASE WHEN authors.identity_status = 'reviewed' THEN authors.identity_status ELSE excluded.identity_status END,
        country_code = CASE WHEN excluded.country_code = '' THEN authors.country_code ELSE excluded.country_code END,
        university_code = CASE WHEN excluded.university_code = '' THEN authors.university_code ELSE excluded.university_code END,
        hospital_code = CASE WHEN excluded.hospital_code = '' THEN authors.hospital_code ELSE excluded.hospital_code END,
        discipline_code = CASE WHEN excluded.discipline_code = '' THEN authors.discipline_code ELSE excluded.discipline_code END,
        affiliation_source = CASE WHEN excluded.affiliation_source = '' THEN authors.affiliation_source ELSE excluded.affiliation_source END,
        updated_at = excluded.updated_at
    `).run(
      authorId,
      name,
      institution,
      zh,
      en,
      record.openalexId?.trim() ?? "",
      record.orcid?.trim() ?? "",
      identityStatus,
      record.countryCode?.trim() ?? "",
      record.universityCode?.trim() ?? "",
      record.hospitalCode?.trim() ?? "",
      record.disciplineCode?.trim() ?? "",
      record.affiliationSource?.trim() ?? "",
      now,
      now,
    );
    const aliasStatement = this.db.prepare("INSERT INTO author_id_aliases(alias, author_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET author_id = excluded.author_id");
    for (const alias of aliases) aliasStatement.run(alias, authorId);
    const primaryEn = this.db.prepare("SELECT display_name_en FROM authors WHERE author_id = ?").get(authorId) as { display_name_en: string };
    const variants = [...new Set((record.englishNameVariants ?? []).map((value) => value.trim()).filter((value) => value && value !== primaryEn.display_name_en))];
    this.db.prepare("DELETE FROM author_name_variants WHERE author_id = ? AND source != 'admin'").run(authorId);
    const variantStatement = this.db.prepare("INSERT INTO author_name_variants(author_id, name, kind, source) VALUES (?, ?, 'observed_signature', 'fixture') ON CONFLICT(author_id, name) DO NOTHING");
    for (const variant of variants) variantStatement.run(authorId, variant);
    const existingRun = this.db.prepare("SELECT run_id FROM author_merge_runs WHERE author_id = ? LIMIT 1").get(authorId);
    if (Array.isArray(record.works) && !existingRun) {
      this.db.prepare("DELETE FROM author_works WHERE author_id = ?").run(authorId);
      const workStatement = this.db.prepare("INSERT INTO author_works(author_id, doi, title, year, byline, match_basis, sources, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      record.works.forEach((work, position) => {
        const title = work.title.trim();
        if (!title) return;
        workStatement.run(
          authorId,
          work.doi?.trim() ?? "",
          title,
          work.year ?? null,
          work.byline?.trim() ?? "",
          work.matchBasis?.trim() ?? "",
          parseMergeSources(work.sources ?? work.matchBasis).join("+"),
          position,
        );
      });
    }
    if (!existingRun && record.merge) {
      const workCount = Array.isArray(record.works)
        ? record.works.length
        : (this.db.prepare("SELECT count(*) AS count FROM author_works WHERE author_id = ?").get(authorId) as { count: number }).count;
      this.insertMergeRun(authorId, record.merge.createdBy?.trim() || "fixture", now, {
        queries: record.merge.queries,
        conflicts: record.merge.conflicts,
        notes: record.merge.notes,
        workCount,
        papersIngested: 0,
      });
    }
    const created = this.db.prepare("SELECT created_at FROM authors WHERE author_id = ?").get(authorId) as { created_at: string };
    this.ensureRosterSourceEvent(authorId, created.created_at);
    this.rebuildAuthorFolds(authorId);
  }

  relocateAuthorId(oldId: string, newId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.relocateAuthorIdUnlocked(oldId, newId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private relocateAuthorIdUnlocked(oldId: string, newId: string) {
    const fromId = oldId.trim();
    const toId = newId.trim();
    if (!fromId || !toId) throw new CenterError("validation_failed", "relocateAuthorId requires oldId and newId.", 400);
    if (fromId === toId) return;
    const existing = this.db.prepare(`SELECT ${AUTHOR_ROW_COLUMNS}, created_at, updated_at FROM authors WHERE author_id = ?`).get(fromId) as (AuthorRow & { created_at: string; updated_at: string }) | undefined;
    if (!existing) throw new CenterError("not_found", "No author matches the supplied identifier.", 404);
    const collision = this.db.prepare("SELECT author_id FROM authors WHERE author_id = ?").get(toId) as { author_id: string } | undefined;
    if (collision) throw new CenterError("conflict", "The target authorId already exists.", 409);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO authors(
        author_id, name, institution, display_name_zh, display_name_en, openalex_id, orcid, identity_status,
        country_code, university_code, hospital_code, discipline_code, affiliation_source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toId,
      existing.name,
      existing.institution,
      existing.display_name_zh,
      existing.display_name_en,
      existing.openalex_id,
      existing.orcid,
      existing.identity_status,
      existing.country_code,
      existing.university_code,
      existing.hospital_code,
      existing.discipline_code,
      existing.affiliation_source,
      existing.created_at,
      now,
    );
    for (const table of [
      "paper_authors",
      "author_name_variants",
      "author_works",
      "author_notes",
      "author_relation_posts",
      "author_merge_runs",
      "author_name_folds",
      "author_id_aliases",
      "author_source_events",
    ]) {
      this.db.prepare(`UPDATE ${table} SET author_id = ? WHERE author_id = ?`).run(toId, fromId);
    }
    this.db.prepare("INSERT INTO author_id_aliases(alias, author_id) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET author_id = excluded.author_id").run(fromId, toId);
    this.db.prepare("DELETE FROM authors WHERE author_id = ?").run(fromId);
    this.rebuildAuthorFolds(toId);
  }

  close() {
    this.db.close();
  }

  health() {
    const row = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    return { integrity: row.integrity_check, schemaVersion: "12" };
  }

  private paperPdfVersions(paperIds: string[]): Record<string, PaperPdfVersion[]> {
    const unique = [...new Set(paperIds.filter(Boolean))];
    if (unique.length === 0) return {};
    const rows = this.db.prepare(`
      SELECT pp.paper_id, pp.sha256, o.byte_size, o.page_count, o.mime_verified, o.verified_at
      FROM paper_pdf pp
      JOIN pdf_objects o ON o.sha256 = pp.sha256
      WHERE pp.paper_id IN (${unique.map(() => "?").join(",")})
      ORDER BY pp.updated_at ASC, pp.sha256 ASC
    `).all(...unique) as PdfLinkRow[];
    const receiptRows = this.db.prepare(`
      SELECT paper_id, user_id, action, sha256, created_at
      FROM receipts
      WHERE paper_id IN (${unique.map(() => "?").join(",")})
        AND action IN ('admin.papers.fetch_fulltext', 'papers.import_local')
        AND sha256 IS NOT NULL
      ORDER BY created_at ASC
    `).all(...unique) as UploadReceiptRow[];
    const uploadByPaperSha = new Map<string, PaperUpload>();
    for (const row of receiptRows) {
      if (!row.sha256) continue;
      const upload = pdfUploadFromReceipt(row);
      if (upload) uploadByPaperSha.set(`${row.paper_id}:${row.sha256}`, upload);
    }
    const result: Record<string, PaperPdfVersion[]> = {};
    for (const row of rows) {
      const list = result[row.paper_id] ?? [];
      const pdfUpload = uploadByPaperSha.get(`${row.paper_id}:${row.sha256}`);
      list.push({
        sha256: row.sha256,
        byteSize: row.byte_size,
        pageCount: row.page_count,
        mimeVerified: row.mime_verified === 1,
        verifiedAt: row.verified_at,
        ...(pdfUpload ? { pdfUpload } : {}),
      });
      result[row.paper_id] = list;
    }
    return result;
  }

  private stampPaperMetadataIfEmpty(paperId: string, stamp: MetadataStamp) {
    this.db.prepare(`
      UPDATE papers SET
        metadata_uploaded_at = ?,
        metadata_uploaded_by = ?,
        metadata_role = ?,
        metadata_channel = ?
      WHERE paper_id = ? AND metadata_uploaded_at = ''
    `).run(stamp.uploadedAt, stamp.uploadedBy, stamp.role, stamp.channel, paperId);
  }

  private assemblePaper(row: PaperSummaryRow, pdfs: PaperPdfVersion[], uploads?: { metadataUpload?: PaperUpload; pdfUpload?: PaperUpload }, extras?: { hasAbstract?: boolean; enrichedAt?: string | null }): PaperWithPdfProof {
    const keywordTerms = splitTermList(row.keywords);
    const keywordsStatus = keywordsStatusFromRow(row);
    const paper: PaperSummary = {
      paperId: row.paper_id,
      doi: row.doi,
      title: row.title,
      keywordsStatus,
      ...(keywordTerms.length > 0 ? { keywords: keywordTerms } : {}),
      ...(extras?.hasAbstract !== undefined ? { hasAbstract: extras.hasAbstract } : {}),
      ...(extras && Object.prototype.hasOwnProperty.call(extras, "enrichedAt") ? { enrichedAt: extras.enrichedAt ?? null } : {}),
    };
    const pdfProof = proofFromVersions(pdfs);
    const metadataUpload = metadataUploadFromRow(row) ?? uploads?.metadataUpload;
    const pdfUpload = pdfs.length === 1 ? pdfs[0]?.pdfUpload ?? uploads?.pdfUpload : uploads?.pdfUpload;
    return {
      paper,
      pdfProof,
      ...(pdfs.length > 0 ? { pdfs } : {}),
      ...(metadataUpload ? { metadataUpload } : {}),
      ...(pdfUpload ? { pdfUpload } : {}),
    };
  }

  getPaper(identifier: string): PaperWithPdfProof {
    const canonical = canonicalIdentifier(identifier);
    const row = this.db.prepare(`
      SELECT ${PAPER_QUERY_COLUMNS} FROM papers WHERE paper_id = ? OR doi = ? LIMIT 1
    `).get(identifier.trim(), canonical) as PaperSummaryRow | undefined;
    if (!row) throw new CenterError("not_found", "No paper matches the supplied identifier.", 404);
    const pdfs = this.paperPdfVersions([row.paper_id])[row.paper_id] ?? [];
    const uploads = this.paperUploadFields([row.paper_id])[row.paper_id];
    return this.assemblePaper(row, pdfs, uploads);
  }

  private papersByDois(dois: string[]): Map<string, PaperWithPdfProof> {
    const unique = [...new Set(dois.map((value) => canonicalIdentifier(value)).filter(Boolean))];
    const result = new Map<string, PaperWithPdfProof>();
    if (unique.length === 0) return result;
    const rows = this.db.prepare(`
      SELECT ${PAPER_QUERY_COLUMNS} FROM papers WHERE doi IN (${unique.map(() => "?").join(",")})
    `).all(...unique) as PaperSummaryRow[];
    const paperIds = rows.map((row) => row.paper_id);
    const pdfsByPaper = this.paperPdfVersions(paperIds);
    const uploads = this.paperUploadFields(paperIds);
    for (const row of rows) {
      result.set(canonicalIdentifier(row.doi), this.assemblePaper(row, pdfsByPaper[row.paper_id] ?? [], uploads[row.paper_id]));
    }
    return result;
  }

  listPapers(query: string, limit: number, offset: number): Omit<PaperListResult, "stats"> {
    const normalized = `%${query.trim().toLowerCase()}%`;
    const where = query.trim() === "" ? "" : "WHERE lower(p.title) LIKE ? OR lower(p.doi) LIKE ? OR lower(p.paper_id) LIKE ?";
    const params = query.trim() === "" ? [] : [normalized, normalized, normalized];
    const count = this.db.prepare(`SELECT count(*) AS count FROM papers p ${where}`).get(...params) as { count: number };
    const rows = this.db.prepare(`
      SELECT ${PAPER_QUERY_COLUMNS_P}
      FROM papers p
      ${where}
      ORDER BY p.updated_at DESC, p.paper_id ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as PaperSummaryRow[];
    const paperIds = rows.map((row) => row.paper_id);
    const pdfsByPaper = this.paperPdfVersions(paperIds);
    const uploads = this.paperUploadFields(paperIds);
    return {
      items: rows.map((row) => this.assemblePaper(row, pdfsByPaper[row.paper_id] ?? [], uploads[row.paper_id], {
        hasAbstract: Boolean(row.abstract?.trim()),
        enrichedAt: row.enriched_at ?? null,
      })),
      total: count.count,
      limit,
      offset,
    };
  }

  searchPapers(author: string, keywords: string, limit: number, offset: number): Omit<PaperSearchResult, "stats"> {
    const authorQuery = author.trim();
    const keywordQuery = keywords.trim();
    if (!authorQuery) throw new CenterError("validation_failed", "author is required.", 400);
    if (!keywordQuery) throw new CenterError("validation_failed", "keywords are required.", 400);
    const authorIds = this.resolveAuthorIds(authorQuery);
    if (authorIds.length === 0) {
      throw new CenterError("not_found", "No author matches the supplied identifier.", 404);
    }
    if (authorIds.length > 1) {
      throw new CenterError("validation_failed", `The author query matches more than one catalog person: ${authorIds.join(", ")}.`, 400);
    }
    const resolvedAuthorId = authorIds[0]!;
    const match = parseKeywordMatch(keywordQuery);
    const tokens = keywordTokens(keywordQuery);
    if (!match || tokens.length === 0) throw new CenterError("validation_failed", "keywords are required.", 400);
    const likeOp = /[/,]/u.test(keywordQuery) ? " OR " : " AND ";
    const likeClause = tokens
      .map(() => "(lower(p.title) LIKE ? OR lower(aw.title) LIKE ? OR lower(p.abstract) LIKE ? OR lower(p.keywords) LIKE ? OR lower(p.mesh_terms) LIKE ?)")
      .join(likeOp);
    const likeParams = tokens.flatMap((token) => {
      const needle = `%${token.toLowerCase()}%`;
      return [needle, needle, needle, needle, needle];
    });
    const where = `(p.rowid IN (SELECT rowid FROM papers_fts WHERE papers_fts MATCH ?) OR (${likeClause}))`;
    const count = this.db.prepare(`
      SELECT count(*) AS count
      FROM papers p
      JOIN author_works aw ON aw.author_id = ? AND aw.doi != '' AND aw.doi = p.doi
      WHERE ${where}
    `).get(resolvedAuthorId, match, ...likeParams) as { count: number };
    // bm25 weights: title, abstract, keywords, mesh_terms, doi — title highest, then keywords/mesh, abstract, doi lowest.
    const rows = this.db.prepare(`
      SELECT ${PAPER_QUERY_COLUMNS_P}
      FROM papers p
      JOIN author_works aw ON aw.author_id = ? AND aw.doi != '' AND aw.doi = p.doi
      LEFT JOIN (
        SELECT rowid AS fts_rowid, bm25(papers_fts, 10.0, 1.0, 5.0, 5.0, 0.5) AS rank
        FROM papers_fts
        WHERE papers_fts MATCH ?
      ) fts ON fts.fts_rowid = p.rowid
      WHERE (fts.fts_rowid IS NOT NULL OR (${likeClause}))
      ORDER BY CASE WHEN fts.rank IS NULL THEN 1 ELSE 0 END, fts.rank ASC, p.updated_at DESC, p.paper_id ASC
      LIMIT ? OFFSET ?
    `).all(resolvedAuthorId, match, ...likeParams, limit, offset) as PaperSummaryRow[];
    const paperIds = rows.map((row) => row.paper_id);
    const pdfsByPaper = this.paperPdfVersions(paperIds);
    const uploads = this.paperUploadFields(paperIds);
    return {
      items: rows.map((row) => this.assemblePaper(row, pdfsByPaper[row.paper_id] ?? [], uploads[row.paper_id], { hasAbstract: Boolean(row.abstract?.trim()) })),
      total: count.count,
      limit,
      offset,
      resolvedAuthorId,
    };
  }

  private paperUploadFields(paperIds: string[]): Record<string, { metadataUpload?: PaperUpload; pdfUpload?: PaperUpload }> {
    const unique = [...new Set(paperIds.filter(Boolean))];
    if (unique.length === 0) return {};
    const rows = this.db.prepare(`
      SELECT paper_id, user_id, action, created_at
      FROM receipts
      WHERE paper_id IN (${unique.map(() => "?").join(",")})
        AND action IN ('admin.papers.ingest_metadata', 'admin.papers.fetch_fulltext', 'admin.papers.ingest_corpus', 'papers.import_local')
      ORDER BY created_at ASC
    `).all(...unique) as UploadReceiptRow[];
    const result: Record<string, { metadataUpload?: PaperUpload; pdfUpload?: PaperUpload }> = {};
    for (const row of rows) {
      const current = result[row.paper_id] ?? {};
      const parsed = uploadFromReceipt(row);
      if (parsed.metadata && !current.metadataUpload) current.metadataUpload = parsed.metadata;
      if (parsed.pdf) current.pdfUpload = parsed.pdf;
      result[row.paper_id] = current;
    }
    return result;
  }

  stats(): Omit<LibraryStats, "localPdfs"> {
    const row = this.db.prepare(`
      SELECT
        count(*) AS shared_papers,
        count(DISTINCT pp.paper_id) AS shared_pdfs
      FROM papers p
      LEFT JOIN paper_pdf pp ON pp.paper_id = p.paper_id
    `).get() as { shared_papers: number; shared_pdfs: number | null };
    const sharedPdfs = row.shared_pdfs ?? 0;
    return { sharedPapers: row.shared_papers, sharedPdfs, metadataOnly: row.shared_papers - sharedPdfs };
  }

  listAuthors(query: string, limit: number, offset: number, options?: { includeImportEvents?: boolean }): AuthorListResult {
    const needle = query.trim();
    const normalized = `%${needle.toLowerCase()}%`;
    const fold = foldAuthorToken(query);
    const where = needle === ""
      ? ""
      : `WHERE lower(a.name) LIKE ? OR lower(COALESCE(a.institution, '')) LIKE ? OR lower(a.author_id) LIKE ?
        OR lower(a.display_name_zh) LIKE ? OR lower(a.display_name_en) LIKE ?
        OR EXISTS (SELECT 1 FROM author_name_variants v WHERE v.author_id = a.author_id AND lower(v.name) LIKE ?)
        OR EXISTS (SELECT 1 FROM author_name_folds f WHERE f.author_id = a.author_id AND f.fold = ?)
        OR EXISTS (SELECT 1 FROM author_id_aliases al WHERE al.author_id = a.author_id AND (al.alias = ? OR lower(al.alias) LIKE ?))`;
    const params = needle === "" ? [] : [normalized, normalized, normalized, normalized, normalized, normalized, fold, needle, normalized];
    const count = this.db.prepare(`SELECT count(*) AS count FROM authors a ${where}`).get(...params) as { count: number };
    const rows = this.db.prepare(`
      SELECT a.${AUTHOR_ROW_COLUMNS.replaceAll(", ", ", a.")},
        (
          (SELECT count(*) FROM author_works aw WHERE aw.author_id = a.author_id)
          + (SELECT count(*) FROM paper_authors pa WHERE pa.author_id = a.author_id)
        ) AS paper_count
      FROM authors a
      ${where}
      ORDER BY paper_count DESC, a.display_name_zh COLLATE NOCASE ASC, a.name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<AuthorRow & { paper_count: number }>;
    const eventsByAuthor = this.loadSourceEventsByAuthor(rows.map((row) => row.author_id));
    return {
      items: rows.map((row) => this.toAuthorSummary(row, row.paper_count, eventsByAuthor.get(row.author_id) ?? [], options?.includeImportEvents === true)),
      total: count.count,
      limit,
      offset,
    };
  }

  getAuthor(identifier: string, options?: { viewerId?: string; includeAll?: boolean; includeImportEvents?: boolean }): AuthorDetail {
    const needle = identifier.trim();
    const canonicalId = this.resolveCanonicalAuthorId(needle);
    const row = canonicalId
      ? this.db.prepare(`SELECT ${AUTHOR_ROW_COLUMNS} FROM authors WHERE author_id = ?`).get(canonicalId) as AuthorRow | undefined
      : this.db.prepare(`
          SELECT ${AUTHOR_ROW_COLUMNS}
          FROM authors
          WHERE lower(name) = lower(?) OR lower(display_name_zh) = lower(?) OR lower(display_name_en) = lower(?)
          LIMIT 1
        `).get(needle, needle, needle) as AuthorRow | undefined;
    if (!row) throw new CenterError("not_found", "No author matches the supplied identifier.", 404);
    const linkedPapers = this.db.prepare(`
      SELECT p.paper_id, p.doi, p.title
      FROM paper_authors pa JOIN papers p ON p.paper_id = pa.paper_id
      WHERE pa.author_id = ?
      ORDER BY p.updated_at DESC, pa.position ASC
    `).all(row.author_id) as Array<{ paper_id: string; doi: string; title: string }>;
    const works = this.db.prepare(`
      SELECT doi, title, year, byline, match_basis, sources FROM author_works WHERE author_id = ? ORDER BY year DESC, position ASC, title ASC
    `).all(row.author_id) as Array<{ doi: string; title: string; year: number | null; byline: string; match_basis: string; sources: string }>;
    const notes = this.db.prepare(`
      SELECT note_id, kind, body, created_by, created_at FROM author_notes WHERE author_id = ? ORDER BY created_at DESC
    `).all(row.author_id) as Array<{ note_id: string; kind: AuthorNote["kind"]; body: string; created_by: string; created_at: string }>;
    const libraryByDoi = this.papersByDois(works.map((work) => work.doi));
    const mappedWorks: AuthorWork[] = works.map((work) => {
      const sources = parseMergeSources(work.sources || work.match_basis);
      const library = work.doi ? libraryByDoi.get(canonicalIdentifier(work.doi)) : undefined;
      return {
        doi: work.doi,
        title: work.title,
        ...(work.year ? { year: work.year } : {}),
        ...(optionalText(work.byline) ? { byline: work.byline } : {}),
        ...(optionalText(work.match_basis) ? { matchBasis: work.match_basis } : {}),
        ...(sources.length ? { sources } : {}),
        ...(library ? { library } : {}),
      };
    });
    const papers = [];
    const seen = new Set<string>();
    for (const work of mappedWorks) {
      const paper = work.library?.paper;
      if (!paper || seen.has(paper.paperId)) continue;
      seen.add(paper.paperId);
      papers.push(paper);
    }
    for (const paper of linkedPapers) {
      if (seen.has(paper.paper_id)) continue;
      seen.add(paper.paper_id);
      papers.push({ paperId: paper.paper_id, doi: paper.doi, title: paper.title });
    }
    return {
      ...this.toAuthorSummary(
        row,
        mappedWorks.length + linkedPapers.filter((paper) => !libraryByDoi.has(canonicalIdentifier(paper.doi))).length,
        this.loadSourceEventsByAuthor([row.author_id]).get(row.author_id) ?? [],
        options?.includeImportEvents === true,
      ),
      papers,
      works: mappedWorks,
      notes: notes.map((note) => ({
        noteId: note.note_id,
        kind: note.kind,
        body: note.body,
        createdBy: note.created_by,
        createdAt: note.created_at,
      })),
      relations: this.visibleRelations(row.author_id, options),
      ...(optionalText(row.openalex_id) ? { openalexId: row.openalex_id } : {}),
      ...(optionalText(row.orcid) ? { orcid: row.orcid } : {}),
    };
  }

  private toAuthorSummary(row: AuthorRow, paperCount: number, events: AuthorSourceEventRow[] = [], includeImportEvents = false): AuthorSummary {
    const variants = this.db.prepare("SELECT name FROM author_name_variants WHERE author_id = ? ORDER BY name COLLATE NOCASE").all(row.author_id) as Array<{ name: string }>;
    const aliases = this.db.prepare("SELECT alias FROM author_id_aliases WHERE author_id = ? ORDER BY alias COLLATE NOCASE").all(row.author_id) as Array<{ alias: string }>;
    const importEvents = includeImportEvents ? this.toImportEvents(events) : undefined;
    return {
      authorId: row.author_id,
      name: displayNameFrom(row.display_name_zh, row.display_name_en, row.name),
      ...(optionalText(row.display_name_zh) ? { displayNameZh: row.display_name_zh } : {}),
      ...(optionalText(row.display_name_en) ? { displayNameEn: row.display_name_en } : {}),
      ...(optionalText(row.institution) ? { institution: row.institution ?? undefined } : {}),
      identityStatus: row.identity_status,
      ...(variants.length ? { englishNameVariants: variants.map((item) => item.name) } : {}),
      ...(optionalText(row.country_code) ? { countryCode: row.country_code } : {}),
      ...(optionalText(row.university_code) ? { universityCode: row.university_code } : {}),
      ...(optionalText(row.hospital_code) ? { hospitalCode: row.hospital_code } : {}),
      ...(optionalText(row.discipline_code) ? { disciplineCode: row.discipline_code } : {}),
      ...(aliases.length ? { authorIdAliases: aliases.map((item) => item.alias) } : {}),
      paperCount,
      sourceStatuses: this.toSourceStatuses(events),
      ...(importEvents ? { importEvents } : {}),
    };
  }

  private loadSourceEventsByAuthor(authorIds: string[]): Map<string, AuthorSourceEventRow[]> {
    const map = new Map<string, AuthorSourceEventRow[]>();
    for (const authorId of authorIds) map.set(authorId, []);
    const unique = [...new Set(authorIds.filter(Boolean))];
    const chunkSize = 400;
    for (let index = 0; index < unique.length; index += chunkSize) {
      const chunk = unique.slice(index, index + chunkSize);
      const rows = this.db.prepare(`
        SELECT event_id, author_id, source, kind, occurred_at, hit_count, empty, notes
        FROM author_source_events
        WHERE author_id IN (${chunk.map(() => "?").join(", ")})
        ORDER BY occurred_at DESC, event_id DESC
      `).all(...chunk) as AuthorSourceEventRow[];
      for (const row of rows) {
        const list = map.get(row.author_id);
        if (list) list.push(row);
        else map.set(row.author_id, [row]);
      }
    }
    return map;
  }

  private toSourceStatuses(events: AuthorSourceEventRow[]): AuthorSourceStatus[] {
    return AUTHOR_MERGE_SOURCES.map((source) => {
      const forSource = events.filter((event) => event.source === source);
      if (forSource.length === 0) return { source, state: "none" as const };
      if (forSource.some((event) => event.hit_count > 0)) return { source, state: "hit" as const };
      return { source, state: "empty" as const };
    });
  }

  private toImportEvents(events: AuthorSourceEventRow[]): AuthorImportEvent[] {
    return [...events]
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at) || right.event_id.localeCompare(left.event_id))
      .map((event) => ({
        eventId: event.event_id,
        source: event.source,
        kind: event.kind,
        occurredAt: event.occurred_at,
        hitCount: event.hit_count,
        empty: event.empty === 1,
        ...(optionalText(event.notes) ? { notes: event.notes } : {}),
      }));
  }

  private ensureRosterSourceEvent(authorId: string, occurredAt: string) {
    const existing = this.db.prepare("SELECT event_id FROM author_source_events WHERE author_id = ? AND source = 'v3' AND kind = 'roster' LIMIT 1").get(authorId) as { event_id: string } | undefined;
    if (existing) return;
    this.insertSourceEvent({
      eventId: `src_roster_${authorId}`,
      authorId,
      source: "v3",
      kind: "roster",
      occurredAt,
      hitCount: 1,
      empty: false,
      notes: "v3 roster import",
    });
  }

  private insertSourceEvent(event: {
    eventId?: string;
    authorId: string;
    source: AuthorMergeSource;
    kind: AuthorSourceEventKind;
    occurredAt: string;
    hitCount: number;
    empty: boolean;
    notes?: string;
  }) {
    this.db.prepare(`
      INSERT INTO author_source_events(event_id, author_id, source, kind, occurred_at, hit_count, empty, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId || `src_${randomUUID()}`,
      event.authorId,
      event.source,
      event.kind,
      event.occurredAt,
      event.hitCount,
      event.empty ? 1 : 0,
      event.notes?.trim() ?? "",
    );
  }

  upsertAuthor(userId: string, requestId: string, patch: AuthorAdminUpsert, host?: AuditHost) {
    const authorId = patch.authorId.trim();
    const existing = this.db.prepare("SELECT author_id, display_name_en FROM authors WHERE author_id = ?").get(authorId) as { author_id: string; display_name_en: string } | undefined;
    if (!existing) throw new CenterError("not_found", "No author matches the supplied identifier.", 404);
    const displayNameEn = patch.displayNameEn?.trim();
    const institution = patch.institution?.trim();
    const variants = patch.englishNameVariants?.map((value) => value.trim()).filter(Boolean);
    if (displayNameEn === undefined && institution === undefined && variants === undefined) {
      throw new CenterError("validation_failed", "admin.authors.upsert requires at least one field to update.", 400);
    }
    if (displayNameEn !== undefined && displayNameEn.length > 200) throw new CenterError("validation_failed", "The English display name is too long.", 400);
    if (institution !== undefined && institution.length > 200) throw new CenterError("validation_failed", "The institution name is too long.", 400);
    if (variants && variants.length > 40) throw new CenterError("validation_failed", "Too many English name variants.", 400);
    const now = new Date().toISOString();
    const receiptId = `author_admin_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (displayNameEn !== undefined) {
        this.db.prepare(`
          UPDATE authors SET display_name_en = ?, name = CASE WHEN display_name_zh = '' THEN ? ELSE display_name_zh END, identity_status = 'reviewed', updated_at = ? WHERE author_id = ?
        `).run(displayNameEn, displayNameEn, now, authorId);
      }
      if (institution !== undefined) {
        this.db.prepare("UPDATE authors SET institution = ?, updated_at = ? WHERE author_id = ?").run(institution || null, now, authorId);
      }
      if (variants) {
        const primary = (this.db.prepare("SELECT display_name_en FROM authors WHERE author_id = ?").get(authorId) as { display_name_en: string }).display_name_en;
        this.db.prepare("DELETE FROM author_name_variants WHERE author_id = ? AND source = 'admin'").run(authorId);
        const insert = this.db.prepare("INSERT INTO author_name_variants(author_id, name, kind, source) VALUES (?, ?, 'observed_signature', 'admin') ON CONFLICT(author_id, name) DO UPDATE SET source = 'admin'");
        for (const name of [...new Set(variants)].filter((name) => name !== primary)) insert.run(authorId, name);
      }
      this.rebuildAuthorFolds(authorId);
      this.recordAuthorReceipt(receiptId, userId, requestId, "admin.authors.upsert", authorId, now, host);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { receiptId, data: this.getAuthor(authorId) };
  }

  ingestAuthorMerge(userId: string, requestId: string, draft: AuthorMergeIngest, host?: AuditHost) {
    const authorId = draft.authorId.trim();
    if (!authorId) throw new CenterError("validation_failed", "authorId is required.", 400);
    if (!Array.isArray(draft.works)) throw new CenterError("validation_failed", "works must be an array.", 400);
    if (!Array.isArray(draft.queries) || draft.queries.length === 0) {
      throw new CenterError("validation_failed", "A merge ingest needs at least one source query.", 400);
    }
    const now = new Date().toISOString();
    const receiptId = `author_merge_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT author_id FROM authors WHERE author_id = ?").get(authorId) as { author_id: string } | undefined;
      const zh = draft.displayNameZh?.trim() ?? "";
      const en = draft.displayNameEn?.trim() ?? "";
      const name = displayNameFrom(zh, en, authorId);
      const institution = draft.institution?.trim() || null;
      if (!existing) {
        this.db.prepare(`
          INSERT INTO authors(author_id, name, institution, display_name_zh, display_name_en, openalex_id, orcid, identity_status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?)
        `).run(authorId, name, institution, zh, en, draft.openalexId?.trim() ?? "", draft.orcid?.trim() ?? "", now, now);
      } else {
        this.db.prepare(`
          UPDATE authors SET
            name = CASE WHEN ? != '' THEN ? ELSE name END,
            institution = COALESCE(?, institution),
            display_name_zh = CASE WHEN ? != '' THEN ? ELSE display_name_zh END,
            display_name_en = CASE WHEN identity_status = 'reviewed' AND display_name_en != '' THEN display_name_en WHEN ? != '' THEN ? ELSE display_name_en END,
            openalex_id = CASE WHEN ? != '' THEN ? ELSE openalex_id END,
            orcid = CASE WHEN ? != '' THEN ? ELSE orcid END,
            updated_at = ?
          WHERE author_id = ?
        `).run(name, name, institution, zh, zh, en, en, draft.openalexId?.trim() ?? "", draft.openalexId?.trim() ?? "", draft.orcid?.trim() ?? "", draft.orcid?.trim() ?? "", now, authorId);
      }
      if (draft.englishNameVariants) {
        const primary = (this.db.prepare("SELECT display_name_en FROM authors WHERE author_id = ?").get(authorId) as { display_name_en: string }).display_name_en;
        this.db.prepare("DELETE FROM author_name_variants WHERE author_id = ? AND source != 'admin'").run(authorId);
        const insert = this.db.prepare("INSERT INTO author_name_variants(author_id, name, kind, source) VALUES (?, ?, 'observed_signature', 'merge') ON CONFLICT(author_id, name) DO NOTHING");
        for (const variant of [...new Set(draft.englishNameVariants.map((value) => value.trim()).filter((value) => value && value !== primary))]) insert.run(authorId, variant);
      }
      const previous = this.db.prepare("SELECT doi, title, year, byline, match_basis, sources FROM author_works WHERE author_id = ?").all(authorId) as Array<{ doi: string; title: string; year: number | null; byline: string; match_basis: string; sources: string }>;
      const merged = new Map<string, { doi: string; title: string; year: number | null; byline: string; matchBasis: string; sources: AuthorMergeSource[] }>();
      for (const work of previous) {
        const doi = canonicalIdentifier(work.doi);
        const key = doi || work.title.toLowerCase();
        merged.set(key, {
          doi,
          title: work.title,
          year: work.year,
          byline: work.byline,
          matchBasis: work.match_basis,
          sources: parseMergeSources(work.sources || work.match_basis),
        });
      }
      for (const work of draft.works) {
        const title = work.title.trim();
        if (!title) continue;
        const doi = work.doi ? canonicalIdentifier(work.doi) : "";
        const key = doi || title.toLowerCase();
        const sources = parseMergeSources(work.sources ?? work.matchBasis);
        const current = merged.get(key);
        if (!current) {
          merged.set(key, { doi, title, year: work.year ?? null, byline: work.byline?.trim() ?? "", matchBasis: work.matchBasis?.trim() || sources.join("+"), sources });
          continue;
        }
        current.sources = [...new Set([...current.sources, ...sources])];
        if (!current.doi && doi) current.doi = doi;
        if (!current.byline && work.byline?.trim()) current.byline = work.byline.trim();
        if (!current.year && work.year) current.year = work.year;
        if (work.matchBasis?.trim()) current.matchBasis = work.matchBasis.trim();
      }
      this.db.prepare("DELETE FROM author_works WHERE author_id = ?").run(authorId);
      const workStatement = this.db.prepare("INSERT INTO author_works(author_id, doi, title, year, byline, match_basis, sources, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      [...merged.values()].forEach((work, position) => {
        workStatement.run(authorId, work.doi, work.title, work.year, work.byline, work.matchBasis || work.sources.join("+"), work.sources.join("+"), position);
      });
      let papersIngested = 0;
      for (const work of merged.values()) {
        if (!work.doi) continue;
        const existingPaper = this.db.prepare("SELECT paper_id FROM papers WHERE doi = ?").get(work.doi) as { paper_id: string } | undefined;
        if (existingPaper) continue;
        const paperId = `doi:${work.doi}`;
        this.db.prepare(`
          INSERT INTO papers(paper_id, doi, title, created_at, updated_at, metadata_uploaded_at, metadata_uploaded_by, metadata_role, metadata_channel)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', 'admin_fetch')
        `).run(paperId, work.doi, work.title, now, now, now, userId);
        papersIngested += 1;
      }
      this.rebuildAuthorFolds(authorId);
      this.insertMergeRun(authorId, userId, now, {
        queries: draft.queries,
        conflicts: draft.conflicts,
        notes: draft.notes,
        workCount: merged.size,
        papersIngested,
      });
      this.recordAuthorReceipt(receiptId, userId, requestId, "admin.authors.ingest_merge", authorId, now, host);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { receiptId, data: this.getAuthorMerge(authorId) };
  }

  ingestAuthorWorks(userId: string, requestId: string, draft: AuthorWorksIngest, host?: AuditHost) {
    const requested = draft.authorId.trim();
    if (!requested) throw new CenterError("validation_failed", "authorId is required.", 400);
    if (!Array.isArray(draft.works)) throw new CenterError("validation_failed", "works must be an array.", 400);
    const authorId = this.resolveCanonicalAuthorId(requested);
    if (!authorId) throw new CenterError("not_found", "No author matches the supplied identifier.", 404);
    const now = new Date().toISOString();
    const occurredAt = draft.occurredAt?.trim() || now;
    const receiptId = `author_works_ingest_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT doi, title, year, byline, match_basis, sources FROM author_works WHERE author_id = ?").all(authorId) as Array<{ doi: string; title: string; year: number | null; byline: string; match_basis: string; sources: string }>;
      const merged = new Map<string, MergedAuthorWork>();
      for (const work of previous) {
        const doi = canonicalIdentifier(work.doi);
        const key = doi || work.title.toLowerCase();
        merged.set(key, {
          doi,
          title: work.title,
          year: work.year,
          byline: work.byline,
          matchBasis: work.match_basis,
          sources: parseMergeSources(work.sources || work.match_basis),
        });
      }
      let matched = 0;
      for (const work of draft.works) {
        const title = work.title.trim();
        if (!title) continue;
        matched += 1;
        const doi = work.doi ? canonicalIdentifier(work.doi) : "";
        const key = doi || title.toLowerCase();
        const sources = parseMergeSources(work.sources ?? work.matchBasis);
        const incoming = sources.length ? sources : (["v3"] as AuthorMergeSource[]);
        const current = merged.get(key);
        if (!current) {
          merged.set(key, {
            doi,
            title,
            year: work.year ?? null,
            byline: work.byline?.trim() ?? "",
            matchBasis: work.matchBasis?.trim() || incoming.join("+"),
            sources: incoming,
          });
          continue;
        }
        current.sources = [...new Set([...current.sources, ...incoming])];
        if (!current.doi && doi) current.doi = doi;
        if (!current.byline && work.byline?.trim()) current.byline = work.byline.trim();
        if (!current.year && work.year) current.year = work.year;
        if (work.matchBasis?.trim()) current.matchBasis = work.matchBasis.trim();
      }
      this.db.prepare("DELETE FROM author_works WHERE author_id = ?").run(authorId);
      const workStatement = this.db.prepare("INSERT INTO author_works(author_id, doi, title, year, byline, match_basis, sources, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      [...merged.values()].forEach((work, position) => {
        workStatement.run(authorId, work.doi, work.title, work.year, work.byline, work.matchBasis || work.sources.join("+"), work.sources.join("+"), position);
      });
      this.insertSourceEvent({
        authorId,
        source: "v3",
        kind: "works",
        occurredAt,
        hitCount: matched,
        empty: matched === 0,
        notes: draft.notes?.trim() || "v3 works import",
      });
      this.rebuildAuthorFolds(authorId);
      this.recordAuthorReceipt(receiptId, userId, requestId, "admin.authors.ingest_works", authorId, now, host);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { receiptId, data: this.getAuthor(authorId, { includeImportEvents: true }) };
  }

  listAuthorMerges(status?: AuthorMergeStatus): AuthorMergeListResult {
    const latest = `
      SELECT r.run_id, r.author_id, r.status, r.created_at, r.work_count, a.name, a.display_name_zh, a.display_name_en, a.orcid, a.openalex_id
      FROM author_merge_runs r
      JOIN authors a ON a.author_id = r.author_id
      WHERE r.created_at = (SELECT max(created_at) FROM author_merge_runs x WHERE x.author_id = r.author_id)
      ${status ? "AND r.status = ?" : ""}
      ORDER BY r.created_at DESC, a.display_name_zh COLLATE NOCASE ASC
    `;
    const rows = (status
      ? this.db.prepare(latest).all(status)
      : this.db.prepare(latest).all()) as Array<{
      run_id: string;
      author_id: string;
      status: AuthorMergeStatus;
      created_at: string;
      work_count: number;
      name: string;
      display_name_zh: string;
      display_name_en: string;
      orcid: string;
      openalex_id: string;
    }>;
    return {
      items: rows.map((row) => {
        const run = this.loadMergeRun(row.run_id);
        return {
          authorId: row.author_id,
          name: displayNameFrom(row.display_name_zh, row.display_name_en, row.name),
          ...(optionalText(row.display_name_zh) ? { displayNameZh: row.display_name_zh } : {}),
          ...(optionalText(row.display_name_en) ? { displayNameEn: row.display_name_en } : {}),
          ...(optionalText(row.orcid) ? { orcid: row.orcid } : {}),
          ...(optionalText(row.openalex_id) ? { openalexId: row.openalex_id } : {}),
          status: row.status,
          identityPinned: identityPinned(row),
          sourcesComplete: run.sourcesComplete,
          workCount: row.work_count,
          updatedAt: row.created_at,
        } satisfies AuthorMergeSummary;
      }),
      total: rows.length,
    };
  }

  getAuthorMerge(authorId: string): AuthorMergeDetail {
    const author = this.getAuthor(authorId);
    const rows = this.db.prepare("SELECT run_id FROM author_merge_runs WHERE author_id = ? ORDER BY created_at DESC").all(author.authorId) as Array<{ run_id: string }>;
    if (rows.length === 0) throw new CenterError("not_found", "No merge history exists for this author.", 404);
    const history = rows.map((row) => this.loadMergeRun(row.run_id));
    return { author, latest: history[0]!, history };
  }

  reviewAuthorMerge(userId: string, requestId: string, authorId: string, decision: "confirmed" | "returned", host?: AuditHost) {
    const needle = authorId.trim();
    const latest = this.db.prepare(`
      SELECT run_id, status FROM author_merge_runs
      WHERE author_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(needle) as { run_id: string; status: AuthorMergeStatus } | undefined;
    if (!latest) throw new CenterError("not_found", "No merge history exists for this author.", 404);
    if (decision === "confirmed" && latest.status === "confirmed") {
      throw new CenterError("conflict", "This author merge is already confirmed.", 409);
    }
    const now = new Date().toISOString();
    const receiptId = `author_merge_review_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE author_merge_runs SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE run_id = ?")
        .run(decision, userId, now, latest.run_id);
      this.recordAuthorReceipt(receiptId, userId, requestId, "admin.authors.review_merge", needle, now, host);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { receiptId, data: this.getAuthorMerge(needle) };
  }

  private insertMergeRun(
    authorId: string,
    createdBy: string,
    now: string,
    payload: {
      queries: Array<{ source: string; queriedAt?: string; hitCount: number; empty?: boolean; error?: string }>;
      conflicts?: Array<{ kind: string; body: string }>;
      notes?: string;
      workCount: number;
      papersIngested: number;
    },
  ) {
    const runId = `merge_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO author_merge_runs(run_id, author_id, status, created_by, created_at, work_count, papers_ingested, notes)
      VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)
    `).run(runId, authorId, createdBy, now, payload.workCount, payload.papersIngested, payload.notes?.trim() ?? "");
    const queryStatement = this.db.prepare("INSERT INTO author_merge_source_queries(run_id, source, queried_at, hit_count, empty, error) VALUES (?, ?, ?, ?, ?, ?)");
    const seen = new Set<string>();
    for (const query of payload.queries) {
      const source = query.source.trim().toLowerCase();
      if (!AUTHOR_MERGE_SOURCES.includes(source as AuthorMergeSource) || seen.has(source)) continue;
      seen.add(source);
      const hitCount = Number(query.hitCount) || 0;
      const empty = query.empty === true || hitCount === 0;
      const queriedAt = query.queriedAt?.trim() || now;
      const error = query.error?.trim() ?? "";
      queryStatement.run(runId, source, queriedAt, hitCount, empty ? 1 : 0, error);
      this.insertSourceEvent({
        eventId: `src_mq_${runId}_${source}`,
        authorId,
        source: source as AuthorMergeSource,
        kind: "merge_query",
        occurredAt: queriedAt,
        hitCount,
        empty,
        notes: error,
      });
    }
    const conflictStatement = this.db.prepare("INSERT INTO author_merge_conflicts(conflict_id, run_id, kind, body) VALUES (?, ?, ?, ?)");
    for (const conflict of payload.conflicts ?? []) {
      const kind = conflict.kind.trim();
      const body = conflict.body.trim();
      if (!kind || !body) continue;
      conflictStatement.run(`conflict_${randomUUID()}`, runId, kind.slice(0, 80), body.slice(0, 2000));
    }
  }

  private loadMergeRun(runId: string): AuthorMergeRun {
    const row = this.db.prepare(`
      SELECT r.run_id, r.author_id, r.status, r.created_by, r.created_at, r.reviewed_by, r.reviewed_at, r.work_count, r.papers_ingested, r.notes,
        a.orcid, a.openalex_id, a.display_name_en
      FROM author_merge_runs r JOIN authors a ON a.author_id = r.author_id
      WHERE r.run_id = ?
    `).get(runId) as {
      run_id: string;
      author_id: string;
      status: AuthorMergeStatus;
      created_by: string;
      created_at: string;
      reviewed_by: string | null;
      reviewed_at: string | null;
      work_count: number;
      papers_ingested: number;
      notes: string;
      orcid: string;
      openalex_id: string;
      display_name_en: string;
    };
    const queries = this.db.prepare("SELECT source, queried_at, hit_count, empty, error FROM author_merge_source_queries WHERE run_id = ? ORDER BY source")
      .all(runId) as Array<{ source: AuthorMergeSource; queried_at: string; hit_count: number; empty: number; error: string }>;
    const conflicts = this.db.prepare("SELECT kind, body FROM author_merge_conflicts WHERE run_id = ?")
      .all(runId) as AuthorMergeConflict[];
    const mappedQueries: AuthorMergeSourceQuery[] = queries.map((query) => ({
      source: query.source,
      queriedAt: query.queried_at,
      hitCount: query.hit_count,
      empty: query.empty === 1,
      ...(optionalText(query.error) ? { error: query.error } : {}),
    }));
    const queried = new Set(mappedQueries.map((query) => query.source));
    return {
      runId: row.run_id,
      authorId: row.author_id,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      ...(optionalText(row.reviewed_by) ? { reviewedBy: row.reviewed_by ?? undefined } : {}),
      ...(optionalText(row.reviewed_at) ? { reviewedAt: row.reviewed_at ?? undefined } : {}),
      workCount: row.work_count,
      papersIngested: row.papers_ingested,
      identityPinned: identityPinned(row),
      sourcesComplete: AUTHOR_MERGE_SOURCES.every((source) => queried.has(source)),
      queries: mappedQueries,
      conflicts,
      ...(optionalText(row.notes) ? { notes: row.notes } : {}),
    };
  }

  submitAuthorNote(userId: string, requestId: string, draft: AuthorNoteDraft, host?: AuditHost) {
    const authorId = draft.authorId.trim();
    const existing = this.db.prepare("SELECT author_id FROM authors WHERE author_id = ?").get(authorId) as { author_id: string } | undefined;
    if (!existing) throw new CenterError("not_found", "No author matches the supplied identifier.", 404);
    const allowed = new Set(["mentorship", "abbreviation", "disambiguation"]);
    if (!allowed.has(draft.kind)) throw new CenterError("validation_failed", "Note kind must be mentorship, abbreviation, or disambiguation.", 400);
    const body = draft.body.trim();
    if (body.length < 1 || body.length > 2000) throw new CenterError("validation_failed", "A note body of 1 to 2000 characters is required.", 400);
    const now = new Date().toISOString();
    const receiptId = `author_note_${randomUUID()}`;
    const noteId = `note_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO author_notes(note_id, author_id, kind, body, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(noteId, authorId, draft.kind, body, userId, now);
      this.db.prepare("UPDATE authors SET identity_status = 'reviewed', updated_at = ? WHERE author_id = ?").run(now, authorId);
      this.recordAuthorReceipt(receiptId, userId, requestId, "authors.submit_note", authorId, now, host);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { receiptId, data: this.getAuthor(authorId) };
  }

  submitAuthorRelation(userId: string, requestId: string, draft: AuthorRelationDraft, host?: AuditHost) {
    const authorId = draft.authorId.trim();
    const existing = this.db.prepare("SELECT author_id FROM authors WHERE author_id = ?").get(authorId) as { author_id: string } | undefined;
    if (!existing) throw new CenterError("not_found", "No author matches the supplied identifier.", 404);
    const body = draft.body?.trim() ?? "";
    const mentor = draft.mentor?.trim() ?? "";
    const students = [...new Set((draft.students ?? []).map((value) => value.trim()).filter(Boolean))];
    if (!body && !mentor && students.length === 0) {
      throw new CenterError("validation_failed", "A relation submission needs a comment, mentor, or at least one student.", 400);
    }
    if (body.length > 2000) throw new CenterError("validation_failed", "The relation comment is too long.", 400);
    if (mentor.length > 80) throw new CenterError("validation_failed", "The mentor name is too long.", 400);
    if (students.length > 20 || students.some((name) => name.length > 80)) {
      throw new CenterError("validation_failed", "Student names must be at most 20 items of 80 characters.", 400);
    }
    const now = new Date().toISOString();
    const receiptId = `author_relation_${randomUUID()}`;
    const relationId = `relation_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO author_relation_posts(relation_id, author_id, body, mentor, students_json, status, submitted_by, submitted_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(relationId, authorId, body, mentor, JSON.stringify(students), userId, now);
      this.recordAuthorReceipt(receiptId, userId, requestId, "authors.submit_relation", authorId, now, host);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { receiptId, data: { relation: this.getRelationPost(relationId), author: this.getAuthor(authorId) } };
  }

  listAuthorRelations(query: { authorId?: string; status?: AuthorRelationStatus }) {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.authorId?.trim()) {
      clauses.push("author_id = ?");
      params.push(query.authorId.trim());
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT relation_id, author_id, body, mentor, students_json, status, submitted_by, submitted_at, reviewed_by, reviewed_at
      FROM author_relation_posts ${where}
      ORDER BY submitted_at DESC
    `).all(...params) as RelationRow[];
    return { items: rows.map((row) => this.toRelationPost(row)), total: rows.length };
  }

  reviewAuthorRelation(userId: string, requestId: string, relationId: string, decision: "approved" | "rejected", host?: AuditHost) {
    const id = relationId.trim();
    const existing = this.db.prepare("SELECT relation_id, status, author_id FROM author_relation_posts WHERE relation_id = ?").get(id) as { relation_id: string; status: string; author_id: string } | undefined;
    if (!existing) throw new CenterError("not_found", "No relation submission matches the supplied identifier.", 404);
    if (existing.status !== "pending") throw new CenterError("conflict", "This relation submission has already been reviewed.", 409);
    if (decision !== "approved" && decision !== "rejected") throw new CenterError("validation_failed", "Decision must be approved or rejected.", 400);
    const now = new Date().toISOString();
    const receiptId = `author_review_${randomUUID()}`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE author_relation_posts SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE relation_id = ?")
        .run(decision, userId, now, id);
      this.recordAuthorReceipt(receiptId, userId, requestId, "admin.authors.review_relation", existing.author_id, now, host);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { receiptId, data: { relation: this.getRelationPost(id), author: this.getAuthor(existing.author_id) } };
  }

  private loadAuthorRelations(authorId: string, status?: AuthorRelationStatus) {
    return this.listAuthorRelations({ authorId, ...(status ? { status } : {}) }).items;
  }

  private visibleRelations(authorId: string, options?: { viewerId?: string; includeAll?: boolean }) {
    if (options?.includeAll) return this.listAuthorRelations({ authorId }).items;
    const approved = this.loadAuthorRelations(authorId, "approved");
    if (!options?.viewerId) return approved;
    const ownHidden = this.listAuthorRelations({ authorId }).items.filter(
      (item) => item.submittedBy === options.viewerId && item.status !== "approved",
    );
    return [...approved, ...ownHidden];
  }

  private getRelationPost(relationId: string): AuthorRelationPost {
    const row = this.db.prepare(`
      SELECT relation_id, author_id, body, mentor, students_json, status, submitted_by, submitted_at, reviewed_by, reviewed_at
      FROM author_relation_posts WHERE relation_id = ?
    `).get(relationId) as RelationRow | undefined;
    if (!row) throw new CenterError("not_found", "No relation submission matches the supplied identifier.", 404);
    return this.toRelationPost(row);
  }

  private toRelationPost(row: RelationRow): AuthorRelationPost {
    let students: string[] = [];
    try {
      const parsed = JSON.parse(row.students_json || "[]");
      if (Array.isArray(parsed)) students = parsed.map((value) => String(value)).filter(Boolean);
    } catch {
      students = [];
    }
    return {
      relationId: row.relation_id,
      authorId: row.author_id,
      ...(optionalText(row.body) ? { body: row.body } : {}),
      ...(optionalText(row.mentor) ? { mentor: row.mentor } : {}),
      ...(students.length ? { students } : {}),
      status: row.status,
      submittedBy: row.submitted_by,
      submittedAt: row.submitted_at,
      ...(optionalText(row.reviewed_by) ? { reviewedBy: row.reviewed_by ?? undefined } : {}),
      ...(optionalText(row.reviewed_at) ? { reviewedAt: row.reviewed_at ?? undefined } : {}),
    };
  }

  private recordAuthorReceipt(receiptId: string, userId: string, requestId: string, action: string, authorId: string, now: string, host?: AuditHost) {
    this.db.prepare("INSERT INTO receipts(receipt_id, user_id, action, paper_id, sha256, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
      .run(receiptId, userId, action, authorId, now);
    this.insertAudit({ requestId, userId, action, resourceId: authorId, result: "ok", receiptId, createdAt: now, host });
  }

  getFixture(paperId: string): FixtureSource {
    const row = this.db.prepare(`
      SELECT p.paper_id, p.doi, f.source_file, f.expected_sha256, f.expected_byte_size, f.expected_page_count
      FROM fixture_sources f JOIN papers p ON p.paper_id = f.paper_id WHERE p.paper_id = ?
    `).get(paperId) as {
      paper_id: string;
      doi: string;
      source_file: string;
      expected_sha256: string;
      expected_byte_size: number;
      expected_page_count: number;
    } | undefined;
    if (!row) throw new CenterError("not_found", "No full-text fixture is available for this paper.", 404);
    return {
      paperId: row.paper_id,
      doi: row.doi,
      sourceFile: row.source_file,
      sha256: row.expected_sha256,
      byteSize: row.expected_byte_size,
      pageCount: row.expected_page_count,
    };
  }

  private linkPdfVersion(
    userId: string,
    requestId: string,
    action: string,
    receiptPrefix: string,
    paperId: string,
    asset: { sha256: string; byteSize: number; pageCount: number; verifiedAt: string },
    host?: AuditHost,
  ): { receiptId: string; alreadyPresent: boolean } {
    const linkedPaper = this.db.prepare("SELECT paper_id FROM paper_pdf WHERE sha256 = ? LIMIT 1").get(asset.sha256) as { paper_id: string } | undefined;
    if (linkedPaper && linkedPaper.paper_id !== paperId) {
      throw new CenterError("conflict", "This PDF hash is already linked to a different paper identity.", 409);
    }
    const alreadyLinked = Boolean(this.db.prepare("SELECT 1 FROM paper_pdf WHERE paper_id = ? AND sha256 = ?").get(paperId, asset.sha256));
    const receiptId = `${receiptPrefix}_${randomUUID()}`;
    const auditResult = alreadyLinked ? "already_present" : "ok";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!alreadyLinked) {
        this.db.prepare(`
          INSERT INTO pdf_objects(sha256, byte_size, page_count, mime_verified, verified_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(sha256) DO NOTHING
        `).run(asset.sha256, asset.byteSize, asset.pageCount, asset.verifiedAt);
        this.db.prepare("INSERT INTO paper_pdf(paper_id, sha256, updated_at) VALUES (?, ?, ?)").run(paperId, asset.sha256, asset.verifiedAt);
      }
      this.db.prepare("INSERT INTO receipts(receipt_id, user_id, action, paper_id, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(receiptId, userId, action, paperId, asset.sha256, asset.verifiedAt);
      this.insertAudit({ requestId, userId, action, resourceId: paperId, result: auditResult, receiptId, createdAt: asset.verifiedAt, host });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { receiptId, alreadyPresent: alreadyLinked };
  }

  private recordAsset(userId: string, requestId: string, action: string, receiptPrefix: string, paperId: string, asset: { sha256: string; byteSize: number; pageCount: number; verifiedAt: string }, host?: AuditHost) {
    const linked = this.linkPdfVersion(userId, requestId, action, receiptPrefix, paperId, asset, host);
    return { ...linked, data: this.getPaper(paperId) };
  }

  recordIngest(userId: string, requestId: string, paperId: string, asset: { sha256: string; byteSize: number; pageCount: number; verifiedAt: string }, host?: AuditHost) {
    return this.recordAsset(userId, requestId, "admin.papers.fetch_fulltext", "ingest", paperId, asset, host);
  }

  hasPdfVersion(paperId: string, sha256: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM paper_pdf WHERE paper_id = ? AND sha256 = ?").get(paperId, sha256));
  }

  ingestMetadata(userId: string, requestId: string, drafts: PaperMetadataDraft[], host?: AuditHost): { receiptId: string; data: PaperMetadataIngest } {
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new CenterError("validation_failed", "At least one paper is required.", 400);
    }
    if (drafts.length > 50) throw new CenterError("validation_failed", "At most 50 metadata records can be ingested at once.", 400);
    const now = new Date().toISOString();
    const createdIds: string[] = [];
    const updatedIds: string[] = [];
    let skipped = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const draft of drafts) {
        if (typeof draft.doi !== "string" || typeof draft.title !== "string") {
          throw new CenterError("validation_failed", "Each paper needs a doi and title.", 400);
        }
        const doi = canonicalIdentifier(draft.doi);
        const title = sanitizeTitle(draft.title);
        if (!doi || !title) throw new CenterError("validation_failed", "Each paper needs a non-empty doi and title.", 400);
        if (title.length > 500) throw new CenterError("validation_failed", "A paper title is too long.", 400);
        const raw = draft as PaperMetadataDraft & { abstract?: unknown; keywords?: unknown; meshTerms?: unknown };
        const abstract = optionalDraftText(raw.abstract, "abstract", 20_000);
        const keywords = optionalDraftTerms(raw.keywords, "keywords");
        const meshTerms = optionalDraftTerms(raw.meshTerms, "meshTerms");
        const existing = this.db.prepare("SELECT paper_id, abstract, keywords, mesh_terms, enriched_at, keywords_fetched_at FROM papers WHERE doi = ?").get(doi) as {
          paper_id: string;
          abstract: string;
          keywords: string;
          mesh_terms: string;
          enriched_at: string | null;
          keywords_fetched_at: string;
        } | undefined;
        const paperId = existing?.paper_id ?? `doi:${doi}`;
        const hasPdf = existing
          ? Boolean(this.db.prepare("SELECT sha256 FROM paper_pdf WHERE paper_id = ?").get(paperId))
          : false;
        const nextAbstract = abstract !== undefined ? abstract : (existing?.abstract ?? "");
        const nextKeywords = keywords !== undefined ? keywords : (existing?.keywords ?? "");
        const nextMeshTerms = meshTerms !== undefined ? meshTerms : (existing?.mesh_terms ?? "");
        const enriched = abstract !== undefined || keywords !== undefined || meshTerms !== undefined;
        const nextEnrichedAt = enriched ? now : (existing?.enriched_at ?? null);
        const nextKeywordsFetchedAt = keywords !== undefined ? now : (existing?.keywords_fetched_at ?? "");
        if (hasPdf) {
          if (!enriched) {
            skipped += 1;
            continue;
          }
          this.db.prepare("UPDATE papers SET abstract = ?, keywords = ?, mesh_terms = ?, enriched_at = ?, keywords_fetched_at = ?, updated_at = ? WHERE paper_id = ?")
            .run(nextAbstract, nextKeywords, nextMeshTerms, nextEnrichedAt, nextKeywordsFetchedAt, now, paperId);
          updatedIds.push(paperId);
          continue;
        }
        if (!existing) {
          this.db.prepare(`
            INSERT INTO papers(paper_id, doi, title, abstract, keywords, mesh_terms, enriched_at, keywords_fetched_at, created_at, updated_at, metadata_uploaded_at, metadata_uploaded_by, metadata_role, metadata_channel)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin', 'admin_fetch')
          `).run(paperId, doi, title, nextAbstract, nextKeywords, nextMeshTerms, nextEnrichedAt, nextKeywordsFetchedAt, now, now, now, userId);
          createdIds.push(paperId);
        } else {
          this.db.prepare("UPDATE papers SET title = ?, abstract = ?, keywords = ?, mesh_terms = ?, enriched_at = ?, keywords_fetched_at = ?, updated_at = ? WHERE paper_id = ?")
            .run(title, nextAbstract, nextKeywords, nextMeshTerms, nextEnrichedAt, nextKeywordsFetchedAt, now, paperId);
          this.stampPaperMetadataIfEmpty(paperId, metadataStampFromAction(userId, "admin.papers.ingest_metadata", now));
          updatedIds.push(paperId);
        }
      }
      const touchedIds = [...createdIds, ...updatedIds];
      let receiptId = `metadata_${randomUUID()}`;
      const resourceId = touchedIds[0] ?? "catalog";
      if (touchedIds.length === 0) {
        this.db.prepare("INSERT INTO receipts(receipt_id, user_id, action, paper_id, sha256, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
          .run(receiptId, userId, "admin.papers.ingest_metadata", resourceId, now);
      } else {
        receiptId = "";
        for (const paperId of touchedIds) {
          const paperReceiptId = `metadata_${randomUUID()}`;
          if (!receiptId) receiptId = paperReceiptId;
          this.db.prepare("INSERT INTO receipts(receipt_id, user_id, action, paper_id, sha256, created_at) VALUES (?, ?, ?, ?, NULL, ?)")
            .run(paperReceiptId, userId, "admin.papers.ingest_metadata", paperId, now);
        }
      }
      this.insertAudit({ requestId, userId, action: "admin.papers.ingest_metadata", resourceId, result: "ok", receiptId, createdAt: now, host });
      this.db.exec("COMMIT");
      const items = [...createdIds, ...updatedIds].map((paperId) => this.getPaper(paperId));
      return { receiptId, data: { created: createdIds.length, updated: updatedIds.length, skipped, items } };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordImport(userId: string, requestId: string, paper: { doi: string; title: string }, asset: { sha256: string; byteSize: number; pageCount: number; verifiedAt: string }, host?: AuditHost) {
    return this.recordImportWithAction(userId, requestId, "papers.import_local", "import", paper, asset, host);
  }

  recordCorpusImport(userId: string, requestId: string, paper: { doi: string; title: string }, asset: { sha256: string; byteSize: number; pageCount: number; verifiedAt: string }, host?: AuditHost) {
    return this.recordImportWithAction(userId, requestId, "admin.papers.ingest_corpus", "corpus", paper, asset, host);
  }

  previewCorpusIngest(userId: string, preview: CorpusPreview) {
    return issueCorpusConfirmation(this.db, userId, preview);
  }

  validateCorpusImport(userId: string, token: string, preview: CorpusPreview) {
    assertCorpusConfirmation(this.db, userId, token, preview);
  }

  private recordImportWithAction(
    userId: string,
    requestId: string,
    action: string,
    receiptPrefix: string,
    paper: { doi: string; title: string },
    asset: { sha256: string; byteSize: number; pageCount: number; verifiedAt: string },
    host?: AuditHost,
  ) {
    const doi = canonicalIdentifier(paper.doi);
    const existing = this.db.prepare("SELECT paper_id, title FROM papers WHERE doi = ?").get(doi) as { paper_id: string; title: string } | undefined;
    const paperId = existing?.paper_id ?? `doi:${doi}`;
    const now = asset.verifiedAt;
    const stamp = metadataStampFromAction(userId, action, now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!existing) {
        this.db.prepare(`
          INSERT INTO papers(paper_id, doi, title, created_at, updated_at, metadata_uploaded_at, metadata_uploaded_by, metadata_role, metadata_channel)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(paperId, doi, paper.title, now, now, stamp.uploadedAt, stamp.uploadedBy, stamp.role, stamp.channel);
      } else {
        this.db.prepare("UPDATE papers SET updated_at = ? WHERE paper_id = ?").run(now, paperId);
        this.stampPaperMetadataIfEmpty(paperId, stamp);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const linked = this.linkPdfVersion(userId, requestId, action, receiptPrefix, paperId, asset, host);
    return { receiptId: linked.receiptId, alreadyPresent: linked.alreadyPresent, data: this.getPaper(paperId) };
  }

  recordRead(userId: string, requestId: string, action: string, resourceId: string, result: string, host?: AuditHost) {
    this.insertAudit({ requestId, userId, action, resourceId, result, host });
  }

  listDirectoryUsers(accounts: DirectoryAccount[]): DirectoryUserList {
    const lastSeen = new Map(
      (this.db.prepare("SELECT user_id, max(created_at) AS last_seen FROM audit_events GROUP BY user_id").all() as Array<{ user_id: string; last_seen: string }>)
        .map((row) => [row.user_id, row.last_seen]),
    );
    const items = accounts.map((account) => ({
      userId: account.userId,
      ...(account.displayName ? { displayName: account.displayName } : {}),
      role: directoryRole(account.scopes),
      ...(lastSeen.get(account.userId) ? { lastSeenAt: lastSeen.get(account.userId) } : {}),
    }));
    items.sort((left, right) => (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? "") || left.userId.localeCompare(right.userId));
    return { items, total: items.length };
  }

  getUserFolder(userId: string, accounts: DirectoryAccount[]): DirectoryUserFolder {
    const account = accounts.find((item) => item.userId === userId);
    if (!account) throw new CenterError("not_found", "No user matches the supplied identifier.", 404);
    const summary = this.listDirectoryUsers([account]).items[0]!;
    const agentRows = this.db.prepare(`
      SELECT host, max(created_at) AS last_seen
      FROM audit_events
      WHERE user_id = ? AND host IS NOT NULL AND host != ''
      GROUP BY host
      ORDER BY last_seen DESC
    `).all(userId) as Array<{ host: AuditHost; last_seen: string }>;
    const paperPlaceholders = PAPER_REQUEST_ACTIONS.map(() => "?").join(", ");
    const searchPlaceholders = SEARCH_ACTIONS.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT action, resource_id, created_at, host
      FROM audit_events
      WHERE user_id = ?
        AND resource_id IS NOT NULL AND resource_id != ''
        AND (
          (action IN (${searchPlaceholders}) AND resource_id != '*')
          OR action IN (${paperPlaceholders})
        )
      ORDER BY created_at DESC
      LIMIT ${ACTIVITY_EVENT_LIMIT}
    `).all(userId, ...SEARCH_ACTIONS, ...PAPER_REQUEST_ACTIONS) as Array<{ action: string; resource_id: string; created_at: string; host: string | null }>;
    const activity: DirectoryActivity[] = [];
    for (const row of [...rows].reverse()) {
      if ((SEARCH_ACTIONS as readonly string[]).includes(row.action)) {
        const query = row.resource_id.trim();
        if (query === "" || query === "*") continue;
        const last = activity[activity.length - 1];
        if (last?.kind === "search" && Date.parse(row.created_at) - Date.parse(last.endedAt) <= SEARCH_GROUP_MS) {
          last.count += 1;
          last.endedAt = row.created_at;
          if (!last.queries.includes(query)) last.queries.push(query);
        } else {
          activity.push({ kind: "search", queries: [query], startedAt: row.created_at, endedAt: row.created_at, count: 1 });
        }
        continue;
      }
      const paper = this.db.prepare("SELECT paper_id, doi, title FROM papers WHERE paper_id = ? OR doi = ?").get(row.resource_id, canonicalIdentifier(row.resource_id)) as { paper_id: string; doi: string; title: string } | undefined;
      activity.push({
        kind: "paper",
        paperId: paper?.paper_id ?? row.resource_id,
        ...(paper?.doi ? { doi: paper.doi } : {}),
        ...(paper?.title ? { title: paper.title } : {}),
        action: row.action,
        at: row.created_at,
        ...(row.host && (row.host as string) !== "" ? { host: row.host as AuditHost } : {}),
      });
    }
    activity.reverse();
    const papers = new Map<string, DirectoryPaper>();
    for (const item of activity) {
      if (item.kind !== "paper") continue;
      const existing = papers.get(item.paperId);
      if (!existing) {
        papers.set(item.paperId, {
          paperId: item.paperId,
          ...(item.doi ? { doi: item.doi } : {}),
          ...(item.title ? { title: item.title } : {}),
          lastRequestedAt: item.at,
          actions: [item.action],
        });
        continue;
      }
      if (!existing.actions.includes(item.action)) existing.actions.push(item.action);
    }
    return {
      ...summary,
      agents: agentRows.map((row) => ({ host: row.host, lastSeenAt: row.last_seen })),
      papers: [...papers.values()],
      activity,
    };
  }

  private insertAudit(input: {
    requestId: string;
    userId: string;
    action: string;
    resourceId?: string;
    result: string;
    receiptId?: string;
    createdAt?: string;
    host?: AuditHost;
  }) {
    this.db.prepare(`
      INSERT INTO audit_events(event_id, request_id, user_id, action, resource_id, result, receipt_id, created_at, host)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      input.requestId,
      input.userId,
      input.action,
      input.resourceId ?? null,
      input.result,
      input.receiptId ?? null,
      input.createdAt ?? new Date().toISOString(),
      input.host ?? null,
    );
  }

  objectPath(paperId: string, sha256?: string) {
    const rows = this.db.prepare(`
      SELECT o.sha256, o.byte_size
      FROM paper_pdf pp JOIN pdf_objects o ON o.sha256 = pp.sha256
      WHERE pp.paper_id = ?
      ORDER BY pp.updated_at ASC, pp.sha256 ASC
    `).all(paperId) as Array<{ sha256: string; byte_size: number }>;
    if (rows.length === 0) throw new CenterError("not_found", "The center does not have a verified PDF for this paper.", 404);
    let row = rows[0]!;
    if (rows.length > 1) {
      if (!sha256) throw new CenterError("validation_failed", "sha256 is required when multiple PDF versions exist for this paper.", 400);
      const match = rows.find((entry) => entry.sha256 === sha256);
      if (!match) throw new CenterError("not_found", "No matching PDF version exists for this paper.", 404);
      row = match;
    } else if (sha256 && sha256 !== row.sha256) {
      throw new CenterError("not_found", "No matching PDF version exists for this paper.", 404);
    }
    return {
      sha256: row.sha256,
      byteSize: row.byte_size,
      path: resolve(this.rootDir, "objects/sha256", row.sha256.slice(0, 2), row.sha256.slice(2, 4), `${row.sha256}.pdf`),
    };
  }
}
