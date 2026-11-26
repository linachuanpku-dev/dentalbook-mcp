---
name: dentalbook-author-exploration
description: Explore dental authors, institutions, geography, collaborators, mentorship, and team relationships through the dentalbook-user MCP. Use for author disambiguation, field mapping, collaboration analysis, institution maps, lineage questions, or proposing sourced author corrections.
---

# Dentalbook Author Exploration

Explore identity and relationships while keeping asserted facts separate from public data and inference.

## Workflow

1. Resolve ambiguous names using stable IDs, affiliation, specialty, coauthors, years, and source records.
2. Request author details, map data, or graph data according to the user's question. Use rendering tools only when a visual would materially help.
3. For every relationship, preserve kind, provenance, confidence, supporting paper IDs, and changeset ID when present.
4. Describe `human_asserted`, `public_dataset`, and `algorithm_inferred` edges with different language.
5. When recording a human judgment, call `authors.submit_note` with mentorship, abbreviation, or disambiguation. Do not invent English names that were never observed.
6. To record mentor or student comments on a person, call `authors.submit_relation`. The post stays pending until an administrator approves it with `admin.authors.review_relation`.
7. Admin profile edits go through `admin.authors.upsert`. Merges or deletes are not registered yet.

## Guardrails

- Coauthorship does not prove mentorship, employment, or team membership.
- Geographic coordinates describe an institution record, not necessarily a person's present location.
- Never hide low confidence or missing provenance.
- Do not claim a write succeeded without a receipt.
- Map and graph tools remain unimplemented; do not pretend they exist.
