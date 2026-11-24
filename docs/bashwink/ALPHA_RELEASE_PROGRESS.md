# Bashwink private alpha — progress record

This file is the resume point for the private npm-tarball alpha (mission of 2026-11-25). A new agent should be able to
continue from here without conversation history. Update it at every milestone. Facts here are either linked to
evidence or marked unverified.

## Mission in one paragraph

Ship `bashwink-0.1.0-alpha.1.tgz` (private, `npm pack`; never `npm publish`) so a developer on Windows 11 x64 (first),
then macOS/Linux, can `npm install -g ./bashwink-….tgz`, `cd project`, `bashwink`, set up a provider, ask for a change,
approve tools, run tests, exit and resume. Standard native permission-controlled mode is the default ([ADR-015](DECISIONS.md));
`--sandbox` (VM) is optional and separately gated. No Chat Memory Engine, no Rust migration, no public publication.

## Current state (2026-11-25)

| Item | Value |
| --- | --- |
| Branch / HEAD | `codex/v0.1.0-alpha-preparation`; see `git log` (RC2 records are the latest commits) |
| Tags | `v0.1.0-alpha.1-rc1` (RC1, untouched), `v0.1.0-alpha.1-rc2` (RC2 candidate `20c8473b`, local) |
| Remote / push | none authorized. Hosted CI never run on RC1 or RC2 |
| Task register | 91 tasks: 22 Done, 4 In progress (BW-018, BW-030, BW-031, BW-032 area), 65 Not started. **Unchanged by this work** |
| Latest release report | `releases/v0.1.0-alpha.1/rc2/RC2_REPORT.md` (RC2 = the optional-sandbox macOS artifact) |
| Live key | `~/.config/bashwink-qual/commandcode.key` was reported created but is **not visible to the agent session**. Never read. Live provider tests are BLOCKED |
| Windows / Linux hardware | none available to the agent |

## Baseline (Milestone 0)

**IMPLEMENTED AND VERIFIED** (macOS arm64, local, with evidence): wrapper over a private pinned OpenCode server; policy
plugin readiness before prompts; workspace trust, ScopeFence, TaskContract; evidence recording with hash chain;
provider/model config and switching (`auth add|status|check|remove`, `model list|use|current`); session resume;
`doctor`; runtime fixtures (readiness 11, tool lifecycle 19, contract 14, idempotent resume 10) pass against the
FFmpeg-free runtime; 515 unit/integration tests; VM backend (RC2) incl. stage registry, lifecycle, 30-minute deadline,
reproducible archive.

**IMPLEMENTED BUT UNVERIFIED:** hosted CI at HEAD (last green cross-platform commit is `b38dd51`, 13/13, long before the VM
work and RC1/RC2); standard-mode live coding on current HEAD (historic live runs exist, see TEST_EVIDENCE); Linux at any
recent commit; anything on Windows.

**PARTIALLY IMPLEMENTED:** BW-018 (permission enforcement: native path enforced, startup gap documented in
BW-018_IMPLEMENTATION_REPORT), BW-030 (backend abstraction: `local` and VM), BW-031/032 (VM backend macOS-only,
unqualified on a clean host), BW-091 (providers: CommandCode live-verified; others synthetic or blocked).

**BROKEN / MISSING FOR THIS MISSION:**
- Packaging: `@bashwink/cli` is `private` with `workspace:*` on a private `@bashwink/evidence`; `bin` is `src/bin.ts`
  (Bun-only); no `files`, no tarball. `npm install -g` cannot work today.
- Runtime resolution assumes Unix names (`opencode`, `node_modules/.bin`, PATH) and the plugin stager uses symlinks
  (`paths.ts`), which need privileges on Windows (junctions are the portable alternative).
- Host-path code uses `bun:sqlite`, `Bun.spawn` and other Bun APIs, so the CLI itself needs a Bun runtime. The
  `bun` npm package (platform packages for Windows x64/arm64) can supply it.
- The release build flavor is VM-default (`__BASHWINK_RELEASE__`); there is no "standard" flavor and no `--sandbox` flag.
- No Windows CI job; no PowerShell/cmd handling audit; BW-057/058/075 (protected tests, verification, budgets) Not started.

**NOT IMPLEMENTED:** BW-075 cost/execution budgets beyond the VM relay's request limit; Windows ARM64 path; clean-host
evidence on any OS.

**SUPERSEDED RELEASE REQUIREMENTS:** "VM is the default" and "macOS-only" (ADR-013 parts) → ADR-015; the RC1/RC2 archive
layout is the *optional sandbox* artifact now.

## Facts established for packaging (verified 2026-11-25 with `npm view`)

- `@opencode/cli@2.3.2` is on public npm with optional platform packages for darwin x64/arm64, linux x64/arm64 (+ musl,
  baseline), **windows x64 and windows arm64** (and baseline x64). So a `dependencies` entry installs the upstream runtime.
  Those upstream binaries embed FFmpeg (LGPL) inside libopentui; ADR-009 and the RC2 FFmpeg-free rebuild
  (`release/NOFFMPEG_RUNTIME.md`) apply. Whether *downloading* them from npm at install time is acceptable is a licensing
  decision for the owner; it is not assumed resolved.
- `bun@1.4.4` is on public npm with `@oven/bun-windows-x64` and `@oven/bun-windows-aarch64` platform packages.
- Design under evaluation: a tarball with a Node launcher (`bin/bashwink.js`, works with npm's `.cmd`/PowerShell shims),
  a bundled `lib/bashwink.js`, the evidence plugin copied in, and pinned `bun` and `@opencode/cli` dependencies.

## Decisions so far

ADR-015 (standard default, sandbox optional), ADR-016 (future engines, direction only), ADR-013/014 (sandbox mechanisms).

## Done since the baseline (local commit; usage limit reached mid-milestone)

- **Standard flavor** (`__BASHWINK_STANDARD__`): native default, mode `standard-native` (label `STANDARD`, persistent TUI
  line "STANDARD - native, not a sandbox"), `--sandbox` fails closed and is recorded (`sandbox-unavailable`), the
  environment cannot select the VM/backend/provider path, the runtime must be passed by the launcher (never found on
  PATH), sandbox subcommands refused, first-run trust offer (declining is allowed; the session stays read-only).
  9 new tests; full suite **524 pass**; lint and typecheck clean.
- **npm launcher** `release/npm/bin/bashwink.js` (CommonJS, Node >=18): platform plan (Windows ARM64 refused explicitly),
  finds the pinned `bun` and `@opencode/cli` platform binaries as npm-installed dependencies, passes
  `BASHWINK_OPENCODE_BIN`. `release/npm/package.json` is the package manifest (exact pins, `prepublishOnly` blocks
  publishing).
- **`scripts/build_npm_package.py`**: assembles the package, `npm pack`, audits the tarball. First run produced a
  186 KB / 15-file tarball and **failed its own audit**: `package/lib/evidence/src/recorder.ts` contains the string
  `/Users/me/` (almost certainly an example in a comment). Triage it (change the example, do not weaken the audit).

## Next exact engineering actions (in order)

1. **DONE on macOS arm64 (engineering host, not a clean host):** the audit finding was a comment example and is fixed
   (the audit stays strict). The tarball installs with `npm install -g <tgz>` into a throwaway prefix, cache and HOME in
   ~18 s with no source checkout, and `fixtures/release/npm_smoke.py` passes 17/17 checks against the installed package:
   `--version`, `doctor` finds the npm-installed runtimes and plugin, `--sandbox` fails closed (exit 3, recorded), the
   first-launch trust question, the TUI starts, the persistent `[STANDARD - native, not a sandbox]` label is on the
   rendered screen, evidence boots, SIGTERM ends the session with 130 and the run record says `standard-native` with
   evidence `recorded`, a second launch does not ask again, no process is left, `npm uninstall -g` removes the command
   and leaves the user's state and project alone. Result file:
   `docs/bashwink/releases/v0.1.0-alpha.1/npm-candidate/npm_smoke_macos_arm64.json`. The tarball built for it came from a
   dirty tree, so it is **not** a candidate; the candidate is built from a clean commit.
   Defects found and fixed by running the installed package (none were visible from the source checkout):
   - npm's `bun` package moves the binary out of the platform package into `bun/bin/bun.exe`; the launcher looked only in
     the platform package.
   - The launcher did not forward SIGTERM/SIGINT/SIGHUP, so the runtime died without finalizing its run record
     (`evidence: pending`). It forwards them now.
   - OpenCode's JSX transform skips any file whose path contains `node_modules`, so the TUI plugin failed with "Cannot
     find package '@opentui/solid'" (a visible "Plugin failed" banner; no label). The same files load from a path without
     that segment (measured, same runtime, both the stock npm runtime and the rebuilt one). Plugins are therefore staged as a
     **copy** when the package lives under `node_modules` and on Windows (symlinks need a privilege there); never a
     second copy of `@opencode/plugin` (the host refuses one). 8 new tests; 539 pass, lint and typecheck clean.
   Still unverified: that Windows' platform packages contain `bin/bun.exe` and `bin/opencode.exe` as assumed (the launcher
   tries both names); Linux and Windows installs; reinstall/upgrade over an existing install.
2. Add the standard-mode PTY/fixture checks to the runner and a `windows-latest` CI job.
3. Windows portability audit of shared code (symlink staging → junction/copy, Unix tool calls, `process.getuid`, paths,
   signals); add unit tests that run everywhere; add a `windows-latest` CI job; write the Windows x64 qualification script
   and manual checklist. Real Windows qualification stays BLOCKED until hardware exists.
4. Live-provider qualification of the installed tarball when the key is reachable.
5. Licensing: owner decision on npm-downloaded upstream runtimes versus an FFmpeg-free private runtime artifact; dependency audit.
6. Tester kit, release manifest, checksums, final report.

## Blockers needing the owner

Make the key file reachable; provide a Windows 11 x64 (and ARM64) machine or CI runner access; authorize pushing a
candidate branch for hosted CI; licensing decision; Apple Developer account for notarization of the sandbox artifact.

## Unverified claims (do not repeat as facts)

Anything about Windows behaviour; live coding on the current HEAD; hosted CI; that the npm-packaged standard path works
(not built yet).
