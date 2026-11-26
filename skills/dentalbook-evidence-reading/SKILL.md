---
name: dentalbook-evidence-reading
description: Read dental papers into traceable evidence cards through the dentalbook-user MCP. Use when extracting claims, outcomes, methods, limitations, quotations, highlights, or page-level evidence that must be linked to a verified PDF or HTML source.
---

# Dentalbook Evidence Reading

Create evidence cards that preserve the source file, page, exact wording, context, and limits.

## Workflow

1. Confirm the paper and current `PdfProof`; do not begin exact-quote work from metadata alone.
2. Read the relevant page range through a Dentalbook evidence tool, retaining file SHA, zero-based `pageIndex`, printed page label, and text source.
3. Separate the authors' findings from your interpretation. Capture study design, sample, intervention/exposure, outcome, effect estimate, uncertainty, and limitations when available.
4. Create an evidence card with the shortest quote needed to support the claim plus enough context to avoid reversal or cherry-picking.
5. Accept `exact` only when the service returns a matching `QuoteProof`. Keep OCR output as `ocr_candidate` until a separate verification succeeds.
6. Link the card to the paper and intended review claim; preserve the MCP write receipt.

## Guardrails

- Do not infer an exact quote from an abstract, paraphrase, OCR candidate, or memory.
- Do not convert correlation to causation or secondary discussion to primary evidence.
- If page, quote, or file SHA conflicts, mark the evidence unverified and request re-location.
- If the write receipt fails, do not say the evidence card or highlight was saved.
- If the business tools are absent, report the scaffold limitation instead of synthesizing fake cards.
