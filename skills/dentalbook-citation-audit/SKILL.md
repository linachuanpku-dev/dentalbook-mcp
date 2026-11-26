---
name: dentalbook-citation-audit
description: Audit Dentalbook citations, PDF integrity, quote proof, page locations, and claim coverage. Use before finalizing a dental review, checking an existing draft, investigating a broken citation, or explaining why a source is metadata-only, page-only, OCR candidate, or unverified.
---

# Dentalbook Citation Audit

Audit each claim and citation against the current Dentalbook proof objects.

## Workflow

1. Extract medical claims and their linked Dentalbook citation IDs.
2. Call the citation audit tool for the complete set when possible.
3. For each citation, check bibliographic identity, `PdfProof`, current file SHA, `QuoteProof`, page index/label, quote hash, coordinates, and verification time.
4. Reject exact status if the quote's file SHA differs from the current PDF, the text cannot be reproduced, or the page/coordinates refer to another rendering.
5. Report four categories separately: verified, PDF-only, metadata-only, and broken/conflicting.
6. Return a claim-level repair list: re-fetch, re-locate, replace citation, soften claim, or remove claim.

## Guardrails

- Only a successful `citations.verify` receipt can create `dentalbook_verified`.
- Never upgrade `page_only` or `ocr_candidate` to `exact` in prose.
- Do not treat a complete bibliography as adequate claim coverage.
- Keep a verified citation's source wording separate from the model's interpretation.
- If audit tools are absent, say that no verification was performed; do not infer status from citation formatting.
