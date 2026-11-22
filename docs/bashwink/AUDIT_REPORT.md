# Bashwink — Documentation Completeness and Consistency Audit

**Date:** 2026-11-22  
**Scope:** the three planning archives and their source files available in the document-generation workspace; **not** the user's existing local Git repository.

## Findings

1. The earlier `BASHWINK_PHASED_TASK_PACK.zip` included phase plans, a task CSV, a gate checklist, and a Word report but **omitted** the original PRD, original architecture ADR, v2 feature research and experimental design. The other two archives held those missing documents.
2. This corrected distribution includes all substantive baseline and v2 Markdown documents, the canonical phase plan, the eight phase files, the task CSV, the release gate checklist and the three Word reports.
3. Added the missing repository-level `AGENTS.md`, `AGENT_WORKFLOW.md`, `IMPLEMENTATION_STATUS.md`, `DECISIONS.md`, `TEST_EVIDENCE.md`, `NEXT_STEPS.md`, and `UPSTREAM_BASELINE.md` templates, the reusable master agent prompt, plus a validation script.
4. Task validation: **90 unique BW-001–BW-090 issues**, of which **54 v1 and 36 v2**; all eight phase documents contain their phase's tasks; **no missing task dependencies, backward-invalid later-phase dependencies, or dependency cycles**.
5. All issues in the task CSV were originally `Not started` and are preserved as such. No source files or GitHub issues have been created or changed in the user's project.

## What this audit cannot establish

- Whether the user's existing `bashwink/docs` folder already contains these files; no access to that local folder was provided.
- Whether OpenCode/Hermes API behavior, licenses or repository state remain unchanged since the original research. Phase 0 must validate actual source revisions.
- Whether the proposed features or tests have been implemented: this bundle contains planning artifacts only.

## Resolution

The corrected ZIP has paths rooted at `docs/bashwink/`, plus a root-level `AGENTS.md` and `scripts/verify_bashwink_docs.py`. Extract **at the existing `bashwink/` project root**, with backup or no-overwrite behavior for existing files. After extraction run the supplied verifier; resolve any skipped-file differences manually.
