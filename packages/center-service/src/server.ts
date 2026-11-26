import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { AUDIT_HOSTS, AUTHOR_MERGE_SOURCES, DENTALBOOK_VERSION, type AuditHost, type AuthorMergeIngest, type AuthorMergeSource } from "@dentalbook/domain-contracts";
import { asCenterError, CenterError } from "./errors.js";
import { validateAndPromote, validateUploadedAndPromote } from "./pdf.js";
import { CenterStore } from "./store.js";

export type CenterUser = { userId: string; tokenSha256: string; scopes: string[]; displayName?: string };

export type CenterServerOptions = {
  rootDir: string;
  webDir?: string;
  releasesDir?: string;
  host?: string;
  port?: number;
  users: CenterUser[];
  tlsCertPath?: string;
  tlsKeyPath?: string;
  allowInsecureLoopback?: boolean;
};

export type McpReleasePublic = {
  version: string;
  upgradeRecommended: boolean;
  upgradeRequired: boolean;
  upgradeHint: string;
  upgradeUrl: string;
  notes: string;
};

type AuthenticatedUser = { userId: string; scopes: Set<string>; displayName?: string };
type WebSession = AuthenticatedUser & { expiresAt: number };
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const WEB_SESSION_SECONDS = 8 * 60 * 60;

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function equalHex(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

const DIRECTORY_AUDIT_SCOPES = ["admin:audit", "authors:admin", "fulltext:fetch"] as const;

function hasAnyScope(scopes: Iterable<string>, needed: string | readonly string[]) {
  const required = typeof needed === "string" ? [needed] : needed;
  const owned = scopes instanceof Set ? scopes : new Set(scopes);
  return required.some((scope) => owned.has(scope));
}

function authenticateToken(token: string, users: CenterUser[], scope: string | readonly string[]): AuthenticatedUser {
  const digest = tokenHash(token);
  const match = users.find((user) => equalHex(user.tokenSha256, digest));
  if (!match) throw new CenterError("forbidden", "The Bearer token is invalid.", 401);
  if (!hasAnyScope(match.scopes, scope)) {
    const label = typeof scope === "string" ? scope : scope.join(" or ");
    throw new CenterError("forbidden", `The token lacks the ${label} scope.`, 403);
  }
  return { userId: match.userId, scopes: new Set(match.scopes), ...(match.displayName ? { displayName: match.displayName } : {}) };
}

function auditHostFrom(request: IncomingMessage, channel: "web" | "mcp"): AuditHost | undefined {
  if (channel === "web") return "web";
  const raw = request.headers["x-dentalbook-host"];
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return (AUDIT_HOSTS as readonly string[]).includes(value) ? value as AuditHost : undefined;
}

function authenticate(request: IncomingMessage, users: CenterUser[], scope: string | readonly string[]): AuthenticatedUser {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) throw new CenterError("forbidden", "A Bearer token is required.", 401);
  return authenticateToken(value.slice("Bearer ".length), users, scope);
}

async function readJson(request: IncomingMessage, maxBytes = 64 * 1024) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new CenterError("validation_failed", "The request body is too large.", 413);
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new CenterError("validation_failed", "The request body must be valid JSON.", 400);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text), ...headers });
  response.end(text);
}

function cookieValue(request: IncomingMessage, name: string) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  for (const cookie of cookies) {
    const [key, ...parts] = cookie.trim().split("=");
    if (key === name) return parts.join("=");
  }
  return undefined;
}

function queryInteger(value: string | null, fallback: number, maximum: number) {
  if (value === null) return fallback;
  if (!/^\d+$/u.test(value)) throw new CenterError("validation_failed", `Expected an integer from 0 to ${maximum}.`, 400);
  return positiveInteger(Number(value), fallback, maximum);
}

function webSecurityHeaders(contentType: string) {
  return {
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

function identifierFrom(body: Record<string, unknown>) {
  if (typeof body.identifier !== "string" || body.identifier.trim() === "") {
    throw new CenterError("validation_failed", "identifier is required.", 400);
  }
  return body.identifier;
}

function asMergeSource(value: unknown): AuthorMergeSource | undefined {
  const source = String(value ?? "").trim().toLowerCase();
  return AUTHOR_MERGE_SOURCES.find((item) => item === source);
}

function positiveInteger(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new CenterError("validation_failed", `Expected an integer from 0 to ${maximum}.`, 400);
  }
  return value as number;
}

async function readMcpReleasePublic(releasesDir: string): Promise<McpReleasePublic | undefined> {
  try {
    const raw = JSON.parse(await readFile(resolve(releasesDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    if (typeof raw.version !== "string" || raw.version.trim() === "") return undefined;
    return {
      version: raw.version,
      upgradeRecommended: raw.upgradeRecommended === true,
      upgradeRequired: raw.upgradeRequired === true,
      upgradeHint: typeof raw.upgradeHint === "string" ? raw.upgradeHint : "",
      upgradeUrl: typeof raw.upgradeUrl === "string" && raw.upgradeUrl.trim() !== "" ? raw.upgradeUrl : "https://dentalbook.example.com/docs#upgrade",
      notes: typeof raw.notes === "string" ? raw.notes : "",
    };
  } catch {
    return undefined;
  }
}

function webSessionPayload(session: WebSession, mcpRelease?: McpReleasePublic) {
  return {
    authenticated: true as const,
    userId: session.userId,
    expiresAt: new Date(session.expiresAt).toISOString(),
    canSubmitRelations: session.scopes.has("authors:contribute"),
    canReviewRelations: session.scopes.has("authors:admin"),
    canReviewMerges: session.scopes.has("authors:admin"),
    canViewUsers: hasAnyScope(session.scopes, DIRECTORY_AUDIT_SCOPES),
    ...(session.displayName ? { displayName: session.displayName } : {}),
    ...(mcpRelease ? { mcpRelease } : {}),
  };
}

async function serveStaticFile(response: ServerResponse, filePath: string, contentType: string, cacheControl: string) {
  const data = await readFile(filePath);
  response.writeHead(200, { "content-type": contentType, "content-length": data.length, "cache-control": cacheControl });
  response.end(data);
}

async function serveStaticStream(response: ServerResponse, filePath: string, contentType: string, cacheControl: string) {
  const info = await stat(filePath);
  response.writeHead(200, { "content-type": contentType, "content-length": info.size, "cache-control": cacheControl });
  createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
}

async function receivePdf(request: IncomingMessage, rootDir: string) {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/pdf") throw new CenterError("validation_failed", "PDF uploads require content-type application/pdf.", 415);
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) throw new CenterError("validation_failed", "The uploaded PDF exceeds 100 MiB.", 413);
  const stagingRoot = resolve(rootDir, "staging");
  await mkdir(stagingRoot, { recursive: true, mode: 0o750 });
  const stagingPath = resolve(stagingRoot, `upload-${randomUUID()}.pdf`);
  const handle = await open(stagingPath, "wx", 0o640);
  let total = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_UPLOAD_BYTES) throw new CenterError("validation_failed", "The uploaded PDF exceeds 100 MiB.", 413);
      await handle.write(buffer);
    }
  } catch (error) {
    await handle.close();
    await unlink(stagingPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  if (total === 0) {
    await unlink(stagingPath).catch(() => undefined);
    throw new CenterError("validation_failed", "The uploaded PDF is empty.", 400);
  }
  return stagingPath;
}

function uploadMetadata(request: IncomingMessage) {
  const doiHeader = request.headers["x-dentalbook-doi"];
  const titleHeader = request.headers["x-dentalbook-title-base64"];
  const batchShaHeader = request.headers["x-dentalbook-batch-sha256"];
  const manifestShaHeader = request.headers["x-dentalbook-manifest-sha256"];
  const entryCountHeader = request.headers["x-dentalbook-entry-count"];
  const doi = typeof doiHeader === "string" && doiHeader.trim() !== "" ? doiHeader.trim() : undefined;
  let title: string | undefined;
  if (typeof titleHeader === "string" && titleHeader !== "") {
    try {
      title = Buffer.from(titleHeader, "base64url").toString("utf8");
    } catch {
      throw new CenterError("validation_failed", "The uploaded title header is invalid.", 400);
    }
  }
  const confirmationToken = typeof request.headers["x-dentalbook-confirmation-token"] === "string"
    ? request.headers["x-dentalbook-confirmation-token"].trim()
    : undefined;
  const batchSha256 = typeof batchShaHeader === "string" ? batchShaHeader.trim() : undefined;
  const manifestSha256 = typeof manifestShaHeader === "string" ? manifestShaHeader.trim() : undefined;
  const entryCount = typeof entryCountHeader === "string" && /^\d+$/u.test(entryCountHeader)
    ? Number(entryCountHeader)
    : undefined;
  return {
    ...(doi ? { doi } : {}),
    ...(title ? { title } : {}),
    ...(confirmationToken ? { confirmationToken } : {}),
    ...(batchSha256 ? { batchSha256 } : {}),
    ...(manifestSha256 ? { manifestSha256 } : {}),
    ...(entryCount !== undefined ? { entryCount } : {}),
  };
}

function corpusPreviewFromMetadata(metadata: ReturnType<typeof uploadMetadata>) {
  if (!metadata.confirmationToken || !metadata.batchSha256 || !metadata.manifestSha256 || metadata.entryCount === undefined) {
    throw new CenterError("validation_failed", "Corpus imports require confirmation and batch summary headers.", 400);
  }
  return {
    confirmationToken: metadata.confirmationToken,
    preview: {
      batchSha256: metadata.batchSha256,
      manifestSha256: metadata.manifestSha256,
      entryCount: metadata.entryCount,
    },
  };
}

export async function startCenterServer(options: CenterServerOptions) {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The test center service may only bind to a loopback host.");
  }
  const store = await CenterStore.open(options.rootDir);
  const webDir = options.webDir ? resolve(options.webDir) : undefined;
  const releasesDir = options.releasesDir ? resolve(options.releasesDir) : undefined;
  const webSessions = new Map<string, WebSession>();
  const webUser = (request: IncomingMessage, scope: string | readonly string[]) => {
    const sessionId = cookieValue(request, "dentalbook_session");
    const session = sessionId ? webSessions.get(sessionId) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (sessionId) webSessions.delete(sessionId);
      throw new CenterError("forbidden", "The web session is missing or expired.", 401);
    }
    if (!hasAnyScope(session.scopes, scope)) {
      const label = typeof scope === "string" ? scope : scope.join(" or ");
      throw new CenterError("forbidden", `The web session lacks the ${label} scope.`, 403);
    }
    return session;
  };
  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    try {
      const url = new URL(request.url ?? "/", "http://dentalbook.local");
      const host = url.pathname.startsWith("/web/") ? "web" : auditHostFrom(request, "mcp");
      const directoryAccounts = () => options.users.map((user) => ({
        userId: user.userId,
        scopes: user.scopes,
        ...(user.displayName ? { displayName: user.displayName } : {}),
      }));
      if (releasesDir && request.method === "GET" && url.pathname === "/releases/mcp-user/manifest.json") {
        await serveStaticFile(response, resolve(releasesDir, "manifest.json"), "application/json; charset=utf-8", "public, max-age=60");
        return;
      }
      if (releasesDir && request.method === "GET" && url.pathname === "/releases/mcp-user/latest.tar.gz") {
        await serveStaticStream(response, resolve(releasesDir, "latest.tar.gz"), "application/gzip", "public, max-age=300");
        return;
      }
      if (releasesDir && request.method === "GET" && url.pathname === "/install/mcp-user.sh") {
        await serveStaticFile(response, resolve(releasesDir, "install-mcp-user.sh"), "application/x-sh; charset=utf-8", "public, max-age=60");
        return;
      }
      if (webDir && request.method === "GET" && url.pathname === "/web/api/mcp-release") {
        const mcpRelease = releasesDir ? await readMcpReleasePublic(releasesDir) : undefined;
        if (!mcpRelease) throw new CenterError("not_found", "The MCP release manifest is unavailable.", 404);
        sendJson(response, 200, { ok: true, release: mcpRelease }, { "cache-control": "public, max-age=60" });
        return;
      }
      if (webDir && request.method === "GET" && url.pathname === "/web/api/session") {
        const sessionId = cookieValue(request, "dentalbook_session");
        const session = sessionId ? webSessions.get(sessionId) : undefined;
        if (!session || session.expiresAt <= Date.now()) {
          if (sessionId) webSessions.delete(sessionId);
          sendJson(response, 200, { authenticated: false }, { "cache-control": "no-store" });
          return;
        }
        const mcpRelease = releasesDir ? await readMcpReleasePublic(releasesDir) : undefined;
        sendJson(response, 200, webSessionPayload(session, mcpRelease), { "cache-control": "no-store" });
        return;
      }
      if (webDir && request.method === "POST" && url.pathname === "/web/api/session") {
        const body = await readJson(request);
        if (typeof body.token !== "string" || body.token.length < 1 || body.token.length > 4096) {
          throw new CenterError("validation_failed", "A valid access token is required.", 400);
        }
        const user = authenticateToken(body.token, options.users, "catalog:read");
        const sessionId = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
        const expiresAt = Date.now() + WEB_SESSION_SECONDS * 1000;
        webSessions.set(sessionId, { ...user, expiresAt });
        const hostHeader = request.headers.host?.split(":", 1)[0]?.toLowerCase();
        const secure = !options.allowInsecureLoopback
          || request.headers["x-forwarded-proto"] === "https"
          || !["127.0.0.1", "localhost", "[::1]"].includes(hostHeader ?? "");
        const mcpRelease = releasesDir ? await readMcpReleasePublic(releasesDir) : undefined;
        sendJson(response, 200, webSessionPayload({ ...user, expiresAt, scopes: user.scopes }, mcpRelease), {
          "cache-control": "no-store",
          "set-cookie": `dentalbook_session=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${WEB_SESSION_SECONDS}${secure ? "; Secure" : ""}`,
        });
        return;
      }
      if (webDir && request.method === "DELETE" && url.pathname === "/web/api/session") {
        const sessionId = cookieValue(request, "dentalbook_session");
        if (sessionId) webSessions.delete(sessionId);
        sendJson(response, 200, { ok: true }, { "cache-control": "no-store", "set-cookie": "dentalbook_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" });
        return;
      }
      if (webDir && request.method === "GET" && url.pathname === "/web/api/v1/papers") {
        const user = webUser(request, "catalog:read");
        const query = url.searchParams.get("query") ?? "";
        const limit = queryInteger(url.searchParams.get("limit"), 50, 100);
        const offset = queryInteger(url.searchParams.get("offset"), 0, 1_000_000);
        const result = store.listPapers(query, limit, offset);
        store.recordRead(user.userId, requestId, "web.papers.list", query || "*", "ok", host);
        sendJson(response, 200, { ok: true, ...result, stats: { ...store.stats(), localPdfs: 0 } }, { "cache-control": "private, no-store" });
        return;
      }
      if (webDir && request.method === "GET" && url.pathname === "/web/api/v1/authors") {
        const user = webUser(request, "catalog:read");
        const query = url.searchParams.get("query") ?? "";
        const limit = queryInteger(url.searchParams.get("limit"), 50, 100);
        const offset = queryInteger(url.searchParams.get("offset"), 0, 1_000_000);
        const result = store.listAuthors(query, limit, offset, { includeImportEvents: user.scopes.has("authors:admin") });
        store.recordRead(user.userId, requestId, "web.authors.list", query || "*", "ok", host);
        sendJson(response, 200, { ok: true, ...result }, { "cache-control": "private, no-store" });
        return;
      }
      const webAuthorMatch = webDir && request.method === "GET" ? url.pathname.match(/^\/web\/api\/v1\/authors\/([^/]+)$/u) : null;
      if (webAuthorMatch?.[1]) {
        const user = webUser(request, "catalog:read");
        const identifier = decodeURIComponent(webAuthorMatch[1]);
        const author = store.getAuthor(identifier, {
          viewerId: user.userId,
          includeAll: user.scopes.has("authors:admin"),
          includeImportEvents: user.scopes.has("authors:admin"),
        });
        store.recordRead(user.userId, requestId, "web.authors.get", author.authorId, "ok", host);
        sendJson(response, 200, { ok: true, author }, { "cache-control": "private, no-store" });
        return;
      }
      const webAuthorRelationMatch = webDir && request.method === "POST" ? url.pathname.match(/^\/web\/api\/v1\/authors\/([^/]+)\/relations$/u) : null;
      if (webAuthorRelationMatch?.[1]) {
        const user = webUser(request, "authors:contribute");
        const body = await readJson(request);
        const result = store.submitAuthorRelation(user.userId, requestId, {
          authorId: decodeURIComponent(webAuthorRelationMatch[1]),
          ...(typeof body.body === "string" ? { body: body.body } : {}),
          ...(typeof body.mentor === "string" ? { mentor: body.mentor } : {}),
          ...(Array.isArray(body.students) ? { students: body.students.filter((value): value is string => typeof value === "string") } : {}),
        }, host);
        sendJson(response, 200, { ok: true, ...result }, { "cache-control": "private, no-store" });
        return;
      }
      const webRelationReviewMatch = webDir && request.method === "POST" ? url.pathname.match(/^\/web\/api\/v1\/author-relations\/([^/]+)\/review$/u) : null;
      if (webRelationReviewMatch?.[1]) {
        const user = webUser(request, "authors:admin");
        const body = await readJson(request);
        if (body.decision !== "approved" && body.decision !== "rejected") {
          throw new CenterError("validation_failed", "Decision must be approved or rejected.", 400);
        }
        const result = store.reviewAuthorRelation(user.userId, requestId, decodeURIComponent(webRelationReviewMatch[1]), body.decision, host);
        sendJson(response, 200, { ok: true, ...result }, { "cache-control": "private, no-store" });
        return;
      }
      const webPdfMatch = webDir && request.method === "GET" ? url.pathname.match(/^\/web\/api\/v1\/papers\/([^/]+)\/pdf$/u) : null;
      if (webPdfMatch?.[1]) {
        const user = webUser(request, "fulltext:read");
        const paperId = decodeURIComponent(webPdfMatch[1]);
        const paper = store.getPaper(paperId).paper;
        const sha256 = url.searchParams.get("sha256")?.trim() || undefined;
        const object = store.objectPath(paperId, sha256);
        store.recordRead(user.userId, requestId, "web.papers.download", paperId, "ok", host);
        const filename = `${paper.title.replace(/[\r\n"\\/]+/gu, " ").slice(0, 120) || "dentalbook"}.pdf`;
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": object.byteSize,
          "content-disposition": `attachment; filename="dentalbook.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-dentalbook-sha256": object.sha256,
        });
        createReadStream(object.path).on("error", () => response.destroy()).pipe(response);
        return;
      }
      const appJs = webDir && request.method === "GET" ? url.pathname.match(/^\/(app(?:\.[a-f0-9]{8})?\.js)$/u) : null;
      if (webDir && appJs?.[1]) {
        const javascript = await readFile(resolve(webDir, appJs[1]));
        response.writeHead(200, { ...webSecurityHeaders("application/javascript; charset=utf-8"), "content-length": javascript.length });
        response.end(javascript);
        return;
      }
      if (webDir && request.method === "GET" && url.pathname === "/web/api/v1/author-merges") {
        const user = webUser(request, "authors:admin");
        const status = url.searchParams.get("status");
        const result = store.listAuthorMerges(status === "pending" || status === "confirmed" || status === "returned" ? status : undefined);
        store.recordRead(user.userId, requestId, "web.authors.list_merges", status || "*", "ok", host);
        sendJson(response, 200, { ok: true, ...result }, { "cache-control": "private, no-store" });
        return;
      }
      const webAuthorMergeMatch = webDir && request.method === "GET" ? url.pathname.match(/^\/web\/api\/v1\/author-merges\/([^/]+)$/u) : null;
      if (webAuthorMergeMatch?.[1]) {
        const user = webUser(request, "authors:admin");
        const merge = store.getAuthorMerge(decodeURIComponent(webAuthorMergeMatch[1]));
        store.recordRead(user.userId, requestId, "web.authors.get_merge", merge.author.authorId, "ok", host);
        sendJson(response, 200, { ok: true, ...merge }, { "cache-control": "private, no-store" });
        return;
      }
      const webAuthorMergeReviewMatch = webDir && request.method === "POST" ? url.pathname.match(/^\/web\/api\/v1\/author-merges\/([^/]+)\/review$/u) : null;
      if (webAuthorMergeReviewMatch?.[1]) {
        const user = webUser(request, "authors:admin");
        const body = await readJson(request);
        if (body.decision !== "confirmed" && body.decision !== "returned") {
          throw new CenterError("validation_failed", "Decision must be confirmed or returned.", 400);
        }
        const result = store.reviewAuthorMerge(user.userId, requestId, decodeURIComponent(webAuthorMergeReviewMatch[1]), body.decision, host);
        sendJson(response, 200, { ok: true, ...result }, { "cache-control": "private, no-store" });
        return;
      }
      if (webDir && request.method === "GET" && url.pathname === "/web/api/v1/users") {
        const user = webUser(request, DIRECTORY_AUDIT_SCOPES);
        const result = store.listDirectoryUsers(directoryAccounts());
        store.recordRead(user.userId, requestId, "admin.users.list", "*", "ok", host);
        sendJson(response, 200, { ok: true, ...result }, { "cache-control": "private, no-store" });
        return;
      }
      const webUserFolderMatch = webDir && request.method === "GET" ? url.pathname.match(/^\/web\/api\/v1\/users\/([^/]+)$/u) : null;
      if (webUserFolderMatch?.[1]) {
        const user = webUser(request, DIRECTORY_AUDIT_SCOPES);
        const folder = store.getUserFolder(decodeURIComponent(webUserFolderMatch[1]), directoryAccounts());
        store.recordRead(user.userId, requestId, "admin.users.get", folder.userId, "ok", host);
        sendJson(response, 200, { ok: true, user: folder }, { "cache-control": "private, no-store" });
        return;
      }
      if (webDir && request.method === "GET" && (["/", "/library", "/authors", "/docs", "/users", "/author-merges"].includes(url.pathname) || url.pathname.startsWith("/authors/") || url.pathname.startsWith("/users/") || url.pathname.startsWith("/author-merges/"))) {
        const html = await readFile(resolve(webDir, "index.html"));
        response.writeHead(200, { ...webSecurityHeaders("text/html; charset=utf-8"), "content-length": html.length });
        response.end(html);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/health") {
        const health = store.health();
        sendJson(response, 200, { ok: true, service: "dentalbook-center", version: DENTALBOOK_VERSION, businessReady: health.integrity === "ok", ...health });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/papers/get") {
        const user = authenticate(request, options.users, "catalog:read");
        const paper = store.getPaper(identifierFrom(await readJson(request)));
        store.recordRead(user.userId, requestId, "papers.get", paper.paper.paperId, "ok", host);
        sendJson(response, 200, { ok: true, ...paper });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/papers/list") {
        const user = authenticate(request, options.users, "catalog:read");
        const body = await readJson(request);
        const query = typeof body.query === "string" ? body.query : "";
        const limit = positiveInteger(body.limit, 50, 100);
        const offset = positiveInteger(body.offset, 0, 1_000_000);
        const result = store.listPapers(query, limit, offset);
        store.recordRead(user.userId, requestId, "papers.list", query || "*", "ok", host);
        sendJson(response, 200, { ok: true, ...result, stats: { ...store.stats(), localPdfs: 0 } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/papers/search") {
        const user = authenticate(request, options.users, "catalog:read");
        const body = await readJson(request);
        const author = typeof body.author === "string" ? body.author : "";
        const keywords = typeof body.keywords === "string" ? body.keywords : "";
        const limit = positiveInteger(body.limit, 50, 100);
        const offset = positiveInteger(body.offset, 0, 1_000_000);
        const result = store.searchPapers(author, keywords, limit, offset);
        store.recordRead(user.userId, requestId, "papers.search", `${author.trim()} AND ${keywords.trim()}`, "ok", host);
        sendJson(response, 200, { ok: true, ...result, stats: { ...store.stats(), localPdfs: 0 } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/library/stats") {
        const user = authenticate(request, options.users, "catalog:read");
        const stats = store.stats();
        store.recordRead(user.userId, requestId, "library.stats", "shared-library", "ok", host);
        sendJson(response, 200, { ok: true, ...stats, localPdfs: 0 });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/list") {
        const user = authenticate(request, options.users, "catalog:read");
        const body = await readJson(request);
        const query = typeof body.query === "string" ? body.query : "";
        const limit = positiveInteger(body.limit, 50, 100);
        const offset = positiveInteger(body.offset, 0, 1_000_000);
        const result = store.listAuthors(query, limit, offset, { includeImportEvents: user.scopes.has("authors:admin") });
        store.recordRead(user.userId, requestId, "authors.list", query || "*", "ok", host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/get") {
        const user = authenticate(request, options.users, "catalog:read");
        const author = store.getAuthor(identifierFrom(await readJson(request)), {
          includeImportEvents: user.scopes.has("authors:admin"),
        });
        store.recordRead(user.userId, requestId, "authors.get", author.authorId, "ok", host);
        sendJson(response, 200, { ok: true, author });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/submit-note") {
        const user = authenticate(request, options.users, "authors:contribute");
        const body = await readJson(request);
        if (typeof body.authorId !== "string" || body.authorId.trim() === "") throw new CenterError("validation_failed", "authorId is required.", 400);
        if (typeof body.kind !== "string") throw new CenterError("validation_failed", "kind is required.", 400);
        if (typeof body.body !== "string") throw new CenterError("validation_failed", "body is required.", 400);
        const result = store.submitAuthorNote(user.userId, requestId, { authorId: body.authorId, kind: body.kind as "mentorship" | "abbreviation" | "disambiguation", body: body.body }, host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/submit-relation") {
        const user = authenticate(request, options.users, "authors:contribute");
        const body = await readJson(request);
        if (typeof body.authorId !== "string" || body.authorId.trim() === "") throw new CenterError("validation_failed", "authorId is required.", 400);
        const result = store.submitAuthorRelation(user.userId, requestId, {
          authorId: body.authorId,
          ...(typeof body.body === "string" ? { body: body.body } : {}),
          ...(typeof body.mentor === "string" ? { mentor: body.mentor } : {}),
          ...(Array.isArray(body.students) ? { students: body.students.filter((value): value is string => typeof value === "string") } : {}),
        }, host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/relations") {
        const user = authenticate(request, options.users, "authors:admin");
        const body = await readJson(request);
        const result = store.listAuthorRelations({
          ...(typeof body.authorId === "string" ? { authorId: body.authorId } : {}),
          ...(body.status === "pending" || body.status === "approved" || body.status === "rejected" ? { status: body.status } : {}),
        });
        store.recordRead(user.userId, requestId, "admin.authors.list_relations", typeof body.authorId === "string" ? body.authorId : "*", "ok", host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/review-relation") {
        const user = authenticate(request, options.users, "authors:admin");
        const body = await readJson(request);
        if (typeof body.relationId !== "string" || body.relationId.trim() === "") throw new CenterError("validation_failed", "relationId is required.", 400);
        if (body.decision !== "approved" && body.decision !== "rejected") throw new CenterError("validation_failed", "Decision must be approved or rejected.", 400);
        const result = store.reviewAuthorRelation(user.userId, requestId, body.relationId, body.decision, host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/upsert") {
        const user = authenticate(request, options.users, "authors:admin");
        const body = await readJson(request);
        if (typeof body.authorId !== "string" || body.authorId.trim() === "") throw new CenterError("validation_failed", "authorId is required.", 400);
        const result = store.upsertAuthor(user.userId, requestId, {
          authorId: body.authorId,
          ...(typeof body.displayNameEn === "string" ? { displayNameEn: body.displayNameEn } : {}),
          ...(typeof body.institution === "string" ? { institution: body.institution } : {}),
          ...(Array.isArray(body.englishNameVariants) ? { englishNameVariants: body.englishNameVariants.filter((value): value is string => typeof value === "string") } : {}),
        }, host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/merges/list") {
        const user = authenticate(request, options.users, "authors:admin");
        const body = await readJson(request);
        const result = store.listAuthorMerges(body.status === "pending" || body.status === "confirmed" || body.status === "returned" ? body.status : undefined);
        store.recordRead(user.userId, requestId, "admin.authors.list_merges", typeof body.status === "string" ? body.status : "*", "ok", host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/merges/get") {
        const user = authenticate(request, options.users, "authors:admin");
        const body = await readJson(request);
        if (typeof body.authorId !== "string" || body.authorId.trim() === "") throw new CenterError("validation_failed", "authorId is required.", 400);
        const merge = store.getAuthorMerge(body.authorId);
        store.recordRead(user.userId, requestId, "admin.authors.get_merge", merge.author.authorId, "ok", host);
        sendJson(response, 200, { ok: true, ...merge });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/merges/ingest") {
        const user = authenticate(request, options.users, "authors:admin");
        const body = await readJson(request, 2 * 1024 * 1024);
        if (typeof body.authorId !== "string" || body.authorId.trim() === "") throw new CenterError("validation_failed", "authorId is required.", 400);
        if (!Array.isArray(body.works) || !Array.isArray(body.queries)) {
          throw new CenterError("validation_failed", "works and queries arrays are required.", 400);
        }
        const draft: AuthorMergeIngest = {
          authorId: body.authorId,
          ...(typeof body.displayNameZh === "string" ? { displayNameZh: body.displayNameZh } : {}),
          ...(typeof body.displayNameEn === "string" ? { displayNameEn: body.displayNameEn } : {}),
          ...(typeof body.institution === "string" ? { institution: body.institution } : {}),
          ...(typeof body.openalexId === "string" ? { openalexId: body.openalexId } : {}),
          ...(typeof body.orcid === "string" ? { orcid: body.orcid } : {}),
          ...(Array.isArray(body.englishNameVariants) ? { englishNameVariants: body.englishNameVariants.filter((value): value is string => typeof value === "string") } : {}),
          works: body.works.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object").map((work) => ({
            ...(typeof work.doi === "string" ? { doi: work.doi } : {}),
            title: typeof work.title === "string" ? work.title : "",
            ...(typeof work.year === "number" ? { year: work.year } : {}),
            ...(typeof work.byline === "string" ? { byline: work.byline } : {}),
            ...(typeof work.matchBasis === "string" ? { matchBasis: work.matchBasis } : {}),
            ...(Array.isArray(work.sources) ? { sources: work.sources.map(asMergeSource).filter((item): item is AuthorMergeSource => Boolean(item)) } : {}),
          })),
          queries: body.queries.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object").flatMap((query) => {
            const source = asMergeSource(query.source);
            if (!source) return [];
            return [{
              source,
              queriedAt: typeof query.queriedAt === "string" ? query.queriedAt : new Date().toISOString(),
              hitCount: Number(query.hitCount) || 0,
              empty: query.empty === true,
              ...(typeof query.error === "string" ? { error: query.error } : {}),
            }];
          }),
          ...(Array.isArray(body.conflicts) ? {
            conflicts: body.conflicts.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object").map((conflict) => ({
              kind: String(conflict.kind ?? ""),
              body: String(conflict.body ?? ""),
            })),
          } : {}),
          ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        };
        const result = store.ingestAuthorMerge(user.userId, requestId, draft, host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/works/ingest") {
        const user = authenticate(request, options.users, "authors:admin");
        const body = await readJson(request, 2 * 1024 * 1024);
        if (typeof body.authorId !== "string" || body.authorId.trim() === "") throw new CenterError("validation_failed", "authorId is required.", 400);
        if (!Array.isArray(body.works)) throw new CenterError("validation_failed", "works array is required.", 400);
        const result = store.ingestAuthorWorks(user.userId, requestId, {
          authorId: body.authorId,
          works: body.works.filter((value): value is Record<string, unknown> => value !== null && typeof value === "object").map((work) => ({
            ...(typeof work.doi === "string" ? { doi: work.doi } : {}),
            title: typeof work.title === "string" ? work.title : "",
            ...(typeof work.year === "number" ? { year: work.year } : {}),
            ...(typeof work.byline === "string" ? { byline: work.byline } : {}),
            ...(typeof work.matchBasis === "string" ? { matchBasis: work.matchBasis } : {}),
            ...(Array.isArray(work.sources) ? { sources: work.sources.map(asMergeSource).filter((item): item is AuthorMergeSource => Boolean(item)) } : {}),
          })),
          ...(typeof body.occurredAt === "string" ? { occurredAt: body.occurredAt } : {}),
          ...(typeof body.notes === "string" ? { notes: body.notes } : {}),
        }, host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/authors/merges/review") {
        const user = authenticate(request, options.users, "authors:admin");
        const body = await readJson(request);
        if (typeof body.authorId !== "string" || body.authorId.trim() === "") throw new CenterError("validation_failed", "authorId is required.", 400);
        if (body.decision !== "confirmed" && body.decision !== "returned") throw new CenterError("validation_failed", "Decision must be confirmed or returned.", 400);
        const result = store.reviewAuthorMerge(user.userId, requestId, body.authorId, body.decision, host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/papers/ingest-metadata") {
        const user = authenticate(request, options.users, "fulltext:fetch");
        const body = await readJson(request, 2 * 1024 * 1024);
        if (!Array.isArray(body.papers)) throw new CenterError("validation_failed", "papers must be an array.", 400);
        const result = store.ingestMetadata(user.userId, requestId, body.papers, host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/papers/fetch-fulltext") {
        const user = authenticate(request, options.users, "fulltext:fetch");
        const paper = store.getPaper(identifierFrom(await readJson(request)));
        const fixture = store.getFixture(paper.paper.paperId);
        if (store.hasPdfVersion(paper.paper.paperId, fixture.sha256)) {
          const result = store.recordIngest(user.userId, requestId, paper.paper.paperId, {
            sha256: fixture.sha256,
            byteSize: fixture.byteSize,
            pageCount: fixture.pageCount,
            verifiedAt: new Date().toISOString(),
          }, host);
          sendJson(response, 200, { ok: true, receiptId: result.receiptId, alreadyPresent: result.alreadyPresent, data: result.data });
          return;
        }
        const asset = await validateAndPromote(store.rootDir, fixture);
        const result = store.recordIngest(user.userId, requestId, paper.paper.paperId, asset, host);
        sendJson(response, 200, { ok: true, receiptId: result.receiptId, alreadyPresent: result.alreadyPresent, data: result.data });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/papers/ingest-corpus/preview") {
        const user = authenticate(request, options.users, "fulltext:fetch");
        const body = await readJson(request);
        const batchSha256 = typeof body.batchSha256 === "string" ? body.batchSha256.trim() : "";
        const manifestSha256 = typeof body.manifestSha256 === "string" ? body.manifestSha256.trim() : "";
        const entryCount = positiveInteger(body.entryCount, 0, 100_000);
        if (!/^[a-f0-9]{64}$/u.test(batchSha256) || !/^[a-f0-9]{64}$/u.test(manifestSha256) || entryCount < 1) {
          throw new CenterError("validation_failed", "batchSha256, manifestSha256, and entryCount are required.", 400);
        }
        const issued = store.previewCorpusIngest(user.userId, { batchSha256, manifestSha256, entryCount });
        sendJson(response, 200, {
          ok: true,
          errorCode: "confirmation_required",
          message: "Confirm this corpus batch before importing PDFs.",
          confirmationToken: issued.confirmationToken,
          expiresAt: issued.expiresAt,
          summary: issued.summary,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/papers/import") {
        const metadata = uploadMetadata(request);
        const corpus = metadata.confirmationToken ? corpusPreviewFromMetadata(metadata) : undefined;
        const user = authenticate(request, options.users, corpus ? "fulltext:fetch" : "fulltext:import");
        if (corpus) store.validateCorpusImport(user.userId, corpus.confirmationToken, corpus.preview);
        const stagingPath = await receivePdf(request, store.rootDir);
        const asset = await validateUploadedAndPromote(store.rootDir, stagingPath, {
          ...metadata,
          ...(corpus ? { trustSuppliedDoi: true } : {}),
        });
        const imported = corpus
          ? store.recordCorpusImport(user.userId, requestId, { doi: asset.doi, title: asset.title }, asset, host)
          : store.recordImport(user.userId, requestId, { doi: asset.doi, title: asset.title }, asset, host);
        sendJson(response, 200, { ok: true, receiptId: imported.receiptId, alreadyPresent: imported.alreadyPresent, data: imported.data });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/papers/download") {
        const user = authenticate(request, options.users, "fulltext:read");
        const body = await readJson(request);
        if (typeof body.paperId !== "string" || body.paperId.trim() === "") throw new CenterError("validation_failed", "paperId is required.", 400);
        const sha256 = typeof body.sha256 === "string" && body.sha256.trim() !== "" ? body.sha256.trim() : undefined;
        const object = store.objectPath(body.paperId, sha256);
        store.recordRead(user.userId, requestId, "sync.pull_pdf", body.paperId, "ok", host);
        response.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": object.byteSize,
          "x-dentalbook-sha256": object.sha256,
        });
        createReadStream(object.path).on("error", () => response.destroy()).pipe(response);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/users/list") {
        const user = authenticate(request, options.users, DIRECTORY_AUDIT_SCOPES);
        const result = store.listDirectoryUsers(directoryAccounts());
        store.recordRead(user.userId, requestId, "admin.users.list", "*", "ok", host);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/admin/users/get") {
        const user = authenticate(request, options.users, DIRECTORY_AUDIT_SCOPES);
        const body = await readJson(request);
        if (typeof body.userId !== "string" || body.userId.trim() === "") throw new CenterError("validation_failed", "userId is required.", 400);
        const folder = store.getUserFolder(body.userId.trim(), directoryAccounts());
        store.recordRead(user.userId, requestId, "admin.users.get", folder.userId, "ok", host);
        sendJson(response, 200, { ok: true, user: folder });
        return;
      }
      throw new CenterError("not_found", "The requested API route does not exist.", 404);
    } catch (error) {
      const failure = asCenterError(error);
      if (!response.headersSent) sendJson(response, failure.httpStatus, { ok: false, errorCode: failure.code, message: failure.message, requestId });
      else response.destroy();
    }
  };

  let server;
  if (options.tlsCertPath && options.tlsKeyPath) {
    const [cert, key] = await Promise.all([readFile(resolve(options.tlsCertPath)), readFile(resolve(options.tlsKeyPath))]);
    server = createHttpsServer({ cert, key }, (request, response) => { void handler(request, response); });
  } else {
    if (!options.allowInsecureLoopback) {
      store.close();
      throw new Error("TLS certificate and key are required unless insecure loopback is explicitly enabled for automated tests.");
    }
    server = createHttpServer((request, response) => { void handler(request, response); });
  }
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 7342, host, () => resolveListen());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    store,
    baseUrl: `${options.tlsCertPath ? "https" : "http"}://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
    async close() {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      store.close();
    },
  };
}

export async function loadCenterUsers(path: string): Promise<CenterUser[]> {
  const parsed = JSON.parse(await readFile(resolve(path), "utf8")) as { users?: CenterUser[] };
  if (!Array.isArray(parsed.users) || parsed.users.length === 0) throw new Error("The center users file must contain at least one user.");
  for (const user of parsed.users) {
    if (!user.userId || !/^[a-f0-9]{64}$/u.test(user.tokenSha256) || !Array.isArray(user.scopes)) throw new Error("The center users file is invalid.");
    if (user.displayName !== undefined) {
      if (typeof user.displayName !== "string" || user.displayName.trim() === "" || user.displayName.length > 80) {
        throw new Error("The center users file displayName must be 1 to 80 characters.");
      }
      user.displayName = user.displayName.trim();
    }
  }
  return parsed.users;
}
