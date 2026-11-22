# ADR-001 — Bashwink foundation, fork strategy and extension boundaries

**Status:** **Accepted** (supersedes the Proposed draft of 22 November 2026)
**Date decided:** 2026-11-22
**Decision owner:** Bashwink maintainer — *unassigned individual; see open items*
**Evidence basis:** `UPSTREAM_BASELINE.md`, `TEST_EVIDENCE.md` rows BW-001…BW-003, BW-007, BW-043

## Context

Bashwink aims to deliver a coding CLI with persistent project knowledge, verifiable task
completion and safe controlled delegation. Two reference projects are relevant:

- **OpenCode (Anomaly)** — terminal-first coding workflows, agents, typed SDK, extensions,
  permissions, snapshots, Git worktrees. TypeScript/Bun, MIT.
- **Hermes Agent (Nous Research)** — provenance-tagged memory, skill curation, pluggable
  terminal backends, delegation. Python-centred, MIT.

## What the spike actually proved

The draft ADR asked for a two-day feasibility spike. It was run. Findings, each backed by
a reproducible command in `TEST_EVIDENCE.md`:

| Spike question | Result |
| --- | --- |
| Pin an exact baseline and build it | **Yes.** `v2.3.2` = `c0ad18b40`, clean install, 198 MB single-arch binary builds and runs. |
| Does the pinned tree pass its own tests | **Yes**, with 3 documented environment failures caused by macOS bash 3.2, not by product defects. |
| Can a plugin capture a real tool invocation with exit status? | **Yes.** `@bashwink/evidence` recorded `before` (command) and `after` (`exit=0`) through `tool.hook("execute.before"/"execute.after")` during a real agent turn. |
| Can a plugin see the project directory (not the server cwd)? | **Yes**, via `ctx.location.directory`. Found and fixed a real bug here: `process.cwd()` pointed at `$HOME` because the background service owned it. |
| Can a plugin refuse a tool call? | **Yes.** `execute.before` is the only hook with a failure channel: throwing `Tool.Error` rejects the call before it runs (`packages/core/src/plugin/hooks.ts`, `Failures` interface). |
| Can a plugin rename the binary / set the product version string? | **No.** Branding lives in the build script and CLI spec, not in any plugin surface. |
| Did evidence recording require a core patch? | **No.** Zero upstream files modified. |

## Decision

1. **Depend on pinned OpenCode, do not vendor it.** All five relevant packages
   (`@opencode/cli`, `core`, `plugin`, `sdk`, `schema`) are published to npm at 2.3.2.
   Bashwink consumes them as a peer dependency at an exact version. Rejected: copying the
   tree (2.7 GB of dependencies, whole-tree rebases, and every upstream commit becomes our
   conflict).
2. **Implement Bashwink behaviour as plugins.** The spike proved the plugin seam covers
   tool lifecycle, permissions, shell creation, sessions and the event bus. Bashwink's
   first-party package is `@bashwink/evidence`.
3. **Ship branding as a companion CLI wrapper**, not a fork. Because a plugin cannot
   rename the binary or override the version string, and the spike showed a wrapper is
   sufficient, the `bashwink` entrypoint will be a thin TypeScript launcher that pins the
   OpenCode runtime, injects Bashwink config and plugins, and reports its own version.
   **This is a deliberate constraint, not a claim of upstream support.**
4. **Use TypeScript/Bun-native services** for task/evidence recording. Do not import the
   Hermes Python runtime.
5. **Port Hermes-inspired behaviour as documented requirements**, not code.
6. **Maintain `UPSTREAM_BASELINE.md` + a machine-generated sync report** on each release
   (`scripts/upstream_sync.py`). No automated merge: the report exits nonzero on breaking
   extension-surface changes so a human must read it.
7. **Prefer exact evidence over model claims**, delivered by hash-chained evidence logs.

## Alternatives considered

| Option | Benefit | Drawback | Decision |
| --- | --- | --- | --- |
| **Pinned dependency + plugin + wrapper CLI** | No upstream drift burden; proven seams; upgrade is a version bump | Cannot rename binary in-process; depends on plugin contract stability | **ACCEPTED** |
| OpenCode plugin only | Lowest maintenance | No branded binary at all; no version identity | Superseded by the wrapper |
| Shallow fork + extensions | Real `bashwink` binary, full UX control | Whole-tree rebase on every upstream change; 2.7 GB per CI leg | **Rejected** — the wrapper achieves the same branding for a fraction of the cost |
| Deep fork | Maximum control | Rebase + parity burden | Rejected |
| Hermes fork | Strong memory/sandbox design | Coding UX and SDK would need rebuilding | Rejected |
| Dual Hermes/OpenCode merge | Feature breadth in theory | Duplicate loops, tool systems, TS/Python boundary | Rejected |
| Write from scratch | Clean architecture | Rebuilds commodity functionality | Rejected for v1 |

## Consequences

**Positive:** upgrades become a version bump; we inherit upstream quality; zero merge
conflicts; the fork delta stays empty until a real seam gap forces a patch.

**Negative and accepted:**
- The plugin contract can change. `scripts/upstream_sync.py` was run against real diffs and
  flagged 18 breaking declarations between `v2.2.7` and `v2.3.2`, so this risk is live, not
  theoretical. Mitigation: pin exact versions and gate upgrades on the report.
- The wrapper must re-implement argument passthrough and keep up with CLI flag changes.
- Bashwink cannot promise compatibility with arbitrary third-party OpenCode plugins.

## Reversal conditions

Revisit if any of these becomes true:
1. A required capability has no plugin seam **and** a core patch would exceed ~200 lines or
   touch more than 3 upstream files.
2. Upstream breaks the plugin hook contract twice within six months.
3. The wrapper cannot pass through a flag Bashwink needs and upstream refuses a seam.

On any of these, escalate to a shallow fork and record the delta in a new ADR.

## Open items (not satisfied)

- **Decision owner is unassigned.** "Bashwink maintainer" is not a person in this
  repository; the sign-off has no accountable individual.
- No independent reviewer has read this ADR.
- The two-day spike was executed in one session on one machine; no second platform
  (Linux) has been exercised for the wrapper approach.

## Follow-up tasks

BW-001, BW-002, BW-003, BW-005, BW-043 — all complete except BW-005's notices file, see
`THIRD_PARTY_NOTICES.md`.

## Source basis

- https://github.com/anomalyco/opencode at `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`
- `packages/plugin/src/promise/tool.ts`, `packages/core/src/plugin/hooks.ts` (v2.3.2)
- https://hermes-agent.nousresearch.com/docs/developer-guide/architecture
- https://github.com/NousResearch/hermes-agent
