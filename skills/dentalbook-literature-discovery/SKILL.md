---
name: dentalbook-literature-discovery
description: Find and triage dental literature through the dentalbook-user MCP. Use for clinical or research literature searches, topic scoping, paper discovery, deduplication, and checking whether results are metadata-only, centrally cached, or locally available.
---

# Dentalbook Literature Discovery

Turn the question into a reproducible search and report availability without overstating access.

## Workflow

1. Clarify population, intervention/exposure, comparator, outcome, study type, specialty, and date/language limits only when they materially change the search.
2. Call the highest-level available Dentalbook literature-search tool. For a named author plus topic, use `papers.search` with `author` and `keywords` (aliases like `yu guang yan` resolve to the catalog person). Prefer one intent-level call over manually coordinating catalog and author stores. Search recalls over title, abstract, keywords, and MeSH when those fields exist; `hasAbstract: false` means title-only recall. Write CN/EN synonyms and subtypes into `keywords` with slash-OR (e.g. `implant/种植体/osstem`); never assume expansion.
3. Deduplicate by stable identifiers, then by normalized title/year when identifiers are missing.
4. Rank by clinical relevance, evidence level, recency, and query fit. Do not treat citation count as quality by itself.
5. Preserve the returned availability state for each paper: `local`, `central_cached`, `metadata_only`, or `missing`.
6. Summarize the result set and evidence gaps. Offer full-text retrieval only for selected papers.

## Guardrails

- Never say “full text found” for `metadata_only`.
- Never invent DOI, PMID, authors, journal details, or retrieval status.
- Treat abstracts as abstracts, not as verified full-text evidence.
- If the required Dentalbook business tool is absent, state that the installed server is scaffold-only and stop; do not fabricate results.
- For a medical conclusion, continue through evidence reading and citation verification before drafting a definitive answer.
