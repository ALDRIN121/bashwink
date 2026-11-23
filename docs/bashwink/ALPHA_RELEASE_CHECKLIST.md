# Bashwink — Alpha Release Checklist

**Target:** v0.1 private alpha, a small group of real developers.
**Rule:** an item is checked only against executed evidence. Anything unverified stays unchecked
with the reason stated. This file is the gate; the narrative lives in `TEST_EVIDENCE.md`.

Last evaluated: 2026-11-23.

---

## A. Build health

- [x] `bun run typecheck` clean (both packages).
- [x] `bun test packages` — **365 pass / 0 fail**, 18 files.
- [x] `oxlint --deny-warnings packages` clean.
- [x] `bun fmt --check packages` clean.
- [x] `scripts/verify_bashwink_docs.py` → `Audit: PASS`.
- [x] `scripts/generate_status_summary.py --check` → status block matches the register.
- [x] No secret in the working tree or the diff (scanned).

## B. Interactive entry point (Priority 1)

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
- [x] Piped bare invocation prints help instead of hanging (a TUI cannot render into a pipe).
- [x] All existing subcommands preserved: `--version`, `--help`, `doctor`, `plan`, `contract`,
      `evidence`, `trust`, `resume`, `auth`, `model`.
- [x] Runs from an installed distribution outside the checkout.
- [x] Startup failure is now reported by cause: a held service port is named with its PID and a
      way out, instead of being misreported as an evidence-plugin failure.
- [x] Fixture passes **7/7**.

## C. Security boundary (Priority 2, BW-059)

- [x] `allowedPaths` enforced at the tool layer (`execute.before`), not by prompt.
- [x] Allowed edits succeed (real model: `src/calc.py` fixed, tests pass).
- [x] Forbidden edits refused (real model: two outside writes refused, files absent).
- [x] Path traversal refused (`../outside` resolved and refused).
- [x] Symlink escape refused — containment is decided on `realpath` of the deepest existing
      ancestor, so `link -> /etc` then `link/passwd` is refused even though the lexical path is
      inside the workspace.
- [x] Absolute paths validated (`/etc/passwd`, `/tmp/...` refused).
- [x] Shell cannot **silently** bypass: out-of-scope `workdir` and obvious outside path
      arguments are refused, and every permitted shell call is recorded as `unconstrained`.
- [x] Shell **can** still bypass through an interpreter — documented, not hidden. This is why the
      item above says "silently".
- [x] Permission decisions are auditable: `denied` entries carry the rule, the resolved target
      and the allowed set.
- [x] Denials recorded accurately: 2 denials in the live run, each naming the target.
- [x] Workspace trust is **enforced**, not merely recorded. It previously was not: `evaluateCall`
      existed but nothing called it, so `doctor`'s "denied by default" was false. Now an
      untrusted workspace refuses writes and shell, verified with a real model.
- [x] Unconstrained calls are recorded under their own phase, so the denial count stays truthful.
- [x] Fixture `fixtures/scope-fence/run.sh` → **10/10** against a live model.
- [ ] **Not claimed:** full sandbox isolation. There is none.

## D. First-run experience (Priority 3)

- [x] `doctor` on a clean `BASHWINK_HOME` exits 0 with actionable guidance and no credential
      values (`12 checks, 0 failures`).
- [x] Missing credentials produce a named variable plus an `export ...` line, before the runtime
      starts.
- [x] Provider connection works from an install outside the checkout.
- [x] Model selection works from the installed binary.
- [x] A real coding task succeeds from the installed binary.
- [x] Sessions persist, including across a model switch between two wire protocols.
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
- [x] Known limitations documented (`KNOWN_LIMITATIONS.md`).
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
- [x] Committed and pushed.
- [x] GitHub Actions green on both platforms.
- [ ] **Release published:** NO — requires explicit approval. Not requested, not done.
- [ ] **Repository visibility changed:** NO — out of scope, not done.

## G. Phase status honesty

- [x] Phase 0 gate: PASS (unchanged).
- [x] Phase 1 gate: PASS (unchanged; the trust claim it made is now actually enforced).
- [x] Phase 2: **not** marked complete. BW-059 moves to Done; BW-091 recorded as implemented;
      the remaining Phase 2 tasks stay `Not started`, including BW-057, BW-058, BW-060, BW-075.
- [x] The Phase 2 gate is **not** claimed.

---

## Verdict

**Private-alpha readiness: FAIL as a public release, PASS as a supervised internal alpha.**

The distinction is the shell boundary. Every *file* write is fenced and audited, but a shell
command can still write anywhere the interpreter can reach, and `KNOWN_LIMITATIONS.md` says so in
the first section. For a small group of developers running against their own repositories with
someone watching the first sessions, that is an acceptable and honestly-stated risk. For an
unattended run, or a beta audience, it is not.

**To lift to PASS for a wider alpha:**

1. BW-031 (sandbox) or an equivalent OS-level boundary — this is the blocker.
2. BW-057/BW-058 (protected tests) so "tests pass" cannot be earned by editing the tests.
3. BW-075 (budget) so an unattended run cannot run away.
4. Windows either verified or explicitly unsupported in the install docs.
