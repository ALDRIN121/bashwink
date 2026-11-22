# ADR-008 — Licensing is governed by per-package recorded decisions

**Status:** Accepted
**Date:** 2026-11-23
**Owner:** Aldrin Joseph
**Evidence:** `DEPENDENCY_LICENSES.json`, `scripts/check_license_scope.py`, `THIRD_PARTY_NOTICES.md`

## Context

The Phase 0 audit proposed a CI gate that fails on GPL/AGPL/SSPL/BUSL anywhere in
`node_modules`. The independent review correctly called this out (F-07): it is too strict and
too weak at the same time.

- **Too strict:** a docs-site dependency never reaches the artifact. Blocking on it forces
  pointless removals.
- **Too weak:** the real question is what obligations attach to the bytes actually shipped, and
  a word search cannot answer it. It gives a green tick while the actual distribution — a
  198 MB binary with a statically linked LGPL FFmpeg — goes unassessed.

A second problem surfaced while doing this properly: the repository had **no machine-readable
inventory**, so the numbers in prose (1,641 packages, "four LGPL packages") could not be
re-derived or checked for drift.

## Decision

**1. One machine-readable inventory.** `docs/bashwink/DEPENDENCY_LICENSES.json` holds every
package as `{name, version, license}`, the full copyleft list, and a `decisions` map. Generated
from the pinned tree, committed, diffable.

**2. Every copyleft or unresolved entry needs a recorded decision.** A decision names the
license, whether the package is in the shipped path, the evidence for that claim, the decision
itself, the required actions, and a status of `OPEN`, `ACCEPTED_OUT_OF_SCOPE` or `RESOLVED`.

**3. Entries are classified by kind, not just by license.** `package`, `subpath-entry`
(a `{"type":"module"}` marker inside a parent package) and `test-fixture` (a vendored fixture
inside another dependency's test suite). 26 of the 48 flagged entries are the latter two and
carry no independent obligation. Reporting them as "unlicensed packages" would have been
alarming and false.

**4. Shipped-path claims are verified empirically, not inferred from the dependency graph.**
Whether a package reaches the artifact is checked with `strings` against the built binary.
This mattered: `satori`, `resvg`, `axe-core` and `dompurify` appear in the workspace but are
absent from the binary; the `commonmark` hits are oxlint rule names, not a bundled parser. Only
`@opentui/core-darwin-arm64` is genuinely shipped (ffmpeg 13×, libavcodec 28×).

**5. The gate fails on a missing decision, and separately on an open release blocker.**
`check_license_scope.py` exits 1 if any qualifying package lacks a decision (incomplete
assessment) and §3 if `--fail-on-open` was passed and a `blocks_release` decision is `OPEN`.
Two distinct failures because "we have not assessed this" and "we assessed it and it is not
resolved" require different responses.

**6. A blanket GPL scan is explicitly rejected.** It would be replaced by the decision-based
gate, not added alongside it.

## Current position

| Item | State |
| --- | --- |
| Packages inventoried | 1,641 |
| Copyleft or unresolved entries | 48 |
| Entries with a recorded decision | **48 / 48** |
| In the shipped path | 1 — `@opentui/core-darwin-arm64` (`MIT AND LGPL-2.1-or-later`) |
| Release-blocking and `OPEN` | 1 — the FFmpeg/LGPL position |
| Generated notices bundle | **absent** |
| Legal review | **not performed** |

**The honest summary:** the assessment is complete and machine-enforced; the *distribution*
work is not. Copying license texts is a prerequisite, not a compliance strategy — LGPL-2.1 §6
also requires a relinking/modification route and matching source disclosure for the bundled
FFmpeg 9.0.2. That remains open, and this ADR does not pretend the gate can close without it.

## Consequences

**Positive:** the inventory can be regenerated and diffed; every judgement is written down with
the evidence behind it; a new dependency with copyleft obligations fails CI until someone
records a decision; the "is it shipped?" question is answered by the binary, not by hope.

**Negative and accepted:**
- The inventory is a snapshot of one pinned tree and must be regenerated when the pin moves.
  `upstream_sync.py` does not yet do this; recorded in `NEXT_STEPS.md`.
- Classification is partly heuristic (`/test/` in the path). A misclassified fixture would
  under-report. Mitigated by recording the evidence string per entry.
- This ADR is a technical assessment. It is **not legal advice**, and the open FFmpeg question
  needs a qualified human opinion before release.

## Reversal conditions

- If a package manager emits a standard SBOM (SPDX/CycloneDX), generate the inventory from it
  instead of walking `node_modules`.
- If legal counsel reaches a position on the FFmpeg static-linking question, record it as the
  `OPEN` decision's resolution and flip `blocks_release`.
