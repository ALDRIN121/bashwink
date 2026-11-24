# Bashwink — Alpha Release Checklist

**Target:** v0.1 private alpha, a small group of real developers.
**Rule:** an item is checked only against executed evidence. Anything unverified stays unchecked
with the reason stated. This file is the gate; the narrative lives in `TEST_EVIDENCE.md`.

Last evaluated: 2026-11-23.

---

This checklist records the audited cross-platform baseline. The newer execution foundation
has local verification and open Phase 2 acceptance. See [TEST_EVIDENCE.md](TEST_EVIDENCE.md)
for its exact results and [BW-018](BW-018_IMPLEMENTATION_REPORT.md) for the startup gap.

## A. Build health

- [x] `bun run typecheck` clean (both packages).
- [x] `bun test packages` — **369 pass / 0 fail**, 19 files.
- [x] `oxlint --deny-warnings packages` clean.
- [x] `bun fmt --check packages` clean.
- [x] `scripts/verify_bashwink_docs.py` → `Audit: PASS`.
- [x] `scripts/generate_status_summary.py --check` → status block matches the register.
- [x] Hosted credential-pattern scan succeeded at the audited code baseline. The handoff diff was checked locally with the workflow patterns.

## B. Interactive entry point (Priority 1)

Driven for real in a PTY, not merely observed booting: a prompt was typed, a model answered, a
file was edited, and a test was run and re-run to PASS.

- [x] Bare `bashwink` launches the runtime TUI rather than printing help.
      **Was broken:** `first === undefined` printed help. Fixed, and the no-argument branch now
      forwards an empty argv.
- [x] Works in a **Git** directory. `fixtures/interactive-entry/run.sh` → boot entry with
      `location=/private/tmp/bw-tui-git`.
- [x] Works in a **non-Git** directory → `location=/private/tmp/bw-tui-nogit`.
- [x] Works in a **deep subdirectory** → `location=/private/tmp/bw-tui-nested/deep/sub`.
- [x] Uses the current working directory; the staleness bug (a fixed repo path) is not present.
- [x] Displays the active workspace — the TUI renders the path in its footer; the record
      independently confirms the same `location`.
- [x] Model selection reflected in the TUI status bar (`Build · Claude Sonnet 5 CommandCode`).
- [x] Interactive chat and tool execution work (a `shell` call ran and was recorded).
- [x] Bare invocation with neither stdin nor stdout attached to a terminal prints help.
- [x] All existing subcommands preserved: `--version`, `--help`, `doctor`, `plan`, `contract`,
      `evidence`, `trust`, `resume`, `auth`, `model`.
- [x] Runs from an installed distribution outside the checkout.
- [x] Startup failure is now reported by cause: a held service port is named with its PID and a
      way out, instead of being misreported as an evidence-plugin failure.
- [x] Historical fixture 7/7. Fresh installed CLI PTY smoke passed in three directory types using a private local runtime service.
- [x] A real coding task completes interactively: `add` fixed from `a - b` to `a + b`, tests
      `PASS`, only `calc.py` modified.
- [x] Session recovery after restart: `--continue` restored the conversation and the model
      recalled its own earlier fix.
- [x] Evidence health: 3 boot records for 3 launches, 9/9 tool calls attributed, chain re-verified
      independently.
- [ ] **In-session model switching via the TUI picker: NOT tested.** Switching was verified via
      `--model`/`model use` only.

## C. Security boundary (Priority 2, BW-059)

- [x] `allowedPaths` enforced at the tool layer (`execute.before`), not by prompt.
- [x] Allowed edits succeed (real model: `src/calc.py` fixed, tests pass).
- [x] Forbidden edits refused (real model: two outside writes refused, files absent).
- [x] Path traversal refused (`../outside` resolved and refused).
- [x] Symlink escape refused — containment is decided on `realpath` of the deepest existing
      ancestor, so `link -> /etc` then `link/passwd` is refused even though the lexical path is
      inside the workspace.
- [x] Absolute paths validated (`/etc/passwd`, `/tmp/...` refused).
- [x] Recognized shell calls with an out-of-scope working directory or obvious outside
      path are refused. Allowed shell calls are recorded as `unconstrained`.
- [ ] OS confinement for the owned OpenCode server, CLI/TUI, shell and descendants.
      Demonstrate filesystem enforcement, credential protection, network policy and cleanup
      from a normal install without Docker, Podman or a daemon. BW-031 and BW-032 are open.
- [x] Permission decisions are auditable: `denied` entries carry the rule, the resolved target
      and the allowed set.
- [x] Denials recorded accurately: 2 denials in the live run, each naming the target.
- [x] The loaded plugin refuses recognized writes and shell for an untrusted workspace. Evidence-off or absent scope policy removes this protection.
- [x] Unconstrained calls are recorded under their own phase, so the denial count stays truthful.
- [x] Fixture `fixtures/scope-fence/run.sh` → **10/10** against a live model.


## D. First-run experience (Priority 3)

- [x] `doctor` on a clean home exits 0 (12 checks, 8 warnings, 0 failures) from an unrelated directory.
- [x] Missing credentials produce a named variable plus an `export ...` line, before the runtime
      starts when an explicit configured model is requested.
- [x] Provider connection works from an install outside the checkout.
- [x] Model selection works from the installed binary.
- [x] A real coding task succeeds from the installed binary.
- [x] Prior live evidence covers continuation across invocations using two wire protocols.
- [x] Evidence and logs remain available after the process exits, and survive `SIGKILL`.
- [x] Uninstall is documented (delete the directory and `BASHWINK_HOME`).
- [x] Installation method documented honestly, including that `npm install -g` does **not** work.
- [x] `bashwink` available on `PATH` via the built install's `bin`.

## E. Quality gates (Priority 4)

- [x] Dependency licence inventory checked: `1643` packages, `48` requiring a decision, `48`
      decisions recorded, `open + release-blocking: (none)`.
- [x] Provider secrets absent from logs, config and build artifacts — the real key value was
      searched for across the install and data roots and found in **no** file.
- [x] Redaction proven at the boundary: a credential-shaped string echoed by the agent was
      recorded as `[REDACTED]`.
- [x] Known limitations documented (`KNOWN_LIMITATIONS.md`), including the concrete shell escape
      and the section it lives in.
- [ ] Qualify the revised [native-first implementation plan](BW-031_IMPLEMENTATION_PLAN.md)
      using the [BW-032 platform matrix](BW-032_PLATFORM_QUALIFICATION.md), including real
      provider connectivity and fail-closed startup on both supported platforms.
- [ ] Dependency **vulnerability** audit (`bun audit` / advisory database): **not run** — no
      advisory source is configured in this environment, and inventing a clean result would be
      worse than recording the gap.

## F. Release readiness (Priority 5)

- [x] `ALPHA_RELEASE_CHECKLIST.md` (this file).
- [x] `ALPHA_TESTER_GUIDE.md`.
- [x] `KNOWN_LIMITATIONS.md`.
- [x] `LLM_INTEGRATION_AUDIT.md` with source revisions.
- [x] BW-091 added to the task register for the already-implemented provider/model work.
- [x] `README.md`, `IMPLEMENTATION_STATUS.md`, `TEST_EVIDENCE.md`, `NEXT_STEPS.md`,
      `PHASE_GATE_CHECKLIST.md`, `DECISIONS.md`, ADR-011 updated.
- [x] Last fully green cross-platform code baseline confirmed at `b38dd51`, 13/13 on first attempt.
- [ ] All hosted jobs passed at `4731eaf`. Twelve passed and macOS evidence was cancelled before allocation. [CI reconciliation](CI_BASELINE_RECONCILIATION.md).
- [ ] **Release published:** NO — requires explicit approval. Not requested, not done.
- [ ] **Repository visibility changed:** NO — out of scope, not done.

## G. Phase status honesty

- [x] Phase 0 gate: PASS (unchanged).
- [x] Phase 1 gate: PASS (unchanged; the trust claim it made is now actually enforced).
- [x] Phase 2: **not** marked complete. BW-059 moves to Done; BW-091 recorded as implemented;
      the remaining Phase 2 tasks stay `Not started`, including BW-057, BW-058, BW-060, BW-075.
- [x] The Phase 2 gate is **not** claimed.

---

## Native qualification gate

Run `python3 scripts/verify_alpha_release.py --revision <candidate-sha>` for the
macOS-only v0.1.0-alpha. The gate requires every macOS control on the named Apple
Silicon OS build, exact-candidate macOS and Ubuntu regression CI, and the verified
archive checksum. The broader two-platform native qualification remains available
through `scripts/verify_native_release.py`.
[v0.1.0-alpha decision](releases/v0.1.0-alpha/RELEASE_READINESS.md) · [Qualification results](BW-032_QUALIFICATION_RESULTS.md).

## Verdict

**Supervised internal alpha: CONDITIONAL.** Use the verified code baseline with evidence
enabled in trusted, disposable or backed-up projects under supervision. Check changes and test
results independently.

**External developer alpha: FAIL. Public release: FAIL.** BW-031 is the primary external
blocker. Phase 2 test integrity, independently linked verification and packaged alpha criteria
remain open. Hard execution and spend ceilings are required for unattended use.
[Internal alpha readiness](INTERNAL_ALPHA_READINESS.md).


## Live provider evidence update

A CommandCode model completed a disposable installed-VM coding and resume exercise.
The release gate remains failed pending full platform qualification, a clean
installation, remaining relay and export controls, and release-candidate evidence.
See [test evidence](TEST_EVIDENCE.md).


## Milestone 5 release decision

Personal use is conditional on supervised use of the locally provisioned fixture.
Internal alpha remains conditional. External alpha and public release remain FAIL.
The local build lacks VM assets, the clean install and release archive are not
qualified, and mandatory platform, lifecycle, provider, and CI evidence remains
incomplete. See [current evidence](TEST_EVIDENCE.md).


## Milestone 6 release decision (v0.1.0-alpha.1 RC1)

Personal use CONDITIONAL, internal alpha CONDITIONAL, external alpha FAIL, public release FAIL.
A local archive exists and the secure default is evidenced on an engineering host. Clean-host
qualification, live-provider qualification, hosted CI and the licensing sign-off are outstanding.
[Gate report](releases/v0.1.0-alpha.1/RELEASE_GATE_REPORT.md).

---

## Standard npm package: external-alpha gate (candidate `npm-rc1`, 2026-11-25)

An external (invited, other people's machines) alpha needs every row PASS. Today it does not have that.

| # | Gate | Status | Note |
| --- | --- | --- | --- |
| 1 | Tarball builds from a clean commit, byte-reproducibly | **PASS** | `e0a3f48f…d458`, two independent builds identical |
| 2 | Tarball audited: no workspace deps, dev paths, credentials, tests, VM assets | **PASS** | 19 files, audit in the builder |
| 3 | Installs from the tarball with no source checkout (macOS arm64) | **PASS** | |
| 4 | Installed command: version, doctor, refused `--sandbox`, trust question, label, evidence, signal exit, uninstall | **PASS** on macOS arm64 | 27 checks |
| 5 | Same on a clean machine, Windows 11 x64, Linux, macOS Intel | **BLOCKED / NOT_RUN** | no hardware; CI legs written, not run |
| 6 | Live model session with tool calls, edit, approval, resume on the installed package | **BLOCKED** | no key reachable |
| 7 | Standard-mode permission negative tests end to end (denials survive `--auto`, contract denies shell, stale boot evidence rejected) | **NOT_RUN** on the installed package | policy plugin tested in earlier phases only |
| 8 | Minimum quality controls: bounded retries, cancellation, usage/cost visibility | **NOT DONE** | |
| 9 | Hosted CI green on the candidate SHA, all legs, none skipped or cancelled | **NOT_RUN** | push not authorized |
| 10 | Licensing decision for npm-downloaded upstream runtimes (LGPL FFmpeg in stock OpenCode, JSC in Bun) | **OPEN** | notices written; no sign-off |
| 11 | Dependency audit (`npm audit`, transitive licences) of the installed tree | **NOT_RUN** | |
| 12 | Independent review of the security model and the claims in the docs | **NOT_RUN** | |
| 13 | Tester kit: README, guide, limitations, security notes, checksum procedure | **PASS** (written; not yet used by a person other than the author) | |
| 14 | Public npm release | **NOT AUTHORIZED** | `prepublishOnly` blocks `npm publish` |
