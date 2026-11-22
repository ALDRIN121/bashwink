# ADR-005 — Upstream sync is a report plus a human gate, never an automated merge

**Status:** Accepted and implemented (`scripts/upstream_sync.py`)
**Date:** 2026-11-22
**Decision owner:** Bashwink maintainer (unassigned individual)
**Depends on:** ADR-001, ADR-002
**Evidence:** `TEST_EVIDENCE.md` BW-043 — ran against real diffs, exit 0 and exit 1 both observed

## Context

Bashwink pins OpenCode. Upstream moves fast (18 public declarations changed between
`v2.2.7` and `v2.3.2` across watched surfaces). Two failure modes:

1. **Auto-merge.** A bot bumps the pin, CI goes green because nothing imports the changed
   symbol *yet*, and the breakage lands in a release.
2. **No process.** Upstream is ignored until an upgrade becomes a week-long emergency.

## Decision

A script produces a **compatibility report**; a **human** decides.

**Watched surfaces** (a change here is a compatibility event, not noise):

```
packages/plugin/src/promise/    packages/core/src/plugin/
packages/plugin/src/effect/     packages/core/src/tool/
packages/plugin/package.json    packages/schema/src/config/
packages/cli/src/commands/commands.ts   packages/schema/src/tool.ts
packages/sdk/src/
```

**Verdicts, with real observed output:**

| Verdict | Meaning | Exit | Observed against |
| --- | --- | --- | --- |
| `UP_TO_DATE` | target == baseline | 0 | — |
| `BASELINE_ONLY` | `--offline`, target not resolved | 0 | baseline `c0ad18b40` |
| `NO_EXTENSION_IMPACT` | no watched path changed | 0 | — |
| `LOW_RISK` | watched paths changed, no public declaration edits | 0 | `v2.3.1` (77 files) |
| `REVIEW_REQUIRED` | a watched public declaration changed | **1** | `v2.2.7` (18 declarations, 3,404 files) |

**The script never merges, rebases, tags or pushes.** It only reads.

**The gate is manual**, and documented inside the report itself: read the declaration
changes, run the upstream suite, run the Bashwink plugin suite, run `fixtures/reset.sh
--check`, then update `UPSTREAM_BASELINE.md` with the new SHA.

**Fail closed:** an unreadable repo, an unresolvable ref, or a git error exits **2** with a
message. It never reports "no changes" because it could not read the tree.

## Why `REVIEW_REQUIRED` exits nonzero on a *successful* run

So that CI or a pre-release check fails on a breaking upstream change without anyone
reading prose. Distinguishing 1 (review needed) from 2 (script broke) means a wrapper can
tell "upstream changed, go look" from "the tooling is broken".

## Consequences

**Positive:** both verdicts verified against real upstream history, not synthetic fixtures;
the 18-declaration result on `v2.2.7` proves the detector is not vacuous.

**Negative and accepted:**
- It is a heuristic: a renamed symbol that keeps the `export function` prefix is caught, but
  a semantic behaviour change with an identical signature is not. Signature-level only.
- Deep-diffing 3,404 files is slow on large jumps; acceptable for a release-time gate.
- No automated PR creation. Deliberate: an auto-PR invites rubber-stamping.

## Reversal conditions

- If the report's noise becomes so high that reviewers ignore it, tighten the watched list
  (fewer, more precise paths) rather than removing the gate.
- If a semantic-change detector (AST-level signature comparison) is needed, add it as an
  additional verdict; keep the fail-closed behaviour.
