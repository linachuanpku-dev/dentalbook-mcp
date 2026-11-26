---
name: dentalbook-fulltext-retrieval
description: Retrieve and validate dental-paper full text through the dentalbook-user MCP. Use when a user needs a PDF, asks whether a paper is locally or centrally available, wants a missing paper fetched, or needs a PDF integrity check before evidence extraction.
---

# Dentalbook Full-text Retrieval

Obtain an authorized file when possible and keep metadata, cache, and local-file states distinct.

## Workflow

1. Resolve the paper to a stable Dentalbook paper ID before requesting a file.
2. Check local, center-cache, permission, and active-fetch states in one application-level call when available.
3. Prefer an existing local verified file, then an authorized center copy, then a new fetch task.
4. For a newly available file, require the service to check PDF magic bytes, calculate full-file SHA-256, record byte size, and return a `PdfProof`.
5. Report one exact state: `local`, `central_cached`, `metadata_only`, or `missing`. When multiple center versions exist, pass `sha256` for download/pull.
6. When batching uploads or fetches, classify each file separately as new ingest, already present (same DOI + same SHA), identity conflict (same SHA + different DOI), or validation failure. Same DOI + different SHA is a new parallel version, not a conflict.
7. For asynchronous fetching, report the task ID and current state. Do not busy-poll or claim completion without a successful receipt.

## Guardrails

- File extension, URL, or HTTP MIME alone cannot produce “PDF verified.”
- Respect license, no-sync, and takedown states; do not route around service policy.
- Never expose storage paths, bearer tokens, or permanent blob URLs to model output.
- If the PDF SHA changes, treat all quote proofs for the old SHA as invalid.
- Do not rename files, rewrite DOIs, or delete-and-reupload to bypass an identity conflict.
- If the business tools are not registered, say that retrieval is not implemented in the current scaffold.
