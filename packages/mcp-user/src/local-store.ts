import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PdfProof, PaperWithPdfProof } from "@dentalbook/domain-contracts";
import { UserServiceError } from "./center-client.js";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

export class LocalStore {
  private readonly db: DatabaseSync;

  private constructor(private readonly rootDir: string, dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS local_assets (
        paper_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        verified_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_receipts (
        receipt_id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        paper_id TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  static async open(rootDir: string) {
    await Promise.all([
      mkdir(resolve(rootDir, "db"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(rootDir, "pdfs/sha256"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(rootDir, "staging"), { recursive: true, mode: 0o700 }),
    ]);
    return new LocalStore(rootDir, resolve(rootDir, "db/personal.sqlite3"));
  }

  close() {
    this.db.close();
  }

  countLocal() {
    const row = this.db.prepare("SELECT count(*) AS count FROM local_assets").get() as { count: number };
    return row.count;
  }

  private objectPath(hash: string) {
    return resolve(this.rootDir, "pdfs/sha256", hash.slice(0, 2), hash.slice(2, 4), `${hash}.pdf`);
  }

  async localProof(paperId: string, center: Pick<PaperWithPdfProof, "pdfProof" | "pdfs">): Promise<PdfProof> {
    const row = this.db.prepare("SELECT sha256, byte_size, verified_at FROM local_assets WHERE paper_id = ?").get(paperId) as {
      sha256: string;
      byte_size: number;
      verified_at: string;
    } | undefined;
    const centerShas = new Set([
      ...(center.pdfProof.fileSha256 ? [center.pdfProof.fileSha256] : []),
      ...(center.pdfs?.map((pdf) => pdf.sha256) ?? []),
    ]);
    if (!row || !centerShas.has(row.sha256)) return center.pdfProof;
    try {
      const path = this.objectPath(row.sha256);
      const info = await lstat(path);
      const bytes = await readFile(path);
      if (!info.isFile() || info.isSymbolicLink() || bytes.subarray(0, 5).toString("ascii") !== "%PDF-" || bytes.length !== row.byte_size || sha256(bytes) !== row.sha256) {
        return center.pdfProof;
      }
      return { status: "local", fileSha256: row.sha256, byteSize: row.byte_size, mimeVerified: true, verifiedAt: row.verified_at };
    } catch {
      return center.pdfProof;
    }
  }

  async saveDownload(paperId: string, download: { bytes: Buffer; sha256: string; byteSize: number }) {
    if (download.bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new UserServiceError("validation_failed", "The downloaded file does not have a valid PDF header.");
    }
    if (download.bytes.length !== download.byteSize || sha256(download.bytes) !== download.sha256) {
      throw new UserServiceError("validation_failed", "The downloaded PDF does not match the center hash or size.");
    }
    const destination = this.objectPath(download.sha256);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const staging = resolve(this.rootDir, "staging", `pull-${randomUUID()}.pdf`);
    try {
      await writeFile(staging, download.bytes, { flag: "wx", mode: 0o600 });
      try {
        const info = await lstat(destination);
        if (!info.isFile() || info.isSymbolicLink()) throw new UserServiceError("conflict", "The local PDF destination is not a regular file.");
        const existing = await readFile(destination);
        if (sha256(existing) !== download.sha256) throw new UserServiceError("conflict", "An existing local PDF conflicts with the center hash.");
        await unlink(staging);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") await rename(staging, destination);
        else if (error instanceof UserServiceError) throw error;
        else throw error;
      }
      const verifiedAt = new Date().toISOString();
      const receiptId = `local_sync_${randomUUID()}`;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`
          INSERT INTO local_assets(paper_id, sha256, byte_size, verified_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(paper_id) DO UPDATE SET sha256 = excluded.sha256, byte_size = excluded.byte_size, verified_at = excluded.verified_at
        `).run(paperId, download.sha256, download.byteSize, verifiedAt);
        this.db.prepare("INSERT INTO local_receipts(receipt_id, action, paper_id, sha256, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(receiptId, "sync.pull_pdf", paperId, download.sha256, verifiedAt);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return {
        receiptId,
        pdfProof: { status: "local", fileSha256: download.sha256, byteSize: download.byteSize, mimeVerified: true, verifiedAt } as PdfProof,
      };
    } finally {
      await unlink(staging).catch(() => undefined);
    }
  }
}
