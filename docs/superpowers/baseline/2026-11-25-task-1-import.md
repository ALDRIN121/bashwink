# Local engine migration — Task 1 import record (Gate B)

**Branch:** `local-engine/task-0` (Tasks 0 and 1). **Base:** `4b74ead`.
**Upstream input:** `~/Developer/bashwink-upstream/opencode` at
`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`, tag `v2.3.2`, working tree clean, PTY pin
`03d848f7b8d71d31d3e56f2abd8b337efbc1bc32` present in the same object database.

## The test came first, and failed first

`scripts/test_local_engine.py` was written before any import. Its first execution:

```
$ python3 scripts/test_local_engine.py
PROVENANCE: FAIL
  vendor/engine/UPSTREAM.json is missing. Task 1 requires a provenance manifest naming both
  source pins and the retained file inventory.
exit=1
```

That is the plan's requirement ("confirm the test fails before the import") met by observation
rather than by assertion.

## What was imported, and how the set was measured

`scripts/import_local_engine.py` is a tracked, re-runnable importer rather than a pile of `cp`
commands, so the closure is reviewable and the import can be reproduced.

**The plan's 17-workspace closure cannot install on its own.** Measured, not assumed:

```
$ bun install --frozen-lockfile
error: workspace "@opencode/ai" depends on workspace "@opencode/http-recorder"
       (packages/http-recorder), which is listed in bun.lock but not on disk
error: workspace "@opencode/client" depends on workspace "@opencode/httpapi-codegen"
       (packages/httpapi-codegen), which is listed in bun.lock but not on disk
error: workspace "@opencode/core" depends on workspace "@opencode/http-recorder" ...
note: a pruned checkout must keep every workspace that its remaining workspaces depend on
```

A transitive walk over `workspace:` specifiers across `dependencies`, `devDependencies`,
`peerDependencies` and `optionalDependencies` found **exactly two** missing workspaces, matching
Bun's own list: `packages/http-recorder` and `packages/httpapi-codegen`. Both were added. The
design anticipates this — it calls the 17 a "starting set" and requires the final file set to be
determined by building — so this is the plan working as written, not a deviation.

| Item | Count | Notes |
| --- | ---: | --- |
| Tracked files imported | **5,380** | 59.5 MB uncompressed, 74 MB on disk with manifests |
| Declared workspaces | 17 | the design's production closure |
| Additional workspaces | 3 | `script` (build input), `http-recorder`, `httpapi-codegen` (transitive) |
| PTY helper | 63 files | `packages/process-daemon/`, imported **from its own pin**, not the engine commit |
| Root build inputs | 28 | `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`, `turbo.json`, `.oxlintrc.json`, `LICENSE`, and `patches/` (21 files) |
| Deliberate patches | 0 | none needed yet |

**Workspace-name mapping recorded explicitly:** the design names a workspace `plugins/browser`;
upstream calls the directory `packages/plugin-browser`. The mapping lives in
`vendor/engine/UPSTREAM.json` under `importedWorkspaces` so a future reader cannot conclude the
workspace was silently dropped.

### What was refused, on purpose

- **A 198 MB untracked binary.** `packages/cli/dist/cli-darwin-arm64/bin/opencode` exists in the
  upstream checkout and is **not** tracked by Git. Copying it would have smuggled a prebuilt
  engine into a "build from source" migration — the exact opposite of the task. The importer
  prints that it is refusing it. Vendored size without it: 59.5 MB of tracked source.
- The standalone web app, desktop app, `gui-plugins`, `session-ui`, `nav-menus`, `stories`,
  `services/*`, `packages/data/*`, `.github/*`, and upstream docs/translated READMEs. All listed
  in `UPSTREAM.json.notImported` rather than merely omitted.

## Provenance result — Gate B

```
$ python3 scripts/test_local_engine.py --upstream ~/Developer/bashwink-upstream/opencode
PROVENANCE: PASS
  pins: engine c0ad18b (v2.3.2), helper 03d848f
  notice: LICENSE
  no nested .git metadata
  workspaces: 17/17 present, plus 2 build inputs and the PTY helper
  inventory: 5380 files, exactly matching the tracked vendor tree
  digests: 5380 verified (0 deliberate patch(es))
  upstream HEAD: c0ad18b402eb
  engine pin present: c0ad18b
  helper pin present: 03d848f
  upstream sample: 12/12 files match the pinned blobs
exit=0
```

What this actually proves, and what it does not:

- **Proves:** every tracked vendored file is declared; every declared file has a digest that
  matches either its pinned upstream blob or a recorded patch; the two pins are the exact ones the
  design names; no nested `.git`; the MIT notice travels with the import; 12 sampled files are
  byte-identical to `git show c0ad18b:<path>`.
- **Does not prove:** that the 12-file sample is adequate. It is a spot check, not a full
  re-derivation. A stronger check — recomputing all 5,380 digests from upstream blobs — is cheap
  and should replace the sample before cutover; it is recorded here as a known weakness rather
  than described as full verification.

## Locked install

```
$ cd vendor/engine && bun install --frozen-lockfile
$ bun run script/fix-node-pty.ts
$ husky
.git can't be found
719 packages installed [2.95s]
```

The `husky` failure is expected and harmless: Husky installs Git hooks, and `vendor/engine/` is a
directory inside Bashwink's repository rather than its own checkout. It exits without failing the
install.

**Registry copies of OpenCode packages: zero.**

```
@opencode*: 3 symlinked to local workspace, 0 real directories (registry copies)
```

`node_modules/@opencode/` contains only three symlinks — `client`, `plugin`, `script` — each
pointing into `packages/`. No package named `opencode` downloads.

### But one registry dependency is still declared, and it matters

`@opencode/pty@0.6.0` is **still resolved from the registry in three vendored manifests**:

| Manifest | Field |
| --- | --- |
| `packages/core/package.json` | `dependencies` |
| `packages/cli/package.json` | `dependencies` |
| `packages/server/package.json` | `devDependencies` |

It is present in `bun.lock` with its eight platform variants (`@opencode/pty-darwin-arm64`, …
`@opencode/pty-win32-x64`) and is **not currently installed on disk** — `node_modules/@opencode/pty`
is absent, and no platform package is present either. So the current state is not "it works by
accident"; it is "the declaration exists and resolution is unresolved."

This is exactly what **Task 2** exists to remove: build the PTY helper from
`vendor/engine/packages/process-daemon` and repoint the CLI build and the core PTY binding at the
local artifact instead of the registry package. Task 1 does not close it, and the gate below is
scoped accordingly.

## Gate B verdict

**PASS for Task 1's stated condition**, with the Task 2 dependency recorded:

- Every retained upstream input has provenance and a notice: **yes** — 5,380 files, MIT notice,
  two pins, zero unrecorded patches.
- An imported file can be traced to either its pinned source or a deliberate patch: **yes** by
  digest, spot-checked against real upstream blobs (12/12), with the sample-vs-full weakness
  stated above.
- Hidden registry traffic in the *installed tree*: **none**.
- Registry dependency still *declared* for the PTY helper: **3 manifests** — Task 2's scope, not
  Task 1's.

## Blockers and next task

**Next eligible task: Task 2** — build the PTY helper from the vendored
`packages/process-daemon` Cargo project and remove the `@opencode/pty` registry resolution from
the three manifests, keeping the protocol and access controls.

**Blocker 1 (records against Gate C, not Task 2's start): Zig is absent.** The plan pins Rust
1.90.0 for the daemon and this host has 1.98.1, with toolchains `1.95.0` and `stable` installed.
`packages/process-daemon/rust-toolchain.toml` will pin what Cargo actually uses; that must be read
before the build is attempted, and a Rust version mismatch is a real risk for a
`cargo build --locked` against a pinned `Cargo.lock`.

**Blocker 2 (Gate C/D): Zig is needed for the OpenTUI no-FFmpeg rebuild in Task 3, not Task 2.**
It remains uninstalled, so Gate D cannot be reached on this host without it.

**Blocker 3 (Gate E): the `scope fence` banner regression found in Task 0** — a trusted, enforced
run no longer announces the fence it applied (`937c496` removed the line for trusted workspaces).
Not fixed here: it is outside this plan's scope and belongs in the register.
