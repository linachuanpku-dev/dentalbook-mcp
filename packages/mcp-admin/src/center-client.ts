import type { AuthorAdminUpsert, AuthorDetail, AuthorMergeDetail, AuthorMergeListResult, AuthorMergeStatus, AuthorRelationPost, AuthorRelationStatus, CorpusIngestPreview, DirectoryUserFolder, DirectoryUserList, LibraryStats, PaperMetadataDraft, PaperMetadataIngest, PaperWithPdfProof, Receipt } from "@dentalbook/domain-contracts";

export class AdminServiceError extends Error {
  constructor(public readonly code: "not_found" | "forbidden" | "validation_failed" | "conflict" | "upstream_unavailable", message: string) {
    super(message);
    this.name = "AdminServiceError";
  }
}

export type AdminCenterConfig = { apiBaseUrl: string; bearerToken: string; requestTimeoutMs: number };

export class AdminCenterClient {
  constructor(private readonly config: AdminCenterConfig) {}

  private async request(path: string, body?: unknown) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      return await fetch(`${this.config.apiBaseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: controller.signal,
        headers: body === undefined ? undefined : { authorization: `Bearer ${this.config.bearerToken}`, "content-type": "application/json", "x-dentalbook-host": "admin" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new AdminServiceError("upstream_unavailable", "The Dentalbook center is unavailable.");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async json<T>(path: string, body: unknown): Promise<T> {
    const response = await this.request(path, body);
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { errorCode?: string; message?: string };
      const allowed = ["not_found", "forbidden", "validation_failed", "conflict", "upstream_unavailable"] as const;
      const code = allowed.find((value) => value === failure.errorCode) ?? "upstream_unavailable";
      throw new AdminServiceError(code, failure.message ?? "The Dentalbook center rejected the admin request.");
    }
    return response.json() as Promise<T>;
  }

  async health() {
    try {
      const response = await this.request("/v1/health");
      if (!response.ok) return false;
      return ((await response.json()) as { businessReady?: boolean }).businessReady === true;
    } catch {
      return false;
    }
  }

  fetchFulltext(identifier: string) {
    return this.json<Receipt<PaperWithPdfProof>>("/v1/papers/fetch-fulltext", { identifier });
  }

  ingestMetadata(papers: PaperMetadataDraft[]) {
    return this.json<Receipt<PaperMetadataIngest>>("/v1/papers/ingest-metadata", { papers });
  }

  async previewCorpusIngest(preview: CorpusIngestPreview): Promise<Receipt<{ confirmationToken: string; expiresAt: string; summary: CorpusIngestPreview }>> {
    const result = await this.json<{
      ok: true;
      errorCode: "confirmation_required";
      message: string;
      confirmationToken: string;
      expiresAt: string;
      summary: CorpusIngestPreview;
    }>("/v1/papers/ingest-corpus/preview", preview);
    return {
      ok: true,
      receiptId: `corpus_preview_${result.confirmationToken}`,
      data: {
        confirmationToken: result.confirmationToken,
        expiresAt: result.expiresAt,
        summary: result.summary,
      },
    };
  }

  async stats() {
    const result = await this.json<{ ok: true } & LibraryStats>("/v1/library/stats", {});
    return { sharedPapers: result.sharedPapers, sharedPdfs: result.sharedPdfs, metadataOnly: result.metadataOnly, localPdfs: 0 };
  }

  upsertAuthor(patch: AuthorAdminUpsert) {
    return this.json<Receipt<AuthorDetail>>("/v1/authors/upsert", patch);
  }

  async listAuthorRelations(query: { authorId?: string; status?: AuthorRelationStatus }) {
    const result = await this.json<{ ok: true; items: AuthorRelationPost[]; total: number }>("/v1/authors/relations", query);
    return { items: result.items, total: result.total };
  }

  reviewAuthorRelation(relationId: string, decision: "approved" | "rejected") {
    return this.json<Receipt<{ relation: AuthorRelationPost; author: AuthorDetail }>>("/v1/authors/review-relation", { relationId, decision });
  }

  async listAuthorMerges(status?: AuthorMergeStatus) {
    const result = await this.json<{ ok: true } & AuthorMergeListResult>("/v1/authors/merges/list", status ? { status } : {});
    return { items: result.items, total: result.total };
  }

  async getAuthorMerge(authorId: string) {
    const result = await this.json<{ ok: true } & AuthorMergeDetail>("/v1/authors/merges/get", { authorId });
    return { author: result.author, latest: result.latest, history: result.history };
  }

  reviewAuthorMerge(authorId: string, decision: "confirmed" | "returned") {
    return this.json<Receipt<AuthorMergeDetail>>("/v1/authors/merges/review", { authorId, decision });
  }

  async listUsers() {
    const result = await this.json<{ ok: true } & DirectoryUserList>("/v1/admin/users/list", {});
    return { items: result.items, total: result.total };
  }

  async getUser(userId: string) {
    const result = await this.json<{ ok: true; user: DirectoryUserFolder }>("/v1/admin/users/get", { userId });
    return result.user;
  }
}
