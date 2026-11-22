# Bashwink — Upstream Baseline Record

**Status:** baseline pinned and verified on one machine (macOS arm64).
**Verified:** 2026-11-22.
**Task:** BW-001.

This record covers the **OpenCode** foundation only. Hermes Agent was investigated as a
design reference (see §6) and is deliberately **not** a dependency.

---

## 1. Pinned OpenCode revision

| Property | Value |
| --- | --- |
| Repository | https://github.com/anomalyco/opencode |
| Selected tag | `v2.3.2` |
| Commit SHA | `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1` |
| Commit date | 2026-11-18T00:28:06Z |
| Commit subject | `release: v2.3.2` |
| Root package version | `2.3.2` |
| License | MIT (`LICENSE`, "Copyright (c) 2025 opencode") |
| Additional license files | `packages/ui/LICENSE`, `packages/http-recorder/LICENSE`, `packages/process-daemon/LICENSE` |
| Default branch at pin time | `dev` = `d9dacaf52592dcdaaac3cf52f175d8ae8e541a26` |

The tag is used, not `dev`: a release build must not track a moving branch.

## 2. Toolchain

| Requirement | Upstream declaration | Present on verification host |
| --- | --- | --- |
| Bun | `1.4.4` (`package.json` → `packageManager`) | **1.4.5** (patch drift, see §7) |
| Node | only for the `build:node` variant | v26.7.0 |
| OS / arch verified | — | macOS 27.0.1, arm64 |
| Git | any | 2.54.0 (Apple Git-157) |
| Python | not required by OpenCode | 3.x used for Bashwink tooling |

`bunfig.toml` sets `install.exact = true` and `minimumReleaseAge = 259200` (3 days), so
upstream resolves only versions published at least three days earlier. Bashwink inherits
this through the lockfile.

## 3. Repository scale

| Metric | Value |
| --- | --- |
| Tracked files | 11,548 |
| Source size (excl. `node_modules`, `.git`) | 161 MB |
| Workspace packages | 34 top-level under `packages/`, plus `services/` and `sdks/` |
| Test files (`*.test.ts`) | 1,519 |
| Installed packages (unique) | 1,641 |
| `node_modules` after install | 2.7 GB |
| Built CLI binary | 198 MB |

Largest source subtrees: `services/site` 55.6 MB, `packages/ai` 21.4 MB,
`packages/app` 20.1 MB, `packages/core` 18.1 MB, `packages/desktop` 10.0 MB.

## 4. Build and test commands (observed)

```bash
# install (pinned)
bun install --frozen-lockfile

# CLI entry point without building a binary
bun run --cwd packages/cli src/index.ts --version     # -> opencode vlocal

# full single-arch binary build
bun run --cwd packages/cli build --single --skip-install --skip-web-ui
# -> packages/cli/dist/cli-darwin-arm64/bin/opencode     (198 MB)

# unit suites (bunfig.toml forbids running tests from the repo root)
bun run --cwd packages/core test
bun run --cwd packages/cli  test
bun run --cwd packages/sdk  test

# lint / typecheck
bun run lint
bun run typecheck
```

### Observed results

| Command | Result | Exit | Duration |
| --- | --- | --- | --- |
| `bun install --frozen-lockfile` | 1,583 packages installed, 3 postinstalls blocked | 0 | 75 s |
| `bun run --cwd packages/cli src/index.ts --version` | `opencode vlocal` | 0 | ~4 s |
| `bun run --cwd packages/core test` | 7,553 pass / 39 skip / 3 fail | 1 | 201 s |
| `bun run --cwd packages/core test` (bash 5.3.20 on `PATH`) | **7,556 pass / 39 skip / 0 fail** | **0** | 293 s |
| `bun run --cwd packages/cli test` | 408 pass / 9 skip / 0 fail | 0 | 212 s |
| `bun run --cwd packages/sdk test` | 40 pass / 0 fail | 0 | 14 s |
| `bun run --cwd packages/cli build --single --skip-install --skip-web-ui` | built `cli-darwin-arm64` | 0 | ~9 min |
| built binary `--version` | `opencode v0.0.0-detached-202611221836` | 0 | <1 s |

**Total: 8,004 passing, 48 skipped, 0 failing** (with bash ≥ 4). On macOS `/bin/bash` 3.2.57
the same suite reports 8,001 passing and 3 failing — see the diagnosis below.

### Known failures (3 on macOS, 0 with bash 5)

All three were environment-dependent, not product defects. **Confirmed, not inferred** — the
identical suite run with bash 5.3.20 first on `PATH` reports `7556 pass / 0 fail` (exit 0).

1. `ShellTool conditional process substitution > conditional substitutions respect once`
2. `ShellTool conditional process substitution > conditional substitutions respect always`
3. `real-shell compound syntax > bash: printf '%s' "$(probe() case value in value) scan_probe;; *) scan_other;; esac; probe)"`

Cause, reproduced directly outside the test harness:

- Failure 3: the test executes the source with whatever `bash` is on `PATH`. macOS ships
  **bash 3.2.57**, which rejects `probe() case ... esac` inside command substitution with
  `syntax error near unexpected token 'newline'`. The syntax requires bash ≥ 4.
- Failures 1–2: the tests use `[[ -n <(printf reached > marker) ]]; wait "$!"`. Under bash
  3.2 `wait` reports `pid ... is not a child of this shell` and exits 127, so the asserted
  `{ status: "completed", metadata: { exit: 0 } }` cannot match. Reproduced directly:

  ```
  $ /bin/bash --noprofile --norc -c '[[ -n <(printf reached > marker) ]]; wait "$!"'
  /bin/bash: wait: pid 76363 is not a child of this shell      # exit 127
  ```

These are **not** patched: BW-002 requires documenting upstream failures before changing
anything. They are excluded from the Bashwink gate by requiring bash ≥ 4 (§7).

## 5. Published packages (important for fork strategy)

All five relevant packages are published to npm at the pinned version, HTTP 200 for
`https://registry.npmjs.org/<pkg>/2.3.2`:

| Package | Published |
| --- | --- |
| `@opencode/cli` | yes |
| `@opencode/core` | yes |
| `@opencode/plugin` | yes |
| `@opencode/sdk` | yes |
| `@opencode/schema` | yes |

This means Bashwink can depend on OpenCode as a **library/peer** rather than vendoring
the tree, which is the basis of the ADR-001 decision.

## 6. Hermes Agent (reference only)

| Property | Value |
| --- | --- |
| Repository | https://github.com/NousResearch/hermes-agent |
| Local checkout inspected | `~/.hermes/hermes-agent` @ `3b421578588243f920886e6fe79a6faa87ea026e`, tag `v0.23.1` |
| Upstream `main` at verification | `0f602c5f6f18615632535251d62a2db74ce93b69` |
| Tag `v0.23.1` | `b65acf3fdc1d43bd889211ea8e37032974b395a5` |
| License | MIT |
| Language | Python |
| Role in Bashwink | concept reference only |

Concepts evaluated for adoption (as requirements, not code): provenance-tagged memory,
skill curation with review, pluggable execution backends, delegation with budgets.
Rejected: importing the Python `AIAgent` runtime as a second orchestration loop. See
`DECISIONS.md` ADR-002.

## 7. Reproducibility details

- **Host:** macOS 27.0.1 (Darwin 27.0.0), arm64, Apple clang 21.0.0.
- **Bun drift:** upstream pins `1.4.4`; verification ran on `1.4.5`. The lockfile
  resolved cleanly and every observed command succeeded. CI pins `1.4.4` so results are
  comparable to upstream's own CI. **Unverified:** an exact `1.4.4` local re-run.
- **Install warnings (non-fatal):** four `patches/*.patch` files no longer apply because
  the packages they patch are no longer installed (`@standard-community/standard-openapi`,
  `@ai-sdk/mistral`, `@ai-sdk/google`) or have moved (`gcp-metadata` 8.1.2 → 8.1.4).
- **Disk:** a full install needs ~2.7 GB; a `--single` build adds ~200 MB. The default
  (non-`--single`) build additionally installs every platform's native binaries
  (`bun install --os=* --cpu=* --libc=*`) and exhausted a disk with 1.7 GB free. CI must
  use `--single` per platform leg, or provide ≥15 GB free.
- **Test isolation:** `bunfig.toml` sets `[test] root = "./do-not-run-tests-from-root"`,
  so `bun test` from the repo root fails by design. Always use the per-package script.
- **Shell requirement:** the 3 failing tests need bash ≥ 4 on `PATH`. macOS `/bin/bash` is
  3.2.57 (GPLv2, last version Apple ships). `brew install bash` (5.3.20 verified) satisfies
  them — the same suite then reports **7,556 pass / 0 fail**. Bashwink CI installs bash 5 for
  this reason. **Expected CI baseline: 7,556 / 0 fail.**
- **Sandboxing:** the core suite requires a writable `TMPDIR`; it creates `oc-*` temp homes
  and strips credential-like environment variables from the child environment.

## 8. Reviewer sign-off

| Item | State |
| --- | --- |
| Baseline SHA recorded | yes — `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1` |
| License recorded | yes — MIT, plus 3 additional MIT files |
| Toolchain recorded | yes |
| Clean install recorded | yes, macOS arm64 |
| Build recorded | yes |
| Test results recorded | yes, including 3 known environment failures |
| Exact Bun 1.4.4 re-run | **not done** (1.4.5 used) |
| Risk owner | Bashwink maintainer (unassigned individual — see `NEXT_STEPS.md`) |
