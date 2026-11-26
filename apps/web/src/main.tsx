import { StrictMode, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { dentalbookStyles, PaperSourceLinks, StatusPill } from "@dentalbook/ui-kit";
import { DocsView, parseDocSection, type DocSectionId } from "./docs";

type PdfStatus = "central_cached" | "metadata_only" | "missing";
type PaperUpload = { role: "admin" | "user"; uploadedBy: string; uploadedAt: string; channel: "admin_fetch" | "user_import" };
type PaperPdfVersion = {
  sha256: string;
  byteSize: number;
  pageCount: number;
  mimeVerified: boolean;
  verifiedAt: string;
  pdfUpload?: PaperUpload;
};
type PaperItem = {
  paper: { paperId: string; doi: string; title: string; keywords?: string[]; keywordsStatus?: "hit" | "empty" | "none" };
  pdfProof: { status: PdfStatus; fileSha256?: string; byteSize?: number; mimeVerified: boolean };
  pdfs?: PaperPdfVersion[];
  metadataUpload?: PaperUpload;
  pdfUpload?: PaperUpload;
};
type LibraryResult = {
  ok: boolean;
  items: PaperItem[];
  total: number;
  limit: number;
  offset: number;
  stats: { sharedPapers: number; sharedPdfs: number; metadataOnly: number; localPdfs: number };
};
type AuthorWork = { doi: string; title: string; year?: number; byline?: string; matchBasis?: string; sources?: string[]; library?: PaperItem };
type AuthorNote = { noteId: string; kind: "mentorship" | "abbreviation" | "disambiguation"; body: string; createdBy: string; createdAt: string };
type AuthorRelation = {
  relationId: string;
  authorId: string;
  body?: string;
  mentor?: string;
  students?: string[];
  status: "pending" | "approved" | "rejected";
  submittedBy: string;
  submittedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
};
type Author = {
  authorId: string;
  name: string;
  displayNameZh?: string;
  displayNameEn?: string;
  institution?: string;
  identityStatus?: "imported" | "reviewed";
  englishNameVariants?: string[];
  paperCount: number;
  sourceStatuses?: Array<{ source: string; state: "hit" | "empty" | "none" }>;
  importEvents?: Array<{ eventId: string; source: string; kind: string; occurredAt: string; hitCount: number; empty: boolean; notes?: string }>;
  papers?: Array<{ paperId: string; doi: string; title: string }>;
  works?: AuthorWork[];
  notes?: AuthorNote[];
  relations?: AuthorRelation[];
};
type AuthorResult = { ok: boolean; items: Author[]; total: number; limit: number; offset: number };
type AuthorMergeSummary = {
  authorId: string;
  name: string;
  displayNameZh?: string;
  displayNameEn?: string;
  orcid?: string;
  openalexId?: string;
  status: "pending" | "confirmed" | "returned";
  identityPinned: boolean;
  sourcesComplete: boolean;
  workCount: number;
  updatedAt: string;
};
type AuthorMergeQuery = { source: string; queriedAt: string; hitCount: number; empty: boolean; error?: string };
type AuthorMergeRun = {
  runId: string;
  status: "pending" | "confirmed" | "returned";
  createdBy: string;
  createdAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  workCount: number;
  papersIngested: number;
  identityPinned: boolean;
  sourcesComplete: boolean;
  queries: AuthorMergeQuery[];
  conflicts: Array<{ kind: string; body: string }>;
  notes?: string;
};
type AuthorMergeDetail = { author: Author; latest: AuthorMergeRun; history: AuthorMergeRun[] };
type Session = {
  authenticated: boolean;
  userId?: string;
  displayName?: string;
  expiresAt?: string;
  canSubmitRelations?: boolean;
  canReviewRelations?: boolean;
  canReviewMerges?: boolean;
  canViewUsers?: boolean;
  mcpRelease?: {
    version: string;
    upgradeRecommended: boolean;
    upgradeRequired: boolean;
    upgradeHint: string;
    upgradeUrl: string;
    notes: string;
  };
};
type DirectoryUser = {
  userId: string;
  displayName?: string;
  role: "admin" | "user";
  lastSeenAt?: string;
};
type DirectoryAgent = { host: string; lastSeenAt: string };
type DirectoryPaper = { paperId: string; doi?: string; title?: string; lastRequestedAt: string; actions: string[] };
type DirectorySearchActivity = { kind: "search"; queries: string[]; startedAt: string; endedAt: string; count: number };
type DirectoryPaperActivity = { kind: "paper"; paperId: string; doi?: string; title?: string; action: string; at: string; host?: string };
type DirectoryActivity = DirectorySearchActivity | DirectoryPaperActivity;
type DirectoryUserFolder = DirectoryUser & { agents: DirectoryAgent[]; papers: DirectoryPaper[]; activity: DirectoryActivity[] };
type View = "library" | "authors" | "author-detail" | "author-merges" | "author-merge-detail" | "users" | "user-folder" | "docs";

const webStyles = `
  ${dentalbookStyles}
  body { min-width: 320px; background: #f4f7f2; }
  a { color: inherit; }
  .web-shell { min-height: 100vh; }
  .web-header { position: sticky; top: 0; z-index: 10; border-bottom: 1px solid #dce4dd; background: rgba(250,252,249,.94); backdrop-filter: blur(16px); }
  .web-header-inner { display: flex; align-items: center; justify-content: space-between; gap: 24px; width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 14px 0; }
  .web-brand { display: flex; align-items: center; gap: 11px; font-weight: 760; letter-spacing: -.02em; }
  .web-mark { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 11px; background: #0f766e; color: white; font-family: Georgia, serif; }
  .web-nav { display: flex; align-items: center; gap: 6px; }
  .web-nav a, .web-nav button { border: 0; border-radius: 10px; background: transparent; color: #5c6964; cursor: pointer; padding: 8px 11px; font: inherit; text-decoration: none; }
  .web-nav a[aria-current="page"], .web-nav button[aria-current="page"] { background: #e3f1ec; color: #0c665f; font-weight: 700; }
  .web-user { display: flex; align-items: center; gap: 10px; color: #68736f; font-size: 13px; }
  .web-user .web-button.secondary { padding: 6px 10px; font-size: 13px; }
  .web-upgrade-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; border-bottom: 1px solid #e8c9a8; background: #fff7ed; color: #8a4b1a; padding: 12px 16px; font-size: 14px; }
  .web-upgrade-banner a { color: #0f766e; font-weight: 700; text-decoration: none; }
  .web-upgrade-banner strong { font-weight: 800; }
  .web-main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 40px 0 64px; }
  .web-hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 24px; }
  .web-eyebrow { margin: 0 0 8px; color: #0f766e; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
  .web-hero h1 { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: clamp(32px, 5vw, 54px); font-weight: 500; letter-spacing: -.035em; }
  .web-hero p { max-width: 620px; margin: 12px 0 0; color: #68736f; line-height: 1.65; }
  .web-panel { border: 1px solid #dce4dd; border-radius: 18px; background: #fff; box-shadow: 0 18px 55px rgba(34,58,49,.07); }
  .web-stats { display: grid; grid-template-columns: repeat(3, 1fr); overflow: hidden; }
  .web-stat { padding: 20px 22px; border-right: 1px solid #e4e9e5; }
  .web-stat:last-child { border-right: 0; }
  .web-stat strong { display: block; font-family: Georgia, serif; font-size: 30px; font-weight: 500; }
  .web-stat span { color: #718079; font-size: 13px; }
  .web-toolbar { display: flex; gap: 10px; padding: 18px; border-top: 1px solid #e4e9e5; }
  .web-input { min-width: 0; flex: 1; border: 1px solid #cfd9d2; border-radius: 11px; background: #fbfcfa; color: #17211f; padding: 11px 13px; font: inherit; }
  .web-input:focus { outline: 3px solid #dcefeb; border-color: #0f766e; }
  .web-button, .web-download { display: inline-flex; align-items: center; justify-content: center; border: 1px solid #0f766e; border-radius: 11px; background: #0f766e; color: #fff; cursor: pointer; padding: 10px 14px; font: inherit; font-weight: 680; text-decoration: none; }
  .web-button.secondary { background: #fff; color: #0f766e; }
  .web-button.quiet { border-color: transparent; background: transparent; color: #68736f; padding: 6px 8px; font-size: 13px; }
  .web-button:disabled { cursor: wait; opacity: .55; }
  .web-list { display: grid; gap: 10px; margin-top: 16px; }
  .web-paper { display: grid; grid-template-columns: minmax(0,1fr) auto; align-items: center; gap: 22px; border: 1px solid #dce4dd; border-radius: 16px; background: #fff; padding: 18px 20px; }
  .web-paper h2 { margin: 0; font-family: Georgia, serif; font-size: 18px; font-weight: 550; line-height: 1.4; }
  .web-meta { margin: 7px 0 0; color: #718079; font-size: 12px; overflow-wrap: anywhere; }
  .web-paper .db-row { margin-top: 11px; }
  .web-paper-upload { margin: 10px 0 0; color: #718079; font-size: 12px; line-height: 1.6; }
  .web-paper-upload span { display: block; }
  .web-pdf-versions { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; }
  .web-pdf-versions li { display: grid; gap: 4px; padding: 10px; border: 1px solid #d8e3de; border-radius: 10px; background: #f8fbf9; font-size: 12px; color: #718079; }
  .web-pdf-versions .web-download { width: auto; justify-self: start; padding: 8px 12px; font-size: 13px; }
  .web-empty, .web-error { margin-top: 16px; border: 1px dashed #cfd9d2; border-radius: 16px; background: #fff; color: #68736f; padding: 28px; text-align: center; }
  .web-error { border-style: solid; border-color: #ecc9c2; background: #fff8f6; color: #8d3f32; }
  .web-login { display: grid; min-height: 100vh; place-items: center; padding: 24px; background: radial-gradient(circle at 20% 10%, #deeee7 0, transparent 34%), #f4f7f2; }
  .web-login-card { width: min(430px, 100%); border: 1px solid #d8e2da; border-radius: 22px; background: rgba(255,255,255,.96); padding: 32px; box-shadow: 0 24px 75px rgba(33,58,48,.12); }
  .web-login-card h1 { margin: 18px 0 8px; font-family: Georgia, serif; font-size: 34px; font-weight: 500; }
  .web-login-card p { margin: 0 0 22px; color: #68736f; line-height: 1.6; }
  .web-login-form { display: grid; gap: 12px; }
  .web-login-form label { color: #52605a; font-size: 13px; font-weight: 700; }
  .web-author-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
  .web-author { display: grid; gap: 8px; border: 1px solid #dce4dd; border-radius: 16px; background: #fff; padding: 20px; font: inherit; color: inherit; text-align: left; width: 100%; }
  .web-author:hover { border-color: #0f766e; }
  .web-author h2 { margin: 0; font-family: Georgia, serif; font-size: 20px; font-weight: 550; }
  .web-author p { min-height: 38px; margin: 8px 0 0; color: #718079; font-size: 13px; line-height: 1.5; }
  .web-author strong { color: #0f766e; font-size: 13px; }
  .web-author-open { border: 0; background: transparent; padding: 0; margin: 0; font: inherit; color: inherit; cursor: pointer; text-align: left; }
  .web-author-open:hover h2, .web-author-open:focus-visible h2 { color: #0f766e; }
  .web-author-open:focus-visible { outline: 2px solid #0f766e; outline-offset: 4px; border-radius: 8px; }
  .web-author small { display: block; margin-top: 4px; color: #5c6964; font-size: 13px; }
  .web-source-pills { display: flex; flex-wrap: wrap; gap: 6px; }
  .web-source-pill { display: inline-flex; align-items: center; border-radius: 999px; border: 1px solid; padding: 3px 8px; font-size: 11px; font-weight: 700; }
  .web-source-pill.hit { background: #ecfdf5; color: #0f766e; border-color: #0f766e; }
  .web-source-pill.empty { background: #fffbeb; color: #a16207; border-color: #f5d0a0; }
  .web-source-pill.none { background: #f4f6f4; color: #8b968f; border-color: #e4e9e5; }
  .web-author-imports { margin: 2px 0 0; color: #5c6964; font-size: 12px; }
  .web-author-imports summary { cursor: pointer; }
  .web-author-imports ol { margin: 8px 0 0; padding-left: 18px; }
  .web-author-imports li { margin: 0 0 4px; line-height: 1.5; }
  .web-folder-list { display: grid; gap: 10px; margin-top: 16px; }
  .web-folder { display: grid; grid-template-columns: auto minmax(0,1fr) auto; align-items: center; gap: 16px; width: 100%; border: 1px solid #dce4dd; border-radius: 16px; background: #fff; padding: 16px 18px; text-align: left; font: inherit; color: inherit; cursor: pointer; }
  .web-folder:hover, .web-folder:focus-visible { border-color: #0f766e; outline: none; }
  .web-folder-icon { display: grid; width: 40px; height: 32px; place-items: center; border-radius: 6px 6px 4px 4px; background: #f3ead2; box-shadow: inset 0 8px 0 #e8d7a8; color: #8a6a1a; font-size: 11px; font-weight: 800; }
  .web-folder h2 { margin: 0; font-family: Georgia, serif; font-size: 18px; font-weight: 550; }
  .web-folder-grid { display: grid; gap: 16px; margin-top: 16px; }
  .web-activity { display: grid; gap: 14px; }
  .web-activity-search { border: 1px solid #dcefeb; border-radius: 14px; background: #f6fbf8; padding: 14px 16px; box-shadow: inset 3px 0 0 #0f766e; }
  .web-activity-search .web-chips { margin-top: 10px; }
  .web-chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .web-chip { display: inline-flex; align-items: center; gap: 8px; border-radius: 999px; background: #e3f1ec; color: #0c665f; padding: 7px 12px; font-size: 13px; font-weight: 700; }
  .web-chip time { color: #5c6964; font-weight: 500; }
  .web-user-paper { display: grid; gap: 4px; border-top: 1px solid #e4e9e5; padding: 14px 0; }
  .web-user-paper:first-of-type { border-top: 0; padding-top: 0; }
  .web-user-paper h3 { margin: 0; font-size: 16px; font-weight: 650; }
  .web-merge-status { display: inline-flex; align-items: center; border-radius: 999px; padding: 4px 10px; font-size: 12px; font-weight: 700; }
  .web-merge-status.pending { background: #f3ead2; color: #8a6a1a; }
  .web-merge-status.confirmed { background: #e3f1ec; color: #0c665f; }
  .web-merge-status.returned { background: #f8e8e6; color: #9a3b32; }
  .web-merge-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .web-author-detail { display: grid; gap: 16px; }
  .web-author-section { padding: 22px; }
  .web-author-section h2 { margin: 0 0 12px; font-family: Georgia, serif; font-size: 20px; font-weight: 550; }
  .web-author-section ul { margin: 0; padding-left: 18px; color: #3e4a46; line-height: 1.7; }
  .web-author-work { border-top: 1px solid #e4e9e5; padding: 14px 0; }
  .web-author-work:first-of-type { border-top: 0; padding-top: 0; }
  .web-author-work h3 { margin: 0; font-size: 16px; font-weight: 650; }
  .web-author-papers { display: grid; gap: 14px; }
  .web-note { margin: 0 0 12px; color: #3e4a46; line-height: 1.6; }
  .web-relation { border-top: 1px solid #e4e9e5; padding: 16px 0; }
  .web-relation:first-of-type { border-top: 0; padding-top: 0; }
  .web-relation p { margin: 0 0 6px; color: #3e4a46; line-height: 1.6; }
  .web-relation-audit { margin: 8px 0 0; color: #718079; font-size: 12px; line-height: 1.6; }
  .web-relation-form { display: grid; gap: 10px; margin-top: 16px; padding-top: 16px; border-top: 1px solid #e4e9e5; }
  .web-relation-form label { color: #52605a; font-size: 13px; font-weight: 700; }
  .web-relation-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .web-login-links { margin: 18px 0 0; text-align: center; }
  .web-login-links a { color: #0f766e; font-size: 13px; font-weight: 700; text-decoration: none; }
  .docs-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); gap: 36px; align-items: start; }
  .docs-side { position: sticky; top: 84px; border: 1px solid #dce4dd; border-radius: 18px; background: #fff; padding: 18px 14px; }
  .docs-side-kicker { margin: 0 0 4px; color: #0f766e; font-size: 11px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
  .docs-side-title { margin: 0 0 12px; font-weight: 760; }
  .docs-toc { display: grid; gap: 4px; }
  .docs-toc button { border: 0; border-radius: 10px; background: transparent; color: #5c6964; cursor: pointer; padding: 9px 11px; text-align: left; font: inherit; }
  .docs-toc button[aria-current="page"] { background: #e3f1ec; color: #0c665f; font-weight: 700; }
  .docs-article { min-width: 0; padding-bottom: 48px; }
  .docs-lead { max-width: 720px; margin: 12px 0 28px; color: #68736f; line-height: 1.7; }
  .docs-section { margin: 0 0 36px; scroll-margin-top: 92px; }
  .docs-section h2 { margin: 0 0 12px; font-family: Georgia, serif; font-size: 28px; font-weight: 500; }
  .docs-section p, .docs-section li { color: #3e4a46; line-height: 1.7; }
  .docs-section ol, .docs-section ul { margin: 0 0 16px; padding-left: 20px; }
  .docs-section code { font-size: 13px; }
  .docs-code { margin: 14px 0 18px; overflow: hidden; border: 1px solid #dce4dd; border-radius: 14px; background: #121a18; color: #e8f3ee; }
  .docs-code-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #2a3834; color: #9db5ac; font-size: 12px; }
  .docs-code-bar .web-button.quiet { color: #d5ebe3; }
  .docs-code pre { margin: 0; overflow: auto; padding: 16px; font-size: 13px; line-height: 1.55; }
  .docs-code code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  @media (max-width: 760px) {
    .web-header-inner { align-items: flex-start; flex-wrap: wrap; }
    .web-user { width: 100%; justify-content: space-between; }
    .web-main { padding-top: 28px; }
    .web-hero { align-items: flex-start; flex-direction: column; }
    .web-stats { grid-template-columns: 1fr; }
    .web-stat { border-right: 0; border-bottom: 1px solid #e4e9e5; }
    .web-stat:last-child { border-bottom: 0; }
    .web-toolbar { flex-direction: column; }
    .web-paper { grid-template-columns: 1fr; }
    .web-download { width: 100%; }
    .web-author-grid { grid-template-columns: 1fr; }
    .web-folder-grid { grid-template-columns: 1fr; }
    .docs-layout { grid-template-columns: 1fr; }
    .docs-side { position: static; }
  }
`;

function docSectionFromLocation(): DocSectionId {
  const fromQuery = new URLSearchParams(window.location.search).get("section");
  if (fromQuery) return parseDocSection(fromQuery);
  const fromHash = window.location.hash.replace(/^#/, "");
  if (fromHash) return parseDocSection(fromHash);
  return "getting-started";
}

function pathToView(pathname: string): View {
  const path = pathname.replace(/\/+$/u, "") || "/";
  if (path === "/docs") return "docs";
  if (path.startsWith("/author-merges/") && path !== "/author-merges/") return "author-merge-detail";
  if (path === "/author-merges") return "author-merges";
  if (path.startsWith("/authors/") && path !== "/authors/") return "author-detail";
  if (path === "/authors") return "authors";
  if (path.startsWith("/users/") && path !== "/users/") return "user-folder";
  if (path === "/users") return "users";
  return "library";
}

function authorIdFromPath(pathname: string) {
  const path = pathname.replace(/\/+$/u, "");
  if (!path.startsWith("/authors/")) return "";
  return decodeURIComponent(path.slice("/authors/".length));
}

function mergeAuthorIdFromPath(pathname: string) {
  const path = pathname.replace(/\/+$/u, "");
  if (!path.startsWith("/author-merges/")) return "";
  return decodeURIComponent(path.slice("/author-merges/".length));
}

function userIdFromPath(pathname: string) {
  const path = pathname.replace(/\/+$/u, "");
  if (!path.startsWith("/users/")) return "";
  return decodeURIComponent(path.slice("/users/".length));
}

function viewToPath(view: View, section?: DocSectionId, entityId?: string) {
  if (view === "docs") return `/docs?section=${section ?? "getting-started"}`;
  if (view === "author-detail" && entityId) return `/authors/${encodeURIComponent(entityId)}`;
  if (view === "authors" || view === "author-detail") return "/authors";
  if (view === "author-merge-detail" && entityId) return `/author-merges/${encodeURIComponent(entityId)}`;
  if (view === "author-merges" || view === "author-merge-detail") return "/author-merges";
  if (view === "user-folder" && entityId) return `/users/${encodeURIComponent(entityId)}`;
  if (view === "users" || view === "user-folder") return "/users";
  return "/library";
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({ message: "服务器返回了无法读取的响应。" })) as { message?: string };
  if (!response.ok) throw new Error(body.message ?? `请求失败（${response.status}）`);
  return body as T;
}

function byteLabel(value?: number) {
  if (!value) return "";
  return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`;
}

function shaShort(sha256: string) {
  return `${sha256.slice(0, 8)}…${sha256.slice(-8)}`;
}

function PaperCard({ item }: { item: PaperItem }) {
  const versions = paperPdfVersions(item);
  const downloadable = versions.length > 0;
  return (
    <article className="web-paper">
      <div>
        <h2>{item.paper.title}</h2>
        <p className="web-meta">{item.paper.doi}</p>
        <PaperSourceLinks doi={item.paper.doi} />
        <div className="db-row">
          <StatusPill tone={downloadable ? "ok" : "warn"}>{downloadable ? "共享库可下载" : "仅题录"}</StatusPill>
          {versions.length > 1 ? <StatusPill>{versions.length} 个 PDF 版本</StatusPill> : null}
          {item.pdfProof.mimeVerified ? <StatusPill>PDF 已校验</StatusPill> : null}
          {versions.length === 1 && versions[0] ? <StatusPill>{byteLabel(versions[0].byteSize)}</StatusPill> : null}
        </div>
        <PaperKeywords paper={item.paper} />
        <p className="web-paper-upload">
          <span>{uploadStepLine("元信息上传", item.metadataUpload)}</span>
          {versions.length <= 1 ? <span>{uploadStepLine("PDF 上传", item.pdfUpload)}</span> : null}
        </p>
        {versions.length > 1 ? <ul className="web-pdf-versions">
          {versions.map((version) => <li key={version.sha256}>
            <span>{byteLabel(version.byteSize)} · {shaShort(version.sha256)}</span>
            {version.pdfUpload ? <span>{uploadStepLine("PDF 上传", version.pdfUpload)}</span> : null}
            <a className="web-download" href={`/web/api/v1/papers/${encodeURIComponent(item.paper.paperId)}/pdf?sha256=${encodeURIComponent(version.sha256)}`}>下载</a>
          </li>)}
        </ul> : null}
      </div>
      {downloadable && versions.length === 1
        ? <a className="web-download" href={`/web/api/v1/papers/${encodeURIComponent(item.paper.paperId)}/pdf`}>下载 PDF</a>
        : downloadable ? null : <button className="web-button secondary" disabled>暂无全文</button>}
    </article>
  );
}

function paperPdfVersions(item: PaperItem): PaperPdfVersion[] {
  if (item.pdfs?.length) return item.pdfs;
  if (item.pdfProof.status === "central_cached" && item.pdfProof.fileSha256) {
    return [{
      sha256: item.pdfProof.fileSha256,
      byteSize: item.pdfProof.byteSize ?? 0,
      pageCount: 0,
      mimeVerified: item.pdfProof.mimeVerified,
      verifiedAt: "",
      ...(item.pdfUpload ? { pdfUpload: item.pdfUpload } : {}),
    }];
  }
  return [];
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await requestJson<Session>("/web/api/session", { method: "POST", body: JSON.stringify({ token }) });
      setToken("");
      onLogin(session);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="web-login">
      <section className="web-login-card">
        <div className="web-mark">D</div>
        <h1>Dentalbook</h1>
        <p>进入共享口腔文献库。访问令牌只用于换取当前浏览器会话，不写入网页存储。</p>
        <form className="web-login-form" onSubmit={submit}>
          <label htmlFor="token">访问令牌</label>
          <input id="token" className="web-input" type="password" autoComplete="current-password" required value={token} onChange={(event) => setToken(event.target.value)} />
          <button className="web-button" disabled={busy}>{busy ? "正在验证…" : "进入文献库"}</button>
        </form>
        {error ? <div className="web-error" role="alert">{error}</div> : null}
        <p className="web-login-links"><a href="/docs?section=getting-started">MCP 接入文档</a></p>
      </section>
    </main>
  );
}

function LibraryView() {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<LibraryResult>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async (nextQuery = "") => {
    setBusy(true);
    setError("");
    try {
      setData(await requestJson<LibraryResult>(`/web/api/v1/papers?query=${encodeURIComponent(nextQuery)}&limit=50&offset=0`));
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const items = useMemo(() => data?.items ?? [], [data]);
  return (
    <>
      <section className="web-hero">
        <div><p className="web-eyebrow">Shared literature</p><h1>共享文献库</h1><p>浏览真实题录与中心 PDF 状态。网页下载不会改变其他设备的本机同步状态。</p></div>
      </section>
      <section className="web-panel">
        <div className="web-stats">
          <div className="web-stat"><strong>{data?.stats.sharedPapers ?? "—"}</strong><span>共享题录</span></div>
          <div className="web-stat"><strong>{data?.stats.sharedPdfs ?? "—"}</strong><span>可下载 PDF</span></div>
          <div className="web-stat"><strong>{data?.stats.metadataOnly ?? "—"}</strong><span>仅题录</span></div>
        </div>
        <form className="web-toolbar" onSubmit={(event) => { event.preventDefault(); void load(query); }}>
          <input className="web-input" aria-label="搜索文献" placeholder="按标题、DOI 或 paperId 搜索" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="web-button" disabled={busy}>{busy ? "读取中…" : "搜索"}</button>
        </form>
      </section>
      {error ? <div className="web-error" role="alert">{error}</div> : null}
      {!busy && !error && items.length === 0 ? <div className="web-empty">当前筛选没有文献。</div> : null}
      <section className="web-list" aria-label="文献列表">
        {items.map((item) => <PaperCard key={item.paper.paperId} item={item} />)}
      </section>
    </>
  );
}

function AuthorsView({ onOpen, canReviewMerges }: { onOpen: (authorId: string) => void; canReviewMerges?: boolean }) {
  const [query, setQuery] = useState("");
  const [data, setData] = useState<AuthorResult>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const load = useCallback(async (nextQuery = "") => {
    setBusy(true);
    setError("");
    try {
      setData(await requestJson<AuthorResult>(`/web/api/v1/authors?query=${encodeURIComponent(nextQuery)}&limit=60&offset=0`));
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  return (
    <>
      <section className="web-hero">
        <div><p className="web-eyebrow">Author index</p><h1>作者库</h1><p>中文作者先看三层：中文名、英文别名合集、论文索引。作者关系由用户投稿、管理员审核后公开。判断文档由人工核验写入，不从 PDF 自动建档。</p></div>
      </section>
      <section className="web-panel">
        <form className="web-toolbar" onSubmit={(event) => { event.preventDefault(); void load(query); }}>
          <input className="web-input" aria-label="搜索作者" placeholder="按作者或机构搜索" value={query} onChange={(event) => setQuery(event.target.value)} />
          <button className="web-button" disabled={busy}>{busy ? "读取中…" : "搜索"}</button>
        </form>
      </section>
      {error ? <div className="web-error" role="alert">{error}</div> : null}
      {!busy && !error && (data?.items.length ?? 0) === 0 ? <div className="web-empty">当前数据库还没有作者记录。</div> : null}
      <section className="web-author-grid" aria-label="作者列表">
        {data?.items.map((author) => {
          const latest = author.importEvents?.[0];
          return (
            <article className="web-author" key={author.authorId}>
              <button type="button" className="web-author-open" onClick={() => onOpen(author.authorId)}>
                <h2>{author.displayNameZh || author.name}</h2>
                {author.displayNameZh && author.displayNameEn ? <small>{author.displayNameEn}</small> : null}
              </button>
              <p>{author.institution ?? "机构待补充"}</p>
              <SourcePills statuses={author.sourceStatuses} />
              {canReviewMerges && latest ? (
                <details className="web-author-imports" onClick={(event) => event.stopPropagation()}>
                  <summary>最近导入 {formatStamp(latest.occurredAt)}</summary>
                  <ol>
                    {(author.importEvents ?? []).map((event) => (
                      <li key={event.eventId}>
                        {importKindLabel(event.kind)} · {sourcePillLabel(event.source)} · {event.empty ? "0 篇" : `${event.hitCount} 篇`} · {formatStamp(event.occurredAt)}
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              <strong>{author.paperCount} 篇论文索引</strong>
            </article>
          );
        })}
      </section>
    </>
  );
}

function uploadChannelLabel(channel?: PaperUpload["channel"]) {
  if (channel === "admin_fetch") return "admin fetch";
  if (channel === "user_import") return "用户本地上传";
  return "未知渠道";
}

function uploadStepLine(label: string, upload?: PaperUpload) {
  if (!upload) return `${label} · 尚无`;
  return `${label} · ${upload.role} · ${upload.uploadedBy} · ${formatStamp(upload.uploadedAt)} · ${uploadChannelLabel(upload.channel)}`;
}

function formatStamp(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

const AGENT_LABELS: Record<string, string> = {
  workbuddy: "WorkBuddy",
  trae: "Trae",
  cursor: "Cursor",
  codex: "Codex",
  claude: "Claude",
  qoder: "Qoder",
  admin: "Admin",
  web: "Web",
};

const PAPER_ACTION_LABELS: Record<string, string> = {
  "papers.get": "打开",
  "sync.pull_pdf": "下载",
  "papers.import_local": "上传",
  "web.papers.download": "网页下载",
  "admin.papers.fetch_fulltext": "管理员 Fetch",
};

function userLabel(user: Pick<DirectoryUser, "userId" | "displayName">) {
  return user.displayName || user.userId;
}

function roleLabel(role: DirectoryUser["role"]) {
  return role === "admin" ? "管理员" : "医生";
}

function agentLabel(host: string) {
  return AGENT_LABELS[host] ?? host;
}

function paperActionLabel(action: string) {
  return PAPER_ACTION_LABELS[action] ?? action;
}

function UsersView({ onOpen }: { onOpen: (userId: string) => void }) {
  const [data, setData] = useState<{ items: DirectoryUser[]; total: number }>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void requestJson<{ items: DirectoryUser[]; total: number }>("/web/api/v1/users")
      .then((result) => { if (!cancelled) setData(result); })
      .catch((reason) => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);
  const items = data?.items ?? [];
  return (
    <>
      <section className="web-hero">
        <div>
          <p className="web-eyebrow">Directory</p>
          <h1>用户请求记录</h1>
          <p>每个令牌用户一个文件夹。点进去看用过的 Agent，以及按时间交错的检索词和文献请求。</p>
        </div>
      </section>
      {error ? <div className="web-error" role="alert">{error}</div> : null}
      {busy ? <div className="web-empty">正在读取用户列表…</div> : null}
      {!busy && !error && items.length === 0 ? <div className="web-empty">还没有用户。</div> : null}
      <section className="web-folder-list" aria-label="用户列表">
        {items.map((user) => (
          <button key={user.userId} type="button" className="web-folder" onClick={() => onOpen(user.userId)}>
            <span className="web-folder-icon" aria-hidden="true">📁</span>
            <span>
              <h2>{userLabel(user)}</h2>
              <p className="web-meta">{roleLabel(user.role)} · {user.lastSeenAt ? `最近访问中心 ${formatStamp(user.lastSeenAt)}` : "尚未访问中心"}</p>
            </span>
            <span className="web-meta">{user.userId}</span>
          </button>
        ))}
      </section>
    </>
  );
}

function UserFolderView({ userId, onBack }: { userId: string; onBack: () => void }) {
  const [folder, setFolder] = useState<DirectoryUserFolder>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void requestJson<{ user: DirectoryUserFolder }>(`/web/api/v1/users/${encodeURIComponent(userId)}`)
      .then((result) => { if (!cancelled) setFolder(result.user); })
      .catch((reason) => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [userId]);
  return (
    <>
      <button type="button" className="web-button secondary web-back" onClick={onBack}>返回用户列表</button>
      <section className="web-hero">
        <div>
          <p className="web-eyebrow">User folder</p>
          <h1>{folder ? userLabel(folder) : userId}</h1>
          <p>{folder ? `${roleLabel(folder.role)} · ${folder.lastSeenAt ? `最近访问中心 ${formatStamp(folder.lastSeenAt)}` : "尚未访问中心"}` : "正在打开文件夹…"}</p>
        </div>
      </section>
      {error ? <div className="web-error" role="alert">{error}</div> : null}
      {folder ? <div className="web-folder-grid">
        <section className="web-panel web-author-section">
          <h2>用过的 Agent</h2>
          {folder.agents.length === 0 ? <p className="web-meta">还没有带宿主头的请求。旧审计仍会计入时间线，但不显示 Agent。</p> : (
            <div className="web-chips">
              {folder.agents.map((agent) => (
                <span key={agent.host} className="web-chip">{agentLabel(agent.host)}<time dateTime={agent.lastSeenAt}>{formatStamp(agent.lastSeenAt)}</time></span>
              ))}
            </div>
          )}
        </section>
        <section className="web-panel web-author-section">
          <h2>活动</h2>
          {folder.activity.length === 0 ? <p className="web-meta">还没有检索词或打开、下载、上传、管理员 Fetch 过的文献。空搜索不会出现在这里。</p> : (
            <div className="web-activity">
              {folder.activity.map((item, index) => item.kind === "search" ? (
                <article key={`search-${item.startedAt}-${index}`} className="web-activity-search">
                  <p className="web-meta">检索 · {item.startedAt === item.endedAt ? formatStamp(item.startedAt) : `${formatStamp(item.startedAt)} – ${formatStamp(item.endedAt)}`} · {item.count} 次</p>
                  <div className="web-chips">
                    {item.queries.map((query) => <span key={query} className="web-chip">{query}</span>)}
                  </div>
                </article>
              ) : (
                <article key={`paper-${item.paperId}-${item.at}-${item.action}-${index}`} className="web-user-paper">
                  <h3>{item.title ?? item.paperId}</h3>
                  <p className="web-meta">{paperActionLabel(item.action)}{item.doi ? ` · ${item.doi}` : ""} · {formatStamp(item.at)}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div> : null}
      {busy && !folder && !error ? <div className="web-empty">正在读取文件夹…</div> : null}
    </>
  );
}

function relationStatusLabel(status: AuthorRelation["status"]) {
  if (status === "approved") return "已通过";
  if (status === "rejected") return "已驳回";
  return "待审核";
}

function AuthorRelationCard({
  relation,
  canReview,
  busy,
  onReview,
}: {
  relation: AuthorRelation;
  canReview: boolean;
  busy: boolean;
  onReview: (relationId: string, decision: "approved" | "rejected") => void;
}) {
  return (
    <article className="web-relation">
      {relation.mentor ? <p>导师：{relation.mentor}</p> : null}
      {relation.students?.length ? <p>学生：{relation.students.join("、")}</p> : null}
      {relation.body ? <p>{relation.body}</p> : null}
      <p className="web-relation-audit">
        {relationStatusLabel(relation.status)} · 上传者 {relation.submittedBy} · {formatStamp(relation.submittedAt)}
        {relation.reviewedBy ? ` · 审核者 ${relation.reviewedBy} · ${formatStamp(relation.reviewedAt)}` : " · 尚未审核"}
      </p>
      {canReview && relation.status === "pending" ? <div className="web-relation-actions">
        <button type="button" className="web-button" disabled={busy} onClick={() => onReview(relation.relationId, "approved")}>通过</button>
        <button type="button" className="web-button secondary" disabled={busy} onClick={() => onReview(relation.relationId, "rejected")}>驳回</button>
      </div> : null}
    </article>
  );
}

function AuthorDetailView({ authorId, session, onBack }: { authorId: string; session: Session; onBack: () => void }) {
  const [author, setAuthor] = useState<Author>();
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [mentor, setMentor] = useState("");
  const [students, setStudents] = useState("");
  const [body, setBody] = useState("");
  const load = useCallback(() => {
    setBusy(true);
    setError("");
    return requestJson<AuthorDetailResult>(`/web/api/v1/authors/${encodeURIComponent(authorId)}`)
      .then((result) => setAuthor(result.author))
      .catch((reason) => setError(String(reason instanceof Error ? reason.message : reason)))
      .finally(() => setBusy(false));
  }, [authorId]);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError("");
    void requestJson<AuthorDetailResult>(`/web/api/v1/authors/${encodeURIComponent(authorId)}`)
      .then((result) => { if (!cancelled) setAuthor(result.author); })
      .catch((reason) => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [authorId]);
  async function submitRelation(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await requestJson(`/web/api/v1/authors/${encodeURIComponent(authorId)}/relations`, {
        method: "POST",
        body: JSON.stringify({
          mentor,
          body,
          students: students.split(/[,，、]/u).map((name) => name.trim()).filter(Boolean),
        }),
      });
      setMentor("");
      setStudents("");
      setBody("");
      await load();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  }
  async function reviewRelation(relationId: string, decision: "approved" | "rejected") {
    setSaving(true);
    setError("");
    try {
      await requestJson(`/web/api/v1/author-relations/${encodeURIComponent(relationId)}/review`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      await load();
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  }
  const variants = author?.englishNameVariants ?? [];
  const works = author?.works ?? [];
  const notes = author?.notes ?? [];
  const relations = author?.relations ?? [];
  return (
    <>
      <button type="button" className="web-button secondary web-back" onClick={onBack}>返回作者库</button>
      <section className="web-hero">
        <div>
          <p className="web-eyebrow">Author profile</p>
          <h1>{author?.displayNameZh || author?.name || "作者详情"}</h1>
          {author?.displayNameEn ? <p>{author.displayNameEn}</p> : null}
        </div>
      </section>
      {error ? <div className="web-error" role="alert">{error}</div> : null}
      {busy ? <div className="web-empty">正在读取作者档案…</div> : null}
      {!busy && author ? <div className="web-author-detail">
        <section className="web-panel web-author-section">
          <h2>中文名</h2>
          <p>{author.displayNameZh || "中文名待补充"}</p>
          <p className="web-meta">{author.institution ?? "机构待补充"}{author.identityStatus === "reviewed" ? " · 已核验" : " · 已导入未核验"}</p>
        </section>
        <section className="web-panel web-author-section">
          <h2>英文别名合集</h2>
          {author.displayNameEn ? <p>规范英文：{author.displayNameEn}</p> : <p>尚无已核验规范英文。</p>}
          {variants.length
            ? <ul>{variants.map((name) => <li key={name}>{name}</li>)}</ul>
            : <p className="web-meta">尚无观察署名。</p>}
        </section>
        <section className="web-panel web-author-section">
          <h2>论文索引</h2>
          <p className="web-meta">有 DOI 的作品按文献库对照，展示状态、原文链接和 PDF 下载；无 DOI 的只保留题名快照。</p>
          {works.length
            ? <div className="web-author-papers">
              {works.map((work) => work.library
                ? <PaperCard key={work.library.paper.paperId} item={work.library} />
                : <article className="web-author-work" key={`${work.doi}:${work.title}`}>
                  <h3>{work.title}</h3>
                  <p className="web-meta">{[work.year, work.doi || "无 DOI", work.byline].filter(Boolean).join(" · ")}</p>
                </article>)}
            </div>
            : <p className="web-meta">尚无可可靠对应的论文。</p>}
        </section>
        <section className="web-panel web-author-section">
          <h2>作者关系</h2>
          {relations.length
            ? relations.map((relation) => <AuthorRelationCard key={relation.relationId} relation={relation} canReview={Boolean(session.canReviewRelations)} busy={saving} onReview={reviewRelation} />)
            : <p className="web-meta">尚无已通过的作者关系。用户提交后需管理员审核才会公开显示。</p>}
          {session.canSubmitRelations ? <form className="web-relation-form" onSubmit={submitRelation}>
            <label htmlFor="relation-mentor">导师</label>
            <input id="relation-mentor" className="web-input" value={mentor} onChange={(event) => setMentor(event.target.value)} placeholder="例如：俞光岩" />
            <label htmlFor="relation-students">学生</label>
            <input id="relation-students" className="web-input" value={students} onChange={(event) => setStudents(event.target.value)} placeholder="用顿号或逗号分隔，例如：章文博、张医生、贾凌飞" />
            <label htmlFor="relation-body">评论</label>
            <textarea id="relation-body" className="web-input" rows={3} value={body} onChange={(event) => setBody(event.target.value)} placeholder="对该作者关系的补充说明（可选）" />
            <button className="web-button" disabled={saving}>{saving ? "正在提交…" : "提交待审"}</button>
          </form> : <p className="web-meta">当前会话没有作者关系投稿权限。</p>}
        </section>
        {notes.length ? <section className="web-panel web-author-section">
          <h2>判断文档</h2>
          {notes.map((note) => <p className="web-note" key={note.noteId}><strong>{note.kind}</strong> {note.body}</p>)}
        </section> : null}
      </div> : null}
    </>
  );
}

function mergeStatusLabel(status: AuthorMergeSummary["status"]) {
  if (status === "confirmed") return "已确认";
  if (status === "returned") return "已退回";
  return "待审";
}

function mergeSourceLabel(source: string) {
  if (source === "v3") return "v3 名录";
  if (source === "orcid") return "ORCID";
  if (source === "openalex") return "OpenAlex";
  if (source === "crossref") return "Crossref";
  if (source === "pubmed") return "PubMed";
  return source;
}

const SOURCE_PILL_FALLBACK = [
  { source: "v3", state: "none" as const },
  { source: "orcid", state: "none" as const },
  { source: "openalex", state: "none" as const },
  { source: "crossref", state: "none" as const },
  { source: "pubmed", state: "none" as const },
];

function sourcePillLabel(source: string) {
  if (source === "v3") return "v3";
  if (source === "orcid") return "ORCID";
  if (source === "openalex") return "OpenAlex";
  if (source === "crossref") return "Crossref";
  if (source === "pubmed") return "PubMed";
  return source;
}

function importKindLabel(kind: string) {
  if (kind === "roster") return "名录导入";
  if (kind === "works") return "论文导入";
  if (kind === "merge_query") return "五路检索";
  return kind;
}

function PaperKeywords({ paper }: { paper: PaperItem["paper"] }) {
  const status = paper.keywordsStatus ?? "none";
  const terms = paper.keywords ?? [];
  return (
    <div className="web-source-pills" aria-label="关键词">
      {status === "hit" && terms.length
        ? terms.map((term) => <span key={term} className="web-source-pill hit">{term}</span>)
        : status === "empty"
          ? <span className="web-source-pill empty">keywords 没抓到</span>
          : <span className="web-source-pill none">keywords 没尝试过</span>}
    </div>
  );
}

function SourcePills({ statuses }: { statuses?: Array<{ source: string; state: "hit" | "empty" | "none" }> }) {
  const items = statuses && statuses.length ? statuses : SOURCE_PILL_FALLBACK;
  return (
    <div className="web-source-pills" aria-label="来源标签">
      {items.map((item) => (
        <span key={item.source} className={`web-source-pill ${item.state}`}>{sourcePillLabel(item.source)}</span>
      ))}
    </div>
  );
}

function AuthorMergesView({ onOpen }: { onOpen: (authorId: string) => void }) {
  const [data, setData] = useState<{ items: AuthorMergeSummary[]; total: number }>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void requestJson<{ items: AuthorMergeSummary[]; total: number }>("/web/api/v1/author-merges")
      .then((result) => { if (!cancelled) setData(result); })
      .catch((reason) => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);
  const items = data?.items ?? [];
  return (
    <>
      <section className="web-hero">
        <div>
          <p className="web-eyebrow">Author merge</p>
          <h1>作者消歧审核</h1>
          <p>查看每人是否已钉住身份、v3 与四源是否都问过、作品并集和冲突。确认后才算完成。医生作者页不显示这些检索日志。</p>
        </div>
      </section>
      {error ? <div className="web-error" role="alert">{error}</div> : null}
      {busy ? <div className="web-empty">正在读取合并记录…</div> : null}
      {!busy && !error && items.length === 0 ? <div className="web-empty">还没有作者合并记录。</div> : null}
      <section className="web-folder-list" aria-label="作者合并列表">
        {items.map((item) => (
          <button key={item.authorId} type="button" className="web-folder" onClick={() => onOpen(item.authorId)}>
            <span className={`web-merge-status ${item.status}`}>{mergeStatusLabel(item.status)}</span>
            <span>
              <h2>{item.displayNameZh || item.name}</h2>
              <p className="web-meta">{item.displayNameEn || item.authorId} · {item.workCount} 篇作品 · {item.identityPinned ? "人已钉住" : "人未钉住"} · {item.sourcesComplete ? "五路已问" : "五路未齐"}</p>
            </span>
            <span className="web-meta">{formatStamp(item.updatedAt)}</span>
          </button>
        ))}
      </section>
    </>
  );
}

function AuthorMergeDetailView({ authorId, onBack }: { authorId: string; onBack: () => void }) {
  const [data, setData] = useState<AuthorMergeDetail>();
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  function load() {
    return requestJson<AuthorMergeDetail>(`/web/api/v1/author-merges/${encodeURIComponent(authorId)}`)
      .then(setData);
  }
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void load()
      .catch((reason) => { if (!cancelled) setError(String(reason instanceof Error ? reason.message : reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [authorId]);
  async function review(decision: "confirmed" | "returned") {
    setSaving(true);
    setError("");
    try {
      const result = await requestJson<{ data: AuthorMergeDetail }>(`/web/api/v1/author-merges/${encodeURIComponent(authorId)}/review`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      setData(result.data);
    } catch (reason) {
      setError(String(reason instanceof Error ? reason.message : reason));
    } finally {
      setSaving(false);
    }
  }
  const latest = data?.latest;
  const works = data?.author.works ?? [];
  return (
    <>
      <button type="button" className="web-button secondary web-back" onClick={onBack}>返回审核列表</button>
      <section className="web-hero">
        <div>
          <p className="web-eyebrow">Merge review</p>
          <h1>{data?.author.displayNameZh || data?.author.name || authorId}</h1>
          <p>{data?.author.displayNameEn || data?.author.authorId} · {latest ? mergeStatusLabel(latest.status) : "读取中"}</p>
        </div>
      </section>
      {error ? <div className="web-error" role="alert">{error}</div> : null}
      {busy ? <div className="web-empty">正在读取合并详情…</div> : null}
      {latest ? <div className="web-author-detail">
        <section className="web-panel web-author-section">
          <h2>完成条件</h2>
          <ul>
            <li>人已钉住：{latest.identityPinned ? "是" : "否"}{data?.author.orcid ? ` · ORCID ${data.author.orcid}` : ""}{data?.author.openalexId ? ` · OpenAlex ${data.author.openalexId}` : ""}</li>
            <li>五路都问过：{latest.sourcesComplete ? "是" : "否"}</li>
            <li>作品并集：{latest.workCount} 篇 · 本次补进题录 {latest.papersIngested} 篇</li>
            <li>操作者 {latest.createdBy} · {formatStamp(latest.createdAt)}{latest.reviewedBy ? ` · 审核 ${latest.reviewedBy} ${formatStamp(latest.reviewedAt ?? "")}` : ""}</li>
          </ul>
          {latest.status !== "confirmed" ? <div className="web-merge-actions">
            <button className="web-button" disabled={saving} onClick={() => { void review("confirmed"); }}>确认完成</button>
            <button className="web-button secondary" disabled={saving} onClick={() => { void review("returned"); }}>退回待审</button>
          </div> : <div className="web-merge-actions">
            <button className="web-button secondary" disabled={saving} onClick={() => { void review("returned"); }}>退回待审</button>
          </div>}
        </section>
        <section className="web-panel web-author-section">
          <h2>各源检索</h2>
          {latest.queries.length === 0 ? <p className="web-meta">没有检索记录。</p> : latest.queries.map((query) => (
            <p className="web-note" key={query.source}>
              <strong>{mergeSourceLabel(query.source)}</strong>
              {query.empty ? " · 已查询无结果" : ` · ${query.hitCount} 条`}
              {query.error ? ` · ${query.error}` : ""}
              <small> {formatStamp(query.queriedAt)}</small>
            </p>
          ))}
        </section>
        <section className="web-panel web-author-section">
          <h2>冲突</h2>
          {latest.conflicts.length === 0 ? <p className="web-meta">没有冲突。</p> : latest.conflicts.map((conflict) => (
            <p className="web-note" key={`${conflict.kind}:${conflict.body}`}><strong>{conflict.kind}</strong> {conflict.body}</p>
          ))}
        </section>
        <section className="web-panel web-author-section">
          <h2>作品并集</h2>
          {works.length === 0 ? <p className="web-meta">还没有作品快照。</p> : works.map((work) => (
            <article className="web-author-work" key={`${work.doi}:${work.title}`}>
              <h3>{work.title}</h3>
              <p className="web-meta">{[work.year, work.doi, work.byline, (work.sources ?? []).map(mergeSourceLabel).join(" + ") || work.matchBasis].filter(Boolean).join(" · ")}</p>
            </article>
          ))}
        </section>
        {(data?.history.length ?? 0) > 1 ? <section className="web-panel web-author-section">
          <h2>历史</h2>
          {data?.history.map((run) => (
            <p className="web-note" key={run.runId}><strong>{mergeStatusLabel(run.status)}</strong> {run.createdBy} · {formatStamp(run.createdAt)} · {run.workCount} 篇</p>
          ))}
        </section> : null}
      </div> : null}
    </>
  );
}

function App() {
  const [session, setSession] = useState<Session>();
  const [view, setView] = useState<View>(() => pathToView(window.location.pathname));
  const [authorId, setAuthorId] = useState(() => authorIdFromPath(window.location.pathname) || mergeAuthorIdFromPath(window.location.pathname));
  const [folderUserId, setFolderUserId] = useState(() => userIdFromPath(window.location.pathname));
  const [section, setSection] = useState<DocSectionId>(() => docSectionFromLocation());
  const syncLocation = useCallback(() => {
    setView(pathToView(window.location.pathname));
    setAuthorId(authorIdFromPath(window.location.pathname) || mergeAuthorIdFromPath(window.location.pathname));
    setFolderUserId(userIdFromPath(window.location.pathname));
    setSection(docSectionFromLocation());
  }, []);
  useEffect(() => {
    void requestJson<Session>("/web/api/session").then(setSession).catch(() => setSession({ authenticated: false }));
  }, []);
  useEffect(() => {
    syncLocation();
    window.addEventListener("popstate", syncLocation);
    return () => window.removeEventListener("popstate", syncLocation);
  }, [syncLocation]);
  const go = useCallback((next: View, nextSection?: DocSectionId, entityId?: string) => {
    const resolved = nextSection ?? section;
    history.pushState({}, "", viewToPath(next, resolved, entityId));
    setView(next);
    if (nextSection) setSection(nextSection);
    setAuthorId(next === "author-detail" || next === "author-merge-detail" ? entityId ?? "" : "");
    setFolderUserId(next === "user-folder" ? entityId ?? "" : "");
  }, [section]);
  if (!session) return <main className="web-login"><div className="web-login-card">正在连接 Dentalbook…</div></main>;
  if (!session.authenticated && view !== "docs") return <Login onLogin={(next) => { setSession(next); go("library"); }} />;
  async function logout() {
    await requestJson<{ ok: true }>("/web/api/session", { method: "DELETE", body: "{}" });
    setSession({ authenticated: false });
    if (view !== "docs") go("library");
  }
  return (
    <div className="web-shell">
      <header className="web-header">
        <div className="web-header-inner">
          <div className="web-brand"><span className="web-mark">D</span><span>Dentalbook</span></div>
          <nav className="web-nav" aria-label="主要导航">
            {session.authenticated ? <>
              <a href="/library" aria-current={view === "library" ? "page" : undefined} onClick={(event) => { event.preventDefault(); go("library"); }}>文献库</a>
              <a href="/authors" aria-current={view === "authors" || view === "author-detail" ? "page" : undefined} onClick={(event) => { event.preventDefault(); go("authors"); }}>作者库</a>
            </> : null}
            <a href="/docs?section=getting-started" aria-current={view === "docs" ? "page" : undefined} onClick={(event) => { event.preventDefault(); go("docs", section); }}>文档</a>
          </nav>
          <div className="web-user">
            {session.authenticated
              ? <>
                  {session.canReviewMerges ? <button type="button" className="web-button secondary" aria-current={view === "author-merges" || view === "author-merge-detail" ? "page" : undefined} onClick={() => go("author-merges")}>作者消歧审核</button> : null}
                  {session.canViewUsers ? <button type="button" className="web-button secondary" aria-current={view === "users" || view === "user-folder" ? "page" : undefined} onClick={() => go("users")}>用户请求记录</button> : null}
                  <span>{session.displayName || session.userId}</span>
                  <button className="web-button quiet" onClick={() => { void logout(); }}>退出</button>
                </>
              : <button className="web-button quiet" onClick={() => { history.pushState({}, "", "/"); setView("library"); }}>登录</button>}
          </div>
        </div>
      </header>
      {session.authenticated && session.mcpRelease?.upgradeRequired ? (
        <div className="web-upgrade-banner" role="status">
          <strong>MCP 必须升级（{session.mcpRelease.version}）</strong>
          <span>{session.mcpRelease.upgradeHint || "请打开文档并按升级步骤重跑 install 脚本，然后重载 MCP。"}</span>
          <a href="/docs#upgrade" onClick={(event) => { event.preventDefault(); go("docs", "upgrade"); }}>查看升级说明</a>
        </div>
      ) : null}
      <main className="web-main">
        {view === "docs" ? <DocsView section={section} onSection={(id) => go("docs", id)} /> : null}
        {view === "library" && session.authenticated ? <LibraryView /> : null}
        {view === "authors" && session.authenticated ? <AuthorsView onOpen={(id) => go("author-detail", undefined, id)} canReviewMerges={session.canReviewMerges} /> : null}
        {view === "author-detail" && session.authenticated ? <AuthorDetailView authorId={authorId} session={session} onBack={() => go("authors")} /> : null}
        {view === "author-merges" && session.authenticated ? (session.canReviewMerges ? <AuthorMergesView onOpen={(id) => go("author-merge-detail", undefined, id)} /> : <div className="web-error" role="alert">当前会话没有作者消歧审核权限。</div>) : null}
        {view === "author-merge-detail" && session.authenticated ? (session.canReviewMerges ? <AuthorMergeDetailView authorId={authorId} onBack={() => go("author-merges")} /> : <div className="web-error" role="alert">当前会话没有作者消歧审核权限。</div>) : null}
        {view === "users" && session.authenticated ? (session.canViewUsers ? <UsersView onOpen={(id) => go("user-folder", undefined, id)} /> : <div className="web-error" role="alert">当前会话没有用户目录权限。</div>) : null}
        {view === "user-folder" && session.authenticated ? (session.canViewUsers ? <UserFolderView userId={folderUserId} onBack={() => go("users")} /> : <div className="web-error" role="alert">当前会话没有用户目录权限。</div>) : null}
      </main>
    </div>
  );
}

const style = document.createElement("style");
style.textContent = webStyles;
document.head.append(style);
const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
createRoot(root).render(<StrictMode><App /></StrictMode>);
