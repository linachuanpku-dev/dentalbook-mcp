---
name: dentalbook-verified-review
description: Draft or revise dental literature reviews using Dentalbook-verified evidence. Use for narrative reviews, evidence summaries, clinical background sections, formal conclusions, or any medical prose where factual claims must have traceable PDF and quote proof.
---

# Dentalbook Verified Review

Write from verified evidence cards and make every unresolved evidence gap visible.

## Workflow

1. Define the review question, audience, scope, date boundary, and intended conclusion strength.
2. Obtain a selected evidence set through literature discovery and evidence reading.
3. Build a claim-to-evidence table before prose. Require an appropriate verified PDF citation for each medical claim and exact quote proof for claims relying on precise wording or a reported result.
4. Draft by synthesis theme, not paper-by-paper narration. Preserve disagreements, heterogeneity, and limitations.
5. Attach Dentalbook citation IDs to claims, then run citation audit before presenting the work as verified.
6. Report unresolved items separately and label the deliverable as a draft if verification is incomplete.

## Required language

- Metadata only: “找到题录但没有 PDF”。
- PDF without located sentence: “PDF 存在但该句话尚未定位”。
- OCR candidate: call it a candidate, never an exact source.
- Unsupported medical statement: mark `[证据待核验]` or remove it from a formal conclusion.

## Guardrails

- A fluent model answer is not evidence.
- A verified citation proves source integrity, not that the interpretation is clinically correct.
- Do not cite a paper for a claim outside the returned evidence context.
- If Dentalbook business tools are absent, do not produce a “verified” review; clearly identify the scaffold limitation.
