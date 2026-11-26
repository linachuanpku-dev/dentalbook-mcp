import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pickPaperUploads, type AuthorDetail, type AuthorListResult, type AuthorNoteDraft, type AuthorRelationDraft, type LibraryStats, type PaperListResult, type PaperSearchResult, type PaperWithPdfProof, type Receipt } from "@dentalbook/domain-contracts";
import { CenterClient, UserServiceError } from "./center-client.js";
import type { UserConfig } from "./config.js";
import { LocalStore } from "./local-store.js";

export class UserApplication {
  private constructor(
    private readonly center: CenterClient,
    private readonly local: LocalStore,
    private readonly config: UserConfig,
  ) {}

  static async create(config: UserConfig) {
    return new UserApplication(new CenterClient(config), await LocalStore.open(config.localDataDir), config);
  }

  close() {
    this.local.close();
  }

  health() {
    return this.center.health();
  }

  async getPaper(identifier: string): Promise<PaperWithPdfProof> {
    const center = await this.center.getPaper(identifier);
    return {
      paper: center.paper,
      pdfProof: await this.local.localProof(center.paper.paperId, center),
      ...pickPaperUploads(center),
    };
  }

  async listPapers(query = "", limit = 50, offset = 0): Promise<PaperListResult> {
    const center = await this.center.listPapers(query, limit, offset);
    return {
      ...center,
      items: await Promise.all(center.items.map(async (item) => ({
        paper: item.paper,
        pdfProof: await this.local.localProof(item.paper.paperId, item),
        ...pickPaperUploads(item),
      }))),
      stats: { ...center.stats, localPdfs: this.local.countLocal() },
    };
  }

  async searchPapers(author: string, keywords: string, limit = 50, offset = 0): Promise<PaperSearchResult> {
    const center = await this.center.searchPapers(author, keywords, limit, offset);
    return {
      ...center,
      items: await Promise.all(center.items.map(async (item) => ({
        paper: item.paper,
        pdfProof: await this.local.localProof(item.paper.paperId, item),
        ...pickPaperUploads(item),
      }))),
      stats: { ...center.stats, localPdfs: this.local.countLocal() },
    };
  }

  async stats(): Promise<LibraryStats> {
    return { ...await this.center.stats(), localPdfs: this.local.countLocal() };
  }

  listAuthors(query = "", limit = 50, offset = 0): Promise<AuthorListResult> {
    return this.center.listAuthors(query, limit, offset);
  }

  async getAuthor(identifier: string): Promise<AuthorDetail> {
    const author = await this.center.getAuthor(identifier);
    return {
      ...author,
      works: await Promise.all(author.works.map(async (work) => {
        if (!work.library) return work;
        return {
          ...work,
          library: {
            paper: work.library.paper,
            pdfProof: await this.local.localProof(work.library.paper.paperId, work.library),
            ...pickPaperUploads(work.library),
          },
        };
      })),
    };
  }

  submitAuthorNote(draft: AuthorNoteDraft) {
    return this.center.submitAuthorNote(draft);
  }

  submitAuthorRelation(draft: AuthorRelationDraft) {
    return this.center.submitAuthorRelation(draft);
  }

  async fetchFulltext(identifier: string): Promise<Receipt<PaperWithPdfProof>> {
    const result = await this.center.fetchFulltext(identifier);
    if (!result.ok) return result;
    return {
      ...result,
      data: {
        paper: result.data.paper,
        pdfProof: await this.local.localProof(result.data.paper.paperId, result.data),
        ...pickPaperUploads(result.data),
      },
    };
  }

  async importLocal(path: string, metadata: { doi?: string; title?: string }) {
    if (!isAbsolute(path)) throw new UserServiceError("validation_failed", "The PDF import path must be absolute.");
    const [actualPath, roots] = await Promise.all([
      realpath(path).catch(() => { throw new UserServiceError("not_found", "The local PDF does not exist."); }),
      Promise.all(this.config.importRoots.map((root) => realpath(root).catch(() => resolve(root)))),
    ]);
    const allowed = roots.some((root) => {
      const rel = relative(root, actualPath);
      return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
    });
    if (!allowed) throw new UserServiceError("forbidden", "The PDF path is outside the configured import roots.");
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new UserServiceError("validation_failed", "The PDF import path is not a regular file.");
    if (info.size <= 0 || info.size > this.config.maxPdfBytes) throw new UserServiceError("validation_failed", "The PDF is empty or exceeds the configured size limit.");
    const bytes = await readFile(actualPath);
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") throw new UserServiceError("validation_failed", "The selected file does not have a PDF header.");
    const localSha = createHash("sha256").update(bytes).digest("hex");
    const result = await this.center.importPdf(bytes, metadata);
    const matched = result.data.pdfs?.find((pdf) => pdf.sha256 === localSha);
    const centerSha = matched?.sha256 ?? result.data.pdfProof.fileSha256;
    const centerSize = matched?.byteSize ?? result.data.pdfProof.byteSize;
    if (centerSha !== localSha || centerSize !== bytes.length) {
      throw new UserServiceError("conflict", "The center receipt does not match the uploaded local PDF.");
    }
    return result;
  }

  async pullPdf(paperId: string, sha256?: string) {
    const centerPaper = await this.center.getPaper(paperId);
    const versions = centerPaper.pdfs ?? [];
    const targetSha = sha256
      ?? (centerPaper.pdfProof.fileSha256
        ?? (versions.length === 1 ? versions[0]?.sha256 : undefined));
    if (!targetSha) {
      throw new UserServiceError("validation_failed", "sha256 is required when multiple PDF versions exist for this paper.");
    }
    const download = await this.center.download(paperId, targetSha);
    const local = await this.local.saveDownload(paperId, download);
    return {
      receiptId: local.receiptId,
      data: {
        paper: centerPaper.paper,
        pdfProof: local.pdfProof,
        ...pickPaperUploads(centerPaper),
      },
    };
  }
}
