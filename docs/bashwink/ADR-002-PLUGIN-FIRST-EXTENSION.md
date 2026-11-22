# ADR-002 — Plugin-first extension, with a documented ordering constraint

**Status:** Accepted
**Date:** 2026-11-22
**Decision owner:** Bashwink maintainer (unassigned individual)
**Depends on:** ADR-001
**Evidence:** `TEST_EVIDENCE.md` BW-003; `packages/core/src/plugin/hooks.ts` @ v2.3.2

## Context

ADR-001 chose plugins over a fork. That decision is only safe if the plugin hooks can
carry the behaviours Bashwink needs: recording tool evidence, refusing unsafe calls, and
observing session/permission events. The spike tested each.

What was proven by execution, not by reading docs:

| Capability | Hook | Proven |
| --- | --- | --- |
| Record a call before it runs | `tool.hook("execute.before")` | Yes — recorded `before` with the command |
| Record the outcome | `tool.hook("execute.after")` | Yes — recorded `exit=0` and `exit=7` |
| Refuse a call | throw inside `execute.before` | Yes — the shell never ran; the tool result was `✗ ... failed` |
| Learn the project directory | `ctx.location.directory` | Yes — needed because `process.cwd()` is the server's |
| Observe session events | `ctx.event.subscribe({ types })` | Source-verified only, **not** executed |
| Observe permission decisions | `permission.hook("evaluate")` | Source-verified only, **not** executed |
| Rename the binary / version string | — | **No seam** (see ADR-003) |

## The constraints this ADR exists to record

### Constraint 1 — a throwing hook aborts the rest of the chain

`trigger` in `packages/core/src/plugin/hooks.ts` runs every registered callback for an
event with `yield* result`. A callback that throws — which is exactly how
`execute.before` denies a call — **aborts the loop**. Every hook registered after the
throwing one never runs.

This was found by accident during the spike and then reproduced deliberately:

- Deny plugin named `bashwink-deny` loaded first (alphabetical plugin discovery), evidence
  second → the call was denied and the evidence log stayed **empty**. A denied call left
  no record at all.
- Reordering so evidence registers first → the `before` entry is written, then the denial
  aborts the chain, so the `after` entry is lost.

The second outcome is acceptable (a denied call has no `after`). The first is not: it makes
the auditor blind precisely when a policy fired.

### Constraint 2 — every subdirectory of `plugin/` is loaded, regardless of config

`PluginSourceDirectory.discover` (`packages/core/src/plugin/source-directory.ts`) walks
`{config}/plugin/` and `{config}/plugins/` and returns **every** file or directory it finds.
Removing a plugin from the config's `plugins` array does **not** disable it.

Observed directly: after deleting `./plugin/zz-deny` from the config array, the deny plugin
still ran and still blocked the call, because its directory was still on disk. It only
stopped when the directory was removed.

Consequence: the wrapper cannot express plugin ordering or enablement by writing a config
list alone. It must control the *contents* of the plugin directory.

## Decision

1. **All Bashwink behaviour ships as plugins.** No upstream file is patched.
2. **The evidence plugin must be registered before any policy plugin.** This is a security
   property. It is enforced three ways: the package name sorts first (`bashwink-evidence`),
   the wrapper CLI writes the plugin list in explicit order rather than relying on
   directory discovery, and `recorder.test.ts` contains a test that fails if the two-hook
   ordering contract changes.
3. **The wrapper owns the plugin directory's contents, not just the config list.** Because
   `plugin/` auto-loads every subdirectory (Constraint 2), disablement means removing the
   directory. The wrapper will stage exactly the plugins it wants and nothing else.
4. **A plugin that denies must not rely on any later hook.** Anything that must be recorded
   about a denied call has to be written by the denying plugin itself, or by an earlier one.
5. **Each plugin does one thing.** Because an exception stops the chain, bundling a recorder
   and a policy into one plugin would make their ordering unexpressible.

## Consequences

**Positive:** no fork; the deny path is proven to actually prevent execution; the ordering
hazard is documented and tested rather than latent.

**Negative and accepted:**
- Registration order becomes a load-bearing property that upstream does not guarantee. A
  future upstream release could sort callbacks differently (e.g. by priority) and silently
  invert this. Mitigation: the sync report watches `packages/core/src/plugin/`, and the
  ordering test pins the assumption.
- Security-critical behaviour depends on a third-party iteration order. If Bashwink ever
  needs a guarantee upstream does not offer, that becomes grounds to revisit ADR-001.

**Not proven and not claimed:** `event.subscribe` and `permission.hook("evaluate")` appear
correct in source and in upstream's own tests, but Bashwink has not exercised either. They
are recorded as available seams, not as verified ones.

## Reversal conditions

- Upstream changes `trigger` to a priority system or to `Effect.forEach` (which would run
  all callbacks regardless of failure): re-run the ordering test, then simplify.
- A required behaviour has no hook: escalate to ADR-001's shallow-fork escape hatch.
