# ADR-013: Standard native mode is the default; the isolated VM is optional; distribution is a private npm tarball

**Status:** Accepted (owner direction, 2026-11-25). **Supersedes:** the VM-default product direction of RC1/RC2.
**Related:** ADR-003 (wrapper CLI), ADR-009 (distribution and FFmpeg), ADR-010, ADR-012 (private runtime readiness).

## Context

RC1 and RC2 made a macOS-only isolated VM the default experience. That is the wrong default for the intended
user, who runs `npm install -g ./bashwink-0.1.0-alpha.1.tgz`, opens a project and types `bashwink`, on Windows 11 x64
first and then macOS and Linux. A VM that needs Apple's Virtualization framework cannot be that experience, and
requiring one would exclude most of the intended testers.

## Decision

1. **Standard mode runs natively and is permission-controlled. It is not an operating-system sandbox**, and no
   interface, document or message may call it one. An approved shell command runs with the user's own access.
2. **`bashwink --sandbox` selects the optional isolated VM.** It is explicit, fails closed, and never falls back to
   native execution. The VM and its guest image are not part of the standard package: asking for it there stops with
   exit 3, starts nothing and records the refusal. The VM work stays in the repository, separately gated.
3. **Distribution is a private npm tarball** containing only Bashwink's own files. The pinned runtimes (`bun@1.4.4`,
   `@opencode/cli@2.3.2`) are exact-version dependencies that npm installs for the user's platform. `npm publish`
   is blocked by a `prepublishOnly` guard; a public release is a separate owner decision.
4. **OpenCode remains the inference runtime.** Bashwink configures it and wraps it; it does not replace inference,
   streaming or tool execution.
5. **What standard mode does enforce** (each is exercised against the installed package by `fixtures/release/npm_qual.py`):
   untrusted workspaces get no writes, reads or commands; the task contract narrows paths and removes the shell tool;
   tools without an execution policy (arbitrary code execution, network tools, sub-agents) are refused by default;
   explicit user denials survive `--auto`; a policy plugin that fails to start stops the run before any model request,
   and evidence from an earlier run is never accepted as proof; the runtime is a private, attested server on a random
   port, never a server found by name or port; provider keys are removed from shell environments and masked in evidence.
6. **Usage safeguards read the runtime's own events** (ADR-013 follow-on, `usage-guard.ts`): bounded retries, a
   request limit, optional token and cost limits, and a usage summary. Enforcement sits outside the model's reach.
7. **Evidence is a hash-chained record, not a tamper-proof one.** The same user account can rewrite it.

## What this does not claim

- That native permission controls prevent every host access. A command a user approves can do anything the user can.
- A hard monetary ceiling. A request already in flight when a limit is crossed is not recalled and may be large.
- That a scripted-provider result says anything about how well a real model codes.

## Consequences

- The standard package is small (about 190 KB) and the same artifact serves every platform; platform-specific
  binaries come from the pinned runtime packages.
- The package makes the stock OpenCode and Bun binaries hard dependencies. ADR-009 says the stock LGPL-containing
  binary is not a release artifact without counsel's sign-off; this model does not ship those bytes but does cause
  them to be installed. That is an open owner decision (see `STANDARD_PACKAGE_LICENSING.md`), not a resolved one.
- Windows ARM64 has no qualified execution path and is refused by the launcher; it is never advertised.
- VM-only code (about 6,200 lines in `bw-cli/src`) ships nowhere in the standard package.

## Alternatives rejected

- *VM as the default:* excludes Windows and Linux and makes first run depend on a hypervisor.
- *Bundle a rebuilt, FFmpeg-free runtime (ADR-009 PM-1) in the tarball:* removes the LGPL FFmpeg question for the
  runtime but costs a large artifact per platform and a maintained build; not justified before a concrete need.
- *Make the runtimes peer dependencies the user installs first:* the cleanest licensing story (ADR-009 PM-0) but
  breaks the one-command install. Kept as the fallback if counsel objects to the hard dependency.
