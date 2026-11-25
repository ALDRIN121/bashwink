# Task 4 — Bashwink connects to the built engine without behavior changes

**Branch:** `local-engine/task-0`. Continues from `32865ba`.
**Status:** resolution and verification complete and exercised against the real 196 MB artifact.
Policy handshake and a scripted coding task ran through the vendored engine. **Installer unchanged.**

## 1. What changed, and why it had to

Before this task, `resolveRuntime` looked in three places: `BASHWINK_OPENCODE_BIN`, then
`node_modules/.bin/opencode` upward from the cwd, then `opencode` on `PATH`. For a locally built
engine that is the wrong shape of trust — `PATH` is attacker-influenced in ordinary use, and "the
first executable called `opencode`" is not the binary this project built.

`packages/bw-cli/src/engine-manifest.ts` (new, 230 lines) verifies a manifest produced by
`scripts/build_local_engine.py` and returns the engine path. In packaged mode that is the only
accepted answer; there is no fallback, because every fallback is a way for a different `opencode`
to run.

Refusal set, each closed **before** any output is printed or any model call is made:

| Condition | Refusal names |
| --- | --- |
| manifest absent | the path, and what to do instead |
| manifest not JSON | the parse error |
| `schemaVersion` ≠ 1 | both versions |
| manifest built for another platform | the manifest's target and the host's |
| engine file missing | the resolved path |
| engine path outside the manifest root (incl. `..`) | both paths |
| symlink pointing outside | the **resolved** path, so a string check cannot pass |
| digest absent | "cannot be verified" — not a skip |
| digest mismatch | expected **and** actual |
| `ffmpegMarkers` non-empty | the markers |

`runtime.ts` gained `source: "manifest"` and passes `engineManifest`/`engineRoot` through.
`main.ts` uses it when `RELEASE_BUILD`, keyed on `BASHWINK_ENGINE_MANIFEST` from the launcher.
`release/npm/bin/bashwink.js` supplies that variable and **does not** set `BASHWINK_OPENCODE_BIN`
when a local engine is present, so no npm `@opencode/cli-*` platform package is consulted at all.

The launcher deliberately does not verify the digest itself — the runtime does, so there is exactly
one implementation of that check and the two cannot disagree. The launcher does refuse a manifest
that exists but does not parse, rather than quietly looking for another engine.

## 2. Tests, written first and observed failing

`packages/bw-cli/test/engine-manifest.test.ts` — 12 tests. First run:

```
error: Cannot find module '../src/engine-manifest'
 0 pass
 1 fail
```

Then 12/12 pass. The suite is mostly *refusals*, because a test that only proved "a good manifest
works" would pass for a resolver that also used a lookalike from `PATH`.

## 3. The real artifact, not a fixture

`packages/bw-cli/test/engine-manifest.probe.ts` drives `resolveRuntime({ engineManifest })` exactly
as `main.ts` does, against the actual 196 MB engine and its actual manifest:

```
$ bun run test/engine-manifest.probe.ts ~/…/task4-packaged
  PASS  1. valid manifest — control
        resolved: source=manifest command=opencode
        sha256:   069cb0df31c53985d9d10609c43fea3d699501b9afcde4a4da47779c59d8a20e
  PASS  2. missing engine binary
        refused:  … the engine named by the manifest is missing: '…/opencode'
  PASS  3. modified engine binary
        refused:  … the engine digest does not match the manifest. expected 069cb0df…
  PASS  4. no manifest at all
        refused:  … no engine manifest at '…'
  PASS  5. wrong-platform manifest
        refused:  … the engine manifest is for 'linux-x64' but this host is 'darwin-arm64'
  PASS  6. path escaping the package directory
        refused:  … the engine named by the manifest is missing: '…'
  PASS  7. symlink to a binary outside the directory
        refused:  … the engine path escapes the build root: '/private/var/…'
  PASS  8. manifest with a null digest
        refused:  … records no sha256 for 'opencode', so the artifact cannot be verified

8/8 probe cases behaved as required
```

Case 7 is the one that matters most: the symlink's **digest is correct**, so only containment
refuses it. A digest check alone would have run it.

**This had to be a probe, not a CLI run, and that is worth stating.** The release CLI gates on an
interactive TTY acknowledgment (`--unsafe-local`) before it ever resolves a runtime, so the matrix
cannot be driven through the packaged entry point non-interactively. Two earlier attempts proved
that the hard way — every case returned the same VM-gate message, and the "control" did not
succeed either. Reporting those as results would have been reporting six identical failures as a
refusal matrix.

## 4. A lookalike on `PATH` is never used

A convincing impostor — named `opencode`, executable, prints `opencode LOOKALIKE v9.9.9`, and
appends to a log if it ever runs — placed **first** on `PATH`:

```
$ PATH="$LOOK:$PATH" bun $PKG/bin/bashwink.js --version
bashwink 0.0.0-unknown
  lookalike ran? no
```

The launcher passed to the runtime:

```
BASHWINK_ENGINE_MANIFEST=…/task4-pkgroot/engine-manifest.json
BASHWINK_ENGINE_TARGET=darwin-arm64
BASHWINK_OPENCODE_BIN=(unset)
```

`BASHWINK_OPENCODE_BIN` unset is the point: the legacy resolution path is unreachable, not merely
lower priority. A corrupt manifest is a hard stop with no fallback:

```
$ PATH="$LOOK:$PATH" bun $PKG/bin/bashwink.js --version
bashwink: …/engine-manifest.json is not valid JSON: JSON Parse error: Expected '}'
  lookalike ran? no
```

## 5. Policy boot handshake, and one allowed action plus one denial

`fixtures/scope-fence/run.sh` against the vendored engine
(`BASHWINK_OPENCODE_BIN` = the built artifact):

```
PASS  policy mode is enforce
PASS  policy carries the contract's path — paths=/private/tmp/bw-scope-fixture/src
PASS  traversal target absent
PASS  absolute target absent
PASS  at least one denial recorded — denials=2
PASS  denial names the reason
PASS  run recorded as evidence
PASS  in-scope edit applied
PASS  the test file is untouched
FAIL  the run announced the fence it applied (expected yes, got no) — 3

passed: 9  failed: 1
```

The evidence chain from that run, in order:

```
boot → model → boot → model → before → before → denied → denied
     → before → after → before → after → boot → model → before → after …
```

Two denials, an allowed edit that landed, and the out-of-fence test file untouched.

**The one failure is not this task's.** It is the banner regression recorded in the Task 0 baseline:
`937c496` ("Gate Bashwink execution on private runtime readiness") removed the
`scope fence: enforcing …` line for trusted workspaces, and `fixtures/scope-fence/run.sh:140` still
greps for it. Pre-existing, reproduced here with the engine identified, and recorded rather than
explained away. It should be fixed or the fixture amended, on purpose, before Gate E.

## 6. The scripted coding task

Task: a repository with `src/calc.py` where `add` returns `a - b`, and a `check.py` asserting
`add(2,3) == 5`. Before: `AssertionError: add(2,3) = -1`. The model was asked to fix the bug, run
the check, and change only `src/calc.py`.

**Not yet confirmed in this record.** Two attempts were made and both failed for reasons of my own
that are not engine defects:

- attempt 1 seeded no `BASHWINK_HOME`, so no provider config existed and the run fell back to
  `claude-sonnet-5`, which returned `Invalid 'Authorization' header or token`.
- the retry at the time of writing is still running.

Asserting a pass here before the run returns would be exactly the kind of claim this project does
not accept. The result goes in below when it exists.

## 7. Toolchain that built the PTY helper, versus toolchains on the host

These are different questions and the manifest now answers them separately.

| | Version | Evidence |
| --- | --- | --- |
| **Built the PTY helper** | **rustc 1.90.0** (1159e78c4 2025-09-14), cargo 1.90.0 | `rustup show active-toolchain` inside `packages/process-daemon` reports `1.90.0-aarch64-apple-darwin (overridden by …/rust-toolchain.toml)`; the pin is `channel = "1.90.0", profile = "minimal"` |
| Host default Rust | 1.98.1 | `rustc --version` at the repo root |
| Installed Rust toolchains | `stable-aarch64-apple-darwin` (active, default), `1.90.0-aarch64-apple-darwin`, `1.95.0-aarch64-apple-darwin` | `rustup toolchain list` |
| **Zig for the helper** | **0.16.0** | `zig version`, from `/tmp/zig-install/zig-aarch64-macos-0.16.0` |
| **Zig for OpenTUI** | **0.17.0** | `zig version`, from `/tmp/zig-install/zig-aarch64-macos-0.17.0` |
| Host Zig | none via Homebrew | `brew list --versions zig` → not installed |
| Bun | 1.4.4 | `bun --version` |

The earlier manifest recorded `rustc 1.98.1` in the one field meant to describe the helper. That was
a real provenance error: the probe ran at the repo root, where `rust-toolchain.toml` does not apply.
The manifest now carries **both** — `toolchains.rust` (host default) and
`toolchains.ptyHelperRust` (what actually compiled the helper) — so neither can be mistaken for the
other. `strings` on the helper finds neither version, so the pin plus `rustup`'s own override report
is the evidence, not a string scan.

Note also that the **engine** is a Bun `--compile` and invokes no Rust at all; searching it for a
`rustc` version string finds nothing, which is the expected result and why the engine's build does
not depend on the Rust pin.

## 8. Manifest hygiene, found while doing this

The manifest is now shipped inside the package, so absolute home paths are both a privacy leak and a
false claim about reproducibility. Removed:

- `buildCommand.cwd` → `vendor/engine/packages/cli` (was an absolute path)
- `buildCommand.argv` absolute `--outdir=…` → `--outdir=<build-outdir>`
- `buildCommand.env.BASHWINK_PTY_DIR` → `<local-pty-dir>`
- `toolchains.paths.*` → basenames instead of full paths

One home path survived the first attempt because the rewrite tested `a.startswith("/")` against an
argument beginning `--outdir=`; the condition is now explicit and verified directly rather than by
another four-minute rebuild.

## 9. Regressions

Bashwink's own suites, after all Task 4 edits: **583 pass / 0 fail** (498 `bw-cli` including the 12
new, 85 `bw-evidence`). Manifest tests 17/17. Provenance unchanged.

## 10. Results by platform

### Apple Silicon (darwin-arm64) — PASSED

Resolution and verification (8/8 probe cases against the real artifact), lookalike refused with no
fallback, launcher env proven, policy handshake 9/10 with the denial records present, both Zig pins
and both Rust facts recorded distinctly.

### Windows — NOT ATTEMPTED

No host. The launcher's Windows x64 mapping and `.exe` naming remain unit-tested from before
(`resolvePlatform("win32","x64")` → `@opencode/cli-windows-x64`, `executable: ".exe"`), and Windows
ARM64 is explicitly refused. Nothing was built, run, or claimed for Windows, and the manifest
verification path has never executed there.

### Other platforms (darwin-x64, linux-x64/arm64, musl) — NOT ATTEMPTED

The resolver's platform check is exercised only for the mismatch case (a `linux-x64` manifest
refused on darwin-arm64). No build or run exists for any of these.

### Licensing — NOT CONCLUDED

The manifest carries `notices.inventory = null` and `notices.sha256 = null`, so it does **not** yet
assert a notice inventory. Escalated to Gate E. The FFmpeg-marker check is enforced in the resolver
and covered by tests, but a marker scan is evidence, not legal clearance.

## Blockers and next eligible task

- **Coding-task result pending** — see §6.
- **Banner regression** (`937c496`) — pre-existing, needs a decision: restore the emission or amend
  the fixture. Blocking a clean Gate E.
- **`notices` unpopulated** in the manifest.

**Next eligible: Task 5**, and Task 6 follows it; neither can close Gate E while the licensing gate
and the target matrix are open.

**Installer unchanged** — `scripts/build_alpha.sh` and the npm layout still select the current
runtime.
