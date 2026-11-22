# Bashwink — Canonical Project Documentation

**Documentation bundle:** audited 22 November 2026  
**Implementation state:** planning only; no implementation has been verified in the user's local repository.

This folder is the single reference for the proposed Bashwink open-source coding agent. The `BASHWINK_TASKS_90.csv` file is the **canonical per-task status register**, not the individual historic backlogs.

## Start here

1. Read `AGENTS.md` at the repository root and `AGENT_WORKFLOW.md` and `BASHWINK_MASTER_AGENT_PROMPT.md` here.
2. Read `BASHWINK_PHASE_BY_PHASE_TASK_PLAN.md` and `PHASE_GATE_CHECKLIST.md`.
3. Check `BASHWINK_TASKS_90.csv`, `IMPLEMENTATION_STATUS.md`, and `NEXT_STEPS.md`.
4. Read the specific `PHASE-XX-*.md` document for your current work, plus the original technical requirements.
5. For architecture decisions, consult `ADR-001-FOUNDATION-AND-FORK.md`, `DECISIONS.md`, and `UPSTREAM_BASELINE.md`.

## Documentation catalog

| Category | Files | Purpose |
| --- | --- | --- |
| Primary execution | `BASHWINK_PHASE_BY_PHASE_TASK_PLAN.md`, `BASHWINK_TASKS_90.csv` | Phase ordering and canonical 90 tasks |
| Phase plans | `PHASE-00-FOUNDATION.md` through `PHASE-07-FUTURE.md` | Per-phase task instructions and gates |
| Release controls | `PHASE_GATE_CHECKLIST.md` | Evidence-required exit criteria |
| Baseline specification | `BASHWINK_PRODUCT_REQUIREMENTS.md`, `IMPLEMENTATION_BACKLOG.md`, `BASHWINK_FULL_PLAN.md` | Original 49 requirements and 54 tasks |
| Architecture | `ADR-001-FOUNDATION-AND-FORK.md`, `DECISIONS.md`, `UPSTREAM_BASELINE.md` | Fork strategy and future decisions |
| V2 additions | `BASHWINK_V2_PRD_ADDENDUM.md`, `BASHWINK_V2_FEATURE_BACKLOG.md` | Added 34 requirements and 36 tasks |
| Research | `COMPETITIVE_GAP_RESEARCH.md`, `EXPERIMENTS_AND_EVALUATIONS.md` | Competitor analysis and test design |
| Combined reading | `BASHWINK_V2_INTEGRATED_PLAN.md` | Consolidated context; do not treat as a separate task register |
| Agent operation | `AGENT_WORKFLOW.md`, `BASHWINK_MASTER_AGENT_PROMPT.md`, root `AGENTS.md` | Safe agent execution rules |
| Progress | `IMPLEMENTATION_STATUS.md`, `TEST_EVIDENCE.md`, `NEXT_STEPS.md` | State and test artifacts (initial templates) |
| Deliverable copies | `reports/` | Readable Word copies and research report |
| Audit tooling | `AUDIT_REPORT.md`, `PACKAGE_MANIFEST.json`, `scripts/verify_bashwink_docs.py` at repo root | Integrity and completeness checks |

## Conflict precedence

Where documents disagree, prefer: **observed source/tests and security constraints** → **accepted architecture decisions** → **canonical task CSV and phase gates** → **latest v2 requirement addendum** → **initial PRD/backlog** → **combined prose reports**. Keep original task IDs; document revisions instead of silently rewriting historic plans. Phase placement in the 90-task CSV supersedes earlier release labels in initial backlogs.

## Proposed roadmap

| Phase | Theme | Task count |
| --- | --- | ---: |
| P0 | Foundation | 9 |
| P1 | CLI core | 10 |
| P2 | Verification and security | 15 |
| P3 | Memory, impact analysis and independent QA | 19 |
| P4 | Sandboxes and multi-agent orchestration | 13 |
| P5 | Evaluation | 8 |
| P6 | Release | 9 |
| P7 | Future integrations | 7 |
| **Total** | | **90** |

## Local verification and unpacking

From the existing `bashwink/` directory, **preview ZIP entries** before extracting; avoid overwriting code or existing agent instructions:

```bash
unzip -l BASHWINK_DOCS_COMPLETE_AUDITED.zip
unzip -n BASHWINK_DOCS_COMPLETE_AUDITED.zip
python3 scripts/verify_bashwink_docs.py
```

Place the ZIP into the `bashwink/` directory before running those commands. `unzip -n` preserves existing names but may leave old documents in place: manually compare and reconcile any skipped files. Do not rely on this bundle to confirm what is actually installed in your local repo.

**Do not copy the `docs/bashwink/` directory *inside itself*.** Extract this archive at the existing repository root, as its paths already begin with `docs/bashwink/`.
