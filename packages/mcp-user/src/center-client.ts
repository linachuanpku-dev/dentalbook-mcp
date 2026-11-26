import { pickPaperUploads, type AuthorDetail, type AuthorListResult, type AuthorNoteDraft, type AuthorRelationDraft, type AuthorRelationPost, type LibraryStats, type PaperListResult, type PaperSearchResult, type PaperWithPdfProof, type Receipt } from "@dentalbook/domain-contracts";
import type { UserConfig } from "./config.js";

export class UserServiceError extends Error {
  constructor(
    public readonly code: Extract<Receipt, { ok: false }>["errorCode"],
    message: string,
  ) {
    super(message);
    this.name = "UserServiceError";
  }
}

type ErrorBody = { ok: false; errorCode?: string; message?: string };

export class CenterClient {
  constructor(private readonly config: UserConfig) {}

  private async request(path: string, init: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      return await fetch(`${this.config.apiBaseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.config.bearerToken}`,
          ...(this.config.mcpHost ? { "x-dentalbook-host": this.config.mcpHost } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new UserServiceError("upstream_unavailable", "The Dentalbook center is unavailable.");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async json<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as Partial<ErrorBody>;
      const allowed = ["not_found", "forbidden", "validation_failed", "conflict", "upstream_unavailable"];
      const code = allowed.includes(failure.errorCode ?? "")
        ? failure.errorCode as UserServiceError["code"]
        : "upstream_unavailable";
      throw new UserServiceError(code, failure.message ?? "The Dentalbook center rejected the request.");
    }
    return response.json() as Promise<T>;
  }

  async health() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await fetch(`${this.config.apiBaseUrl}/v1/health`, { signal: controller.signal });
      if (!response.ok) return false;
      const body = await response.json() as { businessReady?: boolean };
      return body.businessReady === true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getPaper(identifier: string) {
    const result = await this.json<{ ok: true } & PaperWithPdfProof>("/v1/papers/get", { identifier });
    return { paper: result.paper, pdfProof: result.pdfProof, ...pickPaperUploads(result) };
  }

  async listPapers(query: string, limit: number, offset: number) {
    const result = await this.json<{ ok: true } & PaperListResult>("/v1/papers/list", { query, limit, offset });
    return { items: result.items, total: result.total, limit: result.limit, offset: result.offset, stats: result.stats };
  }

  async searchPapers(author: string, keywords: string, limit: number, offset: number) {
    const result = await this.json<{ ok: true } & PaperSearchResult>("/v1/papers/search", { author, keywords, limit, offset });
    return {
      items: result.items,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      stats: result.stats,
      resolvedAuthorId: result.resolvedAuthorId,
    };
  }

  async stats() {
    const result = await this.json<{ ok: true } & LibraryStats>("/v1/library/stats", {});
    return { sharedPapers: result.sharedPapers, sharedPdfs: result.sharedPdfs, metadataOnly: result.metadataOnly, localPdfs: result.localPdfs };
  }

  async listAuthors(query: string, limit: number, offset: number) {
    const result = await this.json<{ ok: true } & AuthorListResult>("/v1/authors/list", { query, limit, offset });
    return { items: result.items, total: result.total, limit: result.limit, offset: result.offset };
  }

  async getAuthor(identifier: string) {
    const result = await this.json<{ ok: true; author: AuthorDetail }>("/v1/authors/get", { identifier });
    return result.author;
  }

  submitAuthorNote(draft: AuthorNoteDraft) {
    return this.json<Receipt<AuthorDetail>>("/v1/authors/submit-note", draft);
  }

  submitAuthorRelation(draft: AuthorRelationDraft) {
    return this.json<Receipt<{ relation: AuthorRelationPost; author: AuthorDetail }>>("/v1/authors/submit-relation", draft);
  }

  async fetchFulltext(identifier: string) {
    return this.json<Receipt<PaperWithPdfProof>>("/v1/papers/fetch-fulltext", { identifier });
  }

  async importPdf(bytes: Buffer, metadata: { doi?: string; title?: string }) {
    const headers: Record<string, string> = {
      "content-type": "application/pdf",
      "content-length": String(bytes.length),
    };
    if (metadata.doi) headers["x-dentalbook-doi"] = metadata.doi;
    if (metadata.title) headers["x-dentalbook-title-base64"] = Buffer.from(metadata.title, "utf8").toString("base64url");
    const response = await this.request("/v1/papers/import", { method: "POST", headers, body: Uint8Array.from(bytes).buffer });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as Partial<ErrorBody>;
      const allowed = ["not_found", "forbidden", "validation_failed", "conflict", "upstream_unavailable"];
      const code = allowed.includes(failure.errorCode ?? "") ? failure.errorCode as UserServiceError["code"] : "upstream_unavailable";
      throw new UserServiceError(code, failure.message ?? "The center rejected the PDF upload.");
    }
    return response.json() as Promise<{ ok: true; receiptId: string; data: PaperWithPdfProof }>;
  }

  async download(paperId: string, fileSha256?: string) {
    const response = await this.request("/v1/papers/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paperId, ...(fileSha256 ? { sha256: fileSha256 } : {}) }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as Partial<ErrorBody>;
      const allowed = ["not_found", "forbidden", "validation_failed", "conflict", "upstream_unavailable"];
      const code = allowed.includes(failure.errorCode ?? "")
        ? failure.errorCode as UserServiceError["code"]
        : "upstream_unavailable";
      throw new UserServiceError(code, failure.message ?? "The center PDF download failed.");
    }
    const sha256 = response.headers.get("x-dentalbook-sha256");
    const contentLength = Number(response.headers.get("content-length"));
    if (!sha256 || !/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(contentLength) || contentLength <= 0) {
      throw new UserServiceError("validation_failed", "The center returned incomplete PDF proof headers.");
    }
    if (contentLength > this.config.maxPdfBytes) throw new UserServiceError("validation_failed", "The center PDF exceeds the configured local size limit.");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > this.config.maxPdfBytes) throw new UserServiceError("validation_failed", "The downloaded PDF exceeds the configured local size limit.");
    return { bytes, sha256, byteSize: contentLength };
  }
}
