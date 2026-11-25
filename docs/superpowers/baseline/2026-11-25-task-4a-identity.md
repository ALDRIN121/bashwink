# Task 4A and the Task 5 source installer

**Branch:** `local-engine/task-0`. Continues from `a7800e5`.
**Commit:** `5ed457f`.
**Installer default: unchanged.** `scripts/build_alpha.sh` and the npm route are untouched; what
changed is that `--install` now refuses to proceed without an engine.

---

## Part 1 — Task 4A: the network surface

### The audit table

| Surface | Destination | Where | State | Mechanism |
| --- | --- | --- | --- | --- |
| Model catalog refresh | `models.opencode.ai` | `vendor/engine/packages/core/src/models-dev.ts` | **closed** | `OPENCODE_DISABLE_MODELS_FETCH=1` on every spawn point; engine boots from the snapshot compiled into the binary |
| Updater | `opencode.ai/update/api/` | `vendor/engine/packages/cli/src/services/updater.ts:608` | **closed** | `OPENCODE_DISABLE_AUTOUPDATE=1` returns before `latest()` is called |
| Upstream account credential | `OPENCODE_API_KEY` bearer | `vendor/engine/packages/ai/src/providers/opencode.ts:23` | **closed** | scrubbed at `launchEnvironment`, the single point every backend passes through |
| Config schema hint | `opencode.ai/config.json` | `packages/bw-cli/src/paths.ts` | **closed** | now the Bashwink-owned schema URL; never fetched (validation is local) |
| Upstream console / MCP OAuth | `opencode.ai/oauth`, `/console` | `vendor/engine/packages/core/src/mcp/oauth.ts`, `console-access.ts` | **unreachable** | no Bashwink command starts MCP OAuth; `bashwink auth` is its own provider configuration |
| Telemetry | — | — | **absent** | no client present; asserted, not assumed |

Provider *inference* destinations (openrouter.ai, api.openai.com, …) are deliberately not in this
table: those are the providers the user selects, which is the supported route.

### The defect this found

The standard native path was the one launch route that did **not** disable the catalog refresh.
`native-sandbox.ts` and `native-offline.ts` set it; `execution-backend.ts` and `private-server.ts`
did not — and those are the paths the npm launcher and a source install use.

So the shipped product refreshed its model catalog from `models.opencode.ai` on a timer, for a
catalog the binary already carries as a pinned snapshot.

Found by **execution**, not reading. `test/engine-environment.test.ts` runs the CLI against a fake
engine that records the environment it is actually handed:

```
(pass) the engine is started with its autonomous catalog refresh and updater disabled
(pass) an inherited setting cannot re-enable the upstream catalog fetch
(pass) no upstream account credential is handed to the engine
```

A test that inspected the source or called the environment-building helper directly would have
passed throughout. That distinction is the reason this test drives a real launch.

### Two judgement calls worth recording

**The updater needed no change.** Rather than add a flag "to be safe", I read `updater.ts:608`: the
`OPENCODE_DISABLE_AUTOUPDATE` check returns `undefined` before `latest()` is reached, so no request
is made even if the command is invoked. Closing a route that was already closed would have been
noise.

**The `$schema` value was never a network route.** Validation is local (`@opencode/schema`), and
nothing fetches the string. It was still wrong: it advertised a foreign product as the source of
truth for a file Bashwink defines. Changed for ownership, not for safety — and the test says so.

### A test I had to fix, not the code

The telemetry check first matched the bare word `segment`, which failed on two comments about
*path segments*. A test that fails on English prose teaches people to weaken it, so it now matches
import specifiers and hostnames.

---

## Part 2 — the Task 5 source installer

### What `--install` does now

1. Resolve a verified engine **before** any install work. Candidates: an explicit `--engine-dir`,
   then `build/local-engine/<target>`, then `build/local-engine`.
2. Reuse a current artifact, or build one from the vendored source.
3. Only then install dependencies, stage, pack, audit, and install globally.

The ordering is the fix. `--install` previously reached npm with no engine at all, producing a
package that exits 127 — and replacing a working installation with one that could not start.

### The regression test

`MissingEngineBeforeInstallTest`, six cases in `scripts/test_local_engine_build.py`:

| Case | Expected |
| --- | --- |
| no engine, no build allowed | refuse, naming `build_local_engine.py --target <t>` |
| engine for another target | refuse, naming both targets |
| artifact changed after build | refuse, "digest does not match" |
| manifest with no digest | refuse — unverifiable is not verified |
| valid engine | reuse, without invoking the builder |
| unreadable manifest | refuse, not crash |

Verified live, not only in the test:

```
no usable local engine for darwin-arm64. Refusing to package an install that cannot start:
  …/nothing-here: no engine-manifest.json
Build one first:
  python3 scripts/build_local_engine.py --target darwin-arm64
```

### Fresh source install, Apple Silicon

No `--engine-dir`, no pre-existing artifact on the first run:

```
engine   no current artifact; building from the vendored source
engine   reusing verified artifact at build/local-engine/darwin-arm64   (second run)

tarball  /tmp/t5-install-real3/bashwink-0.1.0-alpha.1.tgz
sha256   e3f0f5a403445c7f09140869ed011a02438d7c1b66d00d1cb1789f400f386942
size     84,910,642 bytes, 21 files
added 3 packages in 8s
Bashwink installed. Run bashwink doctor to check your setup.
```

Then, from the global install with `BASHWINK_OPENCODE_BIN` unset:

```
✓ OpenCode runtime: verified local engine …/lib/node_modules/bashwink/libexec/opencode
                    (pinned 2.3.2, sha256 069cb0df31c53985…, via manifest)
✓ Bun runtime: bun 1.4.4 on darwin/arm64
```

Engine digest on disk matches the manifest; no `@opencode` package installed.

### Two bugs of my own

Both caught by running it, neither by reading:

- the builder takes `--outdir`, not `--out` — my first invocation silently used the builder's
  default, and the engine landed somewhere the packager was not looking;
- the builder nests output one level per target, so the usable directory is `<outdir>/<target>`,
  not `<outdir>`.

Fixed, and reuse now checks both spellings so an artifact is found either way.

### Pre-existing typecheck errors, fixed

`tsc` was **not** clean before this commit — three errors from `83ec9de`, all in tests: a mutation
of a readonly `engine.path`, `process.exit` not narrowing a type for the checker, and an optional
`mutate` callback passed where a definite one was typed. Fixed; `tsc --noEmit` now reports **0**.

---

## Results by platform

### Apple Silicon (darwin-arm64) — PASSED

Engine resolved/built/reused, tarball packed and audited, installed globally, `doctor` verifies the
manifest, digest matches, no `@opencode` package present.

### Windows x64 — NOT VERIFIED

No Windows host exists on this machine, and `windows-latest` CI requires a push, which needs
explicit authorization. Specifically **not** run:

- `python scripts/build_npm_package.py --install` on Windows
- the native Bun bootstrap with npm lifecycle scripts disabled
- a checkout or temp path containing spaces
- `release/tester-kit/windows-qualify.ps1`
- `opencode-pty.exe` naming and the `win32` target mapping end to end

The `win32` target mapping and `opencode.exe` naming are unit-tested. That is not a Windows
verification and is not reported as one.

### Other platforms — NOT ATTEMPTED

darwin-x64 and the four Linux targets: no build, install or run.

### Licensing — NOT CONCLUDED

Unchanged from Task 5: notices ship, the FFmpeg gate is enforced in resolver and packager, but the
manifest `notices` block is still `null` and the inventory comparison has not run.

---

## Task 5 bullets still open

- **Attestation** binding artifact digest to repo/commit/target/workflow.
- **Prebuilt-route decision** — not started, not documented as if it existed.
- **Shadow CI staging** before removing comparison mode.
- **`python3 scripts/npm_install_check.py <tarball>`** on the exact package per platform.
- **Blocked-npm-lifecycle configuration** and **Windows temporary paths** tests.
- **Failed dependency transfer must leave the previous install usable** — asserted in the refusal
  message, not yet tested by inducing a transfer failure.

## Blockers

- **Windows x64 unverified** — the reason Task 6 cannot close.
- **Banner regression** (`937c496`) still open from Tasks 0 and 4.
- **`notices` unpopulated** in the engine manifest.
- **npm/node are not on the default PATH** (`~/.nvm/versions/node/v24.19.0/bin`); the packager shells
  out to both.

**Next eligible:** the remaining Task 5 bullets, then Task 6 once a Windows host is available.
