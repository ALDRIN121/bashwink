# CI baseline reconciliation

**Audit date:** 2026-11-23. The private repository's default branch is `main`, verified through the authenticated GitHub API. The checkout started clean at `4731eaf11a447fe3a0f3d27c10cbe9a500d42f8a`. GitHub metadata and local results are recorded separately.

## Hosted results

I retrieved each run and each attempt's jobs using `gh api`. Job totals include carried-forward successes on a partial rerun. Times below are GitHub API timestamps in UTC.

| Verify run | Full head SHA | Attempt | Result | macOS jobs |
| --- | --- | ---: | --- | --- |
| [45195209661](https://github.com/ALDRIN121/bashwink/actions/runs/45195209661) | `b38dd513b66704758aa51b6bb0168d62a4d82a69` | 1 | 13 success | CLI, evidence, fixtures and runtime health succeeded |
| [45196502945](https://github.com/ALDRIN121/bashwink/actions/runs/45196502945) | `5ff3ff9673ce712d54c24bf8615d102362888abb` | 1 and 2 | 11 success, 2 cancelled in each view, overall failure | CLI and fixtures succeeded on attempt 1. Evidence and runtime health cancelled twice |
| [45203060880](https://github.com/ALDRIN121/bashwink/actions/runs/45203060880) | `dcbe0507ccded9e7268c4b966c8916bc8dd9b11b` | 1 | 10 success, 3 cancelled, overall failure | Evidence succeeded. CLI, fixtures and runtime health cancelled |
| [45207176296](https://github.com/ALDRIN121/bashwink/actions/runs/45207176296) | `4731eaf11a447fe3a0f3d27c10cbe9a500d42f8a` | 1 | 12 success, 1 cancelled, overall failure | CLI, fixtures and runtime health succeeded. Evidence cancelled |

In all four runs the five single-platform jobs succeeded (lint, docs integrity, secret scan, license scope and scope statement). The Ubuntu evidence, CLI, runtime-health and fixtures legs also succeeded. All cancelled jobs had an empty `runner_name`, zero steps and a 15m01s interval between the listed start and completion timestamps. For example, HEAD's macOS evidence job spans 15:36:47–15:51:48 UTC. The directly observed failure is runner non-assignment. GitHub's scheduler or capacity root cause is unconfirmed. The original record for `45203060880` counted only cancelled jobs in its denominator. The successful evidence leg raises the assigned count to 1/4.

Phase 0 is backed by 9/9 successful `verify` jobs at `bf33e206b1adf856f0a3bf5f180dacde410f0191` and 2/2 separate `upstream-compat` jobs at the same SHA. Phase 1 is backed by 11/11 at `f75392086abbb9261ce9267ffb138f1a05f0967b` and 11/11 at `ad9d44eba04f655ceab1d8ebcb55cb285e4c901e`. All four runs were confirmed through the job API. The later green baseline covered real-runtime plugin health on both platforms. [Phase 0 verify](https://github.com/ALDRIN121/bashwink/actions/runs/45112989970) · [Phase 0 upstream compatibility](https://github.com/ALDRIN121/bashwink/actions/runs/45113462602) · [Phase 1 verify](https://github.com/ALDRIN121/bashwink/actions/runs/45119233542) · [Phase 1 confirming run](https://github.com/ALDRIN121/bashwink/actions/runs/45129207277).

## Baseline equivalence and manifest scope

`git diff --name-only b38dd51..4731eaf` listed only `docs/bashwink/PACKAGE_MANIFEST.json` and `docs/bashwink/TEST_EVIDENCE.md`. The manifest change at `5ff3ff9` replaced the SHA-256 of the alpha checklist. The subsequent commits only appended CI evidence. The manifest is consumed by the docs verifier. Its existence is mandatory in CI, while entry hashes are checked only with `--check-manifest`. No runtime, build, install, packaging, release or workflow consumer of the manifest was found in the tracked source. The docs-verifier job succeeded on every listed run. The manifest's stale task totals were outside the original verifier's checks and are addressed in the audit.

## Decision and follow-up

Use `b38dd51` as the last fully green cross-platform code baseline for the supervised internal alpha. Use the three newer runs for the jobs that actually executed. The latest hosted macOS evidence leg for this sequence remains the successful job on `dcbe050`. The HEAD run is not green. Keep the full `macos-15` matrix active. Obtain fresh per-platform evidence on future runtime changes and evaluate the need for a dedicated runner only if the pattern persists. The weekly/manual upstream workflow is an independent signal. Neither workflow installs a published Bashwink or exercises the new sandbox plan.

Local macOS results, including the independent runtime and install checks, are in [TEST_EVIDENCE.md](TEST_EVIDENCE.md). They support the internal-alpha decision without replacing hosted run outcomes.

Read-only reproduction commands, using an identity with access to the private repository:

```bash
gh api repos/ALDRIN121/bashwink --jq '{private,default_branch}'
gh api 'repos/ALDRIN121/bashwink/actions/runs?per_page=12'
gh api repos/ALDRIN121/bashwink/actions/runs/45207176296
gh api 'repos/ALDRIN121/bashwink/actions/runs/45207176296/attempts/1/jobs?per_page=100'
git diff --name-status b38dd51..4731eaf
```
