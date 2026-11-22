# Bashwink — Test Evidence Register

**Revision under test:** Bashwink working tree at 2026-11-23 (post-remediation);
foundation = OpenCode `v2.3.2` (`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`).
**Environment:** macOS 27.0.1, arm64 (Darwin 27.0.0), Bun 1.4.5 (upstream pins 1.4.4),
Git 2.54.0. One machine. No Linux or Windows run. **No hosted CI run of any kind.**
**Evidence is authoritative only if reproducible at this revision.**

## Remediation evidence (independent review findings F-01 … F-10)

All defects were **reproduced against the delivered code before being fixed**. The reproduction
harness and its output are recorded below.

| Finding | Command | Observed before fix | Observed after fix |
| --- | --- | --- | --- |
| **F-02** object bypass | `normalise({nested:{message:'x'.repeat(10000)}}, 100)` | **10,025 bytes** stored, `truncated: true` | **105 bytes** stored, `truncated: true` |
| **F-02** array bypass | `normalise(<2000-element array>, 100)` | **134,891 bytes** | **111 bytes** |
| **F-02** multibyte | `normalise({t:'€'.repeat(5000)}, 100)` | **15,008 bytes** | **104 bytes** |
| **F-03** note redaction | token written via `note` | **present on disk** | `[REDACTED]` |
| **F-03** raw `record()` | token written via `record()` | **present on disk** | redacted |
| **F-04** peer pin | `packages/bw-evidence/package.json` | `^2.3.2` (caret) | exact `2.3.2` |
| **F-04** clean consumer | `bun install` in empty dir, registry only | never performed | **259 packages, exit 0**, `@opencode/plugin@2.3.2` |
| **F-04** plugin identity | `import("@opencode/plugin")` | unverified | `Plugin` export present; our definition's key set **matches** `Plugin.define` output |
| **F-01** runner label | `grep macos-14 .github/workflows/` | present | absent; `macos-15` (retirement confirmed from GitHub's changelog) |
| **F-08** resume on tampered log | reopen after editing an entry | extended the corrupted chain | **refuses**; `health.ok === false`, `length === 0` |

### Bashwink's own suite

| Command | Result | Exit |
| --- | --- | --- |
| `bun run test:evidence` | **47 pass / 0 fail**, 95 `expect()` calls | 0 |
| `bun run --cwd packages/bw-evidence typecheck` | clean | 0 |
| `python3 scripts/verify_bashwink_docs.py` | `Audit: PASS` | 0 |
| `python3 scripts/generate_status_summary.py --check` | status block matches the register | 0 |
| `python3 scripts/check_license_scope.py --inventory docs/bashwink/DEPENDENCY_LICENSES.json` | 48/48 decided | 0 |
| `... --fail-on-open` | correctly fails on the one OPEN release blocker | **3** |
| `./fixtures/reset.sh --check` | all 5 at baseline | 0 |
| live agent run, hardened recorder | `before` + `after`, `exit=7` recorded | 0 |

Test count went 32 → 47: **15 new regression tests**, none existing test weakened or removed.

### Reproduction harness output (before → after)

```
F-02 serialized length = 10025 (cap 100)   ->  105
F-02b array serialized length = 134891     ->  111
F-02c multibyte bytes = 15008 (cap 100)    ->  104
F-03 token on disk in note = true          ->  false
F-03b raw record() token on disk = true    ->  redacted
--- 5 defect(s) reproduced ---             ->  --- 0 defect(s) reproduced ---
```

## Phase 0 tasks

| Task | Revision | Command / test | Exit | Evidence | Supports acceptance? |
| --- | --- | --- | ---: | --- | --- |
| BW-001 | `c0ad18b40` | `git describe --tags` → `v2.3.2`; `bun install --frozen-lockfile` (1,583 pkgs, 75 s) | 0 | `UPSTREAM_BASELINE.md` §1–2 | Yes — SHA, license, toolchain, commands recorded |
| BW-002 | `c0ad18b40` | `bun run --cwd packages/core test` (macOS `/bin/bash` 3.2.57) | 1 | 7,553 pass / 39 skip / **3 fail** | Yes — failures diagnosed, not hidden |
| BW-002 | `c0ad18b40` | `bun run --cwd packages/core test` (**bash 5.3.20 first on `PATH`**) | **0** | **7,556 pass / 39 skip / 0 fail**, 98,776 `expect()` calls, 293 s | **Yes — the 3 failures were the interpreter, confirmed** |
| BW-002 | `c0ad18b40` | `bun run --cwd packages/cli test` | 0 | 408 pass / 9 skip / 0 fail | Yes |
| BW-002 | `c0ad18b40` | `bun run --cwd packages/sdk test` | 0 | 40 pass / 0 fail | Yes |
| BW-002 | local | `bun run --cwd packages/cli build --single --skip-install --skip-web-ui` | 0 | `dist/cli-darwin-arm64/bin/opencode`, 198 MB | Yes |
| BW-002 | local | `./opencode --version` | 0 | `opencode v0.0.0-detached-202611221836` | Yes |
| BW-002 | macOS `/bin/bash` 3.2.57 | `bash -c '[[ -n <(printf x > m) ]]; wait "$!"'` | 127 | `wait: pid … is not a child of this shell` | Yes — root cause of the 3 failures |
| BW-003 | local | 32 unit tests, `bun run test:evidence` | 0 | 32 pass / 0 fail | Yes |
| BW-003 | local | `tsc --noEmit -p packages/bw-evidence/tsconfig.json` | 0 | clean | Yes |
| BW-003 | live | agent turn vs. mock provider: tool call → `printf 'bw-mock-ok\n'` → evidence `before`+`after` `exit=0` | 0 | `evidence.jsonl` 2 entries, chain verified | **Yes — controlled tool call recorded** |
| BW-003 | live | failing variant: `printf 'bw-mock-fail\n'; exit 7` | 0 | evidence recorded `exit=7`, not a false success | Yes |
| BW-003 | live | deny probe: throw in `execute.before` | 0 | tool result `✗ … failed`; **no marker file created** | **Yes — deny seam proven** |
| BW-003 | live | ordering swap (deny registered before evidence) | 0 | evidence log **empty** after denial | Yes — found constraint 1: a throwing hook aborts the rest of the chain |
| BW-003 | live | removed `zz-deny` from config `plugins` array, directory still on disk | 0 | call still denied | Yes — found constraint 2: `plugin/` auto-loads every subdirectory, config list does not disable |
| BW-004 | — | ADR-001 written and signed | — | `ADR-001-FOUNDATION-AND-FORK.md` | Partial — **owner unassigned, no reviewer** |
| BW-005 | `c0ad18b40` | walk 1,641 `package.json` files, tally `license` | — | MIT 1,218 / Apache 142 / ISC 118 / LGPL 4 / none 37 | Partial — **notices file not generated** |
| BW-006 | — | `.github/workflows/verify.yml` written | — | **never executed** | **No** |
| BW-007 | local | `fixtures/create_fixtures.sh` | 0 | 5 fixtures, baselines in `BASELINES.txt` | Yes |
| BW-007 | local | `fixtures/reset.sh --check` on dirty tree | 1 | rejects: `HEAD is baseline but the working tree is dirty` | Yes — negative path |
| BW-007 | local | `fixtures/reset.sh` then `--check` | 0 | all 5 at baseline, tree clean | Yes |
| BW-007 | local | `cd fixtures/failed-test && bun test` at baseline | 1 | 2 pass / 1 fail (`trims leading and trailing dashes`) | Yes — reproduces the bug |
| BW-007 | local | same fixture, fixing **implementation** only | 0 | 3 pass / 0 fail | Yes — fix shape is correct |
| BW-007 | local | `cd fixtures/one-file-edit && bun test` at baseline | 1 | 2 pass / 1 fail (`subtracts in the documented order`) | Yes |
| BW-043 | `c0ad18b40` | `upstream_sync.py --offline` | 0 | verdict `BASELINE_ONLY` | Yes |
| BW-043 | `v2.3.1` | `upstream_sync.py --target v2.3.1` | 0 | `LOW_RISK`, 77 files, 1 commit | Yes |
| BW-043 | `v2.2.7` | `upstream_sync.py --target v2.2.7` | **1** | `REVIEW_REQUIRED`, 3,404 files, **18 breaking declarations** | Yes — detector is not vacuous |
| BW-090 | — | ADR-002…006 written | — | `ADR-002`…`ADR-006` | Yes |

## Known failures — resolved

The 3 shell-scan parity failures seen on the first run were **entirely the interpreter**, now
confirmed rather than inferred. Re-running the identical suite with bash 5.3.20 first on
`PATH`:

```
7556 pass   39 skip   0 fail   98776 expect() calls
Ran 7595 tests across 326 files. [293.35s]      EXIT=0
```

Baseline expectation for CI: **7,556 / 0 fail with bash ≥ 4.3**, and `3 fail` with macOS
`/bin/bash` 3.2.57. Both are recorded so a future run can be diagnosed instantly.

Root cause, reproduced outside the harness:

```
$ /bin/bash --noprofile --norc -c '[[ -n <(printf x > m) ]]; wait "$!"'
/bin/bash: wait: pid … is not a child of this shell      # exit 127
```

macOS `/bin/bash` is 3.2.57 (GPLv2; Apple does not ship bash 4+). The suite needs
`probe() case … esac` in command substitution and `wait "$!"` after a process substitution,
both bash-4 syntax. Upstream files were **not** patched (BW-002 says document first).

## Claims explicitly NOT made

- No Linux or Windows run of any command.
- The GitHub Actions workflow has **never been executed** — it is unverified YAML.
- `ctx.event.subscribe` and `permission.hook("evaluate")` are source-verified only, never
  exercised.
- The wrapper CLI (ADR-003) is not implemented.
- No real-model agent run has been performed; all agent turns used the mock provider.
