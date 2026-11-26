import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { CenterError } from "./errors.js";

export type CorpusPreview = {
  batchSha256: string;
  manifestSha256: string;
  entryCount: number;
};

export type IssuedConfirmation = {
  confirmationToken: string;
  expiresAt: string;
  summary: CorpusPreview;
};

function equalHex(left: string, right: string) {
  if (!/^[a-f0-9]{64}$/u.test(left) || !/^[a-f0-9]{64}$/u.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function paramsHash(preview: CorpusPreview) {
  return createHash("sha256").update(JSON.stringify(preview)).digest("hex");
}

export function ensureConfirmationSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS confirmation_tokens (
      token_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      action TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      batch_sha256 TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      entry_count INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_confirmation_tokens_user ON confirmation_tokens(user_id, action, consumed_at);
  `);
}

export function issueCorpusConfirmation(db: DatabaseSync, userId: string, preview: CorpusPreview): IssuedConfirmation {
  if (!/^[a-f0-9]{64}$/u.test(preview.batchSha256) || !/^[a-f0-9]{64}$/u.test(preview.manifestSha256)) {
    throw new CenterError("validation_failed", "batchSha256 and manifestSha256 must be 64-char hex strings.", 400);
  }
  if (!Number.isInteger(preview.entryCount) || preview.entryCount < 1 || preview.entryCount > 100_000) {
    throw new CenterError("validation_failed", "entryCount must be an integer from 1 to 100000.", 400);
  }
  const tokenId = randomUUID();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare(`
    INSERT INTO confirmation_tokens(
      token_id, user_id, action, params_hash, batch_sha256, manifest_sha256, entry_count, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tokenId,
    userId,
    "admin.papers.ingest_corpus",
    paramsHash(preview),
    preview.batchSha256,
    preview.manifestSha256,
    preview.entryCount,
    expiresAt,
    createdAt.toISOString(),
  );
  return {
    confirmationToken: tokenId,
    expiresAt,
    summary: preview,
  };
}

export function assertCorpusConfirmation(db: DatabaseSync, userId: string, token: string, preview: CorpusPreview) {
  const row = db.prepare(`
    SELECT token_id, user_id, action, params_hash, batch_sha256, manifest_sha256, entry_count, expires_at, consumed_at
    FROM confirmation_tokens WHERE token_id = ?
  `).get(token) as {
    token_id: string;
    user_id: string;
    action: string;
    params_hash: string;
    batch_sha256: string;
    manifest_sha256: string;
    entry_count: number;
    expires_at: string;
    consumed_at: string | null;
  } | undefined;
  if (!row) throw new CenterError("validation_failed", "The confirmation token is invalid.", 403);
  if (row.user_id !== userId || row.action !== "admin.papers.ingest_corpus") {
    throw new CenterError("forbidden", "The confirmation token does not belong to this user or action.", 403);
  }
  if (row.consumed_at) throw new CenterError("validation_failed", "The confirmation token has already been consumed.", 403);
  if (Date.parse(row.expires_at) <= Date.now()) {
    throw new CenterError("validation_failed", "The confirmation token has expired.", 403);
  }
  if (row.params_hash !== paramsHash(preview)) {
    throw new CenterError("validation_failed", "The confirmation token does not match the supplied batch summary.", 403);
  }
  if (!equalHex(row.batch_sha256, preview.batchSha256) || !equalHex(row.manifest_sha256, preview.manifestSha256)) {
    throw new CenterError("validation_failed", "The confirmation token does not match the supplied batch hashes.", 403);
  }
  if (row.entry_count !== preview.entryCount) {
    throw new CenterError("validation_failed", "The confirmation token does not match the supplied entry count.", 403);
  }
}

export function consumeCorpusConfirmation(db: DatabaseSync, token: string) {
  const consumedAt = new Date().toISOString();
  const result = db.prepare(`
    UPDATE confirmation_tokens SET consumed_at = ?
    WHERE token_id = ? AND consumed_at IS NULL
  `).run(consumedAt, token);
  if (result.changes !== 1) throw new CenterError("validation_failed", "The confirmation token could not be consumed.", 403);
}
