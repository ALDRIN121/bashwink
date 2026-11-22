# ADR-003 — Branding via a companion wrapper CLI, not an in-process rename

**Status:** Accepted
**Date:** 2026-11-22
**Decision owner:** Bashwink maintainer (unassigned individual)
**Depends on:** ADR-001, ADR-002
**Evidence:** `TEST_EVIDENCE.md` BW-003; built binary reports `opencode v0.0.0-detached-202611221836`

## Context

Bashwink must present itself as `bashwink`, not `opencode`: its own name in `--help`, its
own version, its own config directory. The draft ADR assumed a shallow fork would be needed
for this. The spike asked a narrower question first: does any plugin seam expose naming?

## Findings

No plugin surface controls the binary name or product version.

- The name comes from the CLI's own spec (`packages/cli/src/commands/commands.ts`) and the
  build script's `binary`/target naming — both compile-time.
- `--version` prints the packaged version, resolved from the build, not from a plugin.
- A plugin receives `ctx.app { name, version, channel }` as read-only context (visible in
  `packages/core/src/plugin/host.ts`). It can observe the identity; it cannot change it.
- The built artifact confirms it: `opencode --version` → `opencode v0.0.0-detached-202611221836`,
  the name hardcoded by the build, even with Bashwink plugins loaded.

So in-process branding is impossible without patching core.

## Options

| Option | Branding | Cost | Verdict |
| --- | --- | --- | --- |
| **Companion wrapper that execs the pinned runtime** | Full: own name, version, help epilogue, config dir | ~200 lines, plus arg passthrough upkeep | **Accepted** |
| Shallow fork renaming the binary | Full | Whole-tree rebase per upstream release | Rejected — ADR-001 |
| Plugin-only, accept `opencode` name | None | Zero | Rejected — product requires its own name |
| Ship a shell alias / docs-only rename | Cosmetic | Zero | Rejected — not a real product identity |

## Decision

`bashwink` is a **thin TypeScript launcher** that:

1. Resolves the pinned OpenCode runtime (exact version from `package.json`).
2. Sets `OPENCODE_CONFIG_DIR` to Bashwink's own config directory, so user config does not
   collide with a real OpenCode install.
3. Writes the plugin list into that config **in explicit order**, evidence first
   (ADR-002's security property — not left to directory discovery).
4. Execs the runtime with the user's arguments unchanged.
5. Handles `--version`/`--help` itself so the product name is Bashwink's, then delegates
   everything else.
6. Propagates the exit code and signals exactly.

## Consequences

**Positive:** real product identity with zero upstream divergence; upgrades are version
bumps; a genuine OpenCode install on the same machine keeps working (separate config dir).

**Negative and accepted:**
- Arg passthrough is a maintenance surface: when upstream adds a flag, the wrapper must
  know whether to handle or forward it. Rule adopted: forward everything except the flags
  the wrapper owns (`--version`, `--help`), so new upstream flags work without a wrapper
  release.
- The wrapper cannot change what the runtime prints *internally* (banner, TUI title). Those
  remain OpenCode's until a fork is justified.
- `exec`-replacing the process means the wrapper must not buffer stdio, or interactive TUI
  behaviour breaks. Verified requirement, unit-testable with a fake runtime.

## Reversal conditions

- If more than a handful of flags need wrapper-level handling, the wrapper is accreting a
  CLI of its own: reconsider a shallow fork.
- If upstream adds a supported branding/env seam, delete the wrapper's naming logic.

## Status of the wrapper itself

**Not implemented in Phase 0.** This ADR records the decision and its evidence; the code is
Phase 1 work. `NEXT_STEPS.md` lists it as the first Phase 1 task.
