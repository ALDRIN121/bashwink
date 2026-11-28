# Contributing to Bashwink

Bashwink is an evidence-first coding agent: it records what it actually did — commands, exit codes,
outputs, hash-chained — instead of reporting what it claims to have done. That premise applies to
contributions too. **A claim without a command and an exit code is not a result here**, and a PR that
says "tests pass" without saying which tests will be sent back.

The project is at `v0.2.0-alpha.2`. Phases 0 and 1 are gate-passed; the Phase 2 gate is **open**
(see [supported platforms](docs/bashwink/SUPPORTED_PLATFORMS.md) for exactly which rows are unproven).
That means there is real, bounded work available — much of it on hardware the maintainer does not own.

---

## 1. Find the work, then get it assigned

**Do not start coding on an unclaimed issue.** Two people fixing the same defect from different
directions wastes both, and a surprise PR is usually unmergeable because it was built on assumptions
nobody agreed to.

1. **Pick an issue.** Open issues are labelled. `help wanted` means takeable now. `good first issue`
   means small and self-contained.
2. **Comment to claim it**, naming what you will do and what you can actually run:

   ```
   Claiming this.

   Plan: <one or two sentences, the approach not the history>
   I can run: <OS + arch, e.g. Ubuntu 24.04 x64 / macOS 15 arm64 / Windows 11 x64>
   Node: <node -v>
   ETA: <rough>
   ```

   For the multi-row qualification issue ([#121](https://github.com/ALDRIN121/bashwink/issues/121)),
   **name the rows you are taking**, e.g. "claiming `linux-x64` and `linux-arm64`". Several people may
   work that issue at once as long as the rows are distinct.
3. **Wait for assignment.** The maintainer assigns the issue (or a slice of it) to you and confirms
   scope. If someone else already claimed it, the maintainer will say so and point you at another.
4. **Then start.** Do not open a PR before assignment on anything larger than a typo — an unassigned
   PR is closed with a link back to the issue.

If you find a bug with no issue, **open the issue first** (repro steps, expected vs actual, your
environment). Offering to fix it in the same issue is welcome; that is how most fixes start here.

---

## 2. Set up locally

You need **very little**, and that is deliberate: the standalone build has zero runtime dependencies.

| Requirement | Why |
| --- | --- |
| **Node.js >= 22.13.0** and **npm >= 10** | The product floor. CI tests exactly `22.13.0` and `22`. |
| **Git** | Workspace fixtures and diff inspection. |
| `python3` with `pty` + `termios` *(POSIX only)* | Drives the real-TUI end-to-end tests. |
| **Bun 1.4.4** *(optional)* | Only for `lint`, `format`, `typecheck` and the legacy workspace tests. Pin it: `curl -fsSL https://bun.sh/install \| bash -s "bun-v1.4.4"`, then put `~/.bun/bin` on `PATH` — the npm scripts shell out to `bun`, so the binary without the `PATH` entry fails as `bun: command not found`. |

```bash
git clone https://github.com/ALDRIN121/bashwink.git
cd bashwink
node -v                      # must be >= 22.13.0
npm run install:local        # build + audit + npm install -g
```

You do **not** need OpenCode, Hermes, Pi, Rust, Zig, or a VM.

### The four standalone gates

These run on a pristine clone with nothing but Node and npm — no `node_modules` required. Run all four
before you open a PR:

```bash
npm run test:standalone               # unit, provider, scope, cost-cap, real-PTY widget tests
npm run test:standalone:install       # tarball build, audit, space-prefix, upgrade, corrupt tarball, uninstall
npm run test:standalone:e2e           # 12 adversarial real-PTY scenarios (POSIX; Windows delegates to ConPTY)
npm run test:standalone:independence  # clean clone with no vendor/, node_modules/, build/, Bun, OpenCode
```

### If you touched docs, or the task register

```bash
python3 scripts/verify_bashwink_docs.py    # must print "Audit: PASS"
```

### If you have Bun (semantic lint and types)

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint                  # oxlint, warnings denied
bun run format                # bun fmt --check
```

---

## 3. Make the change

```bash
git checkout -b fix/tui-composer-redraw     # <type>/<short-slug>
```

**Commit style** — `type(scope): subject`, lowercase, imperative, no emoji, no trailing period. Match
what is already in `git log`:

```
fix(tui): clear the abandoned composer rows when the suggestion menu shrinks
fix(setup): confirm before saving a hosted provider with no credential
test(win-e2e): launch node directly under the pseudoconsole
docs: name the current alpha in the sandbox known limitation
```

Types in use in the history: `feat`, `fix`, `test`, `docs`, `ci` (`npm` appears once, historically).
Scopes are narrow and lowercase: `tui`, `standalone`, `setup`, `audit`, `build`, `install-test`,
`independence`, `tools`, `win-e2e`.

Branch names in the history: `fix/...`, `docs/...`.

### Non-negotiables

These are not style preferences — they are the product.

- **Every bug fix lands with a test that fails without the fix.** The maintainer verifies this by
  running your test on `origin/main` in a detached worktree. A test that passes on unfixed `main`
  proves nothing and will be sent back.
- **Never weaken a test to make a run green** — no deleted blocks, no new `.skip`/`.only`, no
  reduced assertions, no neutered `package.json` `scripts.test*`. Bashwink ships a `TestGuard` that
  blocks exactly this in the product; doing it in a PR is the same offence.
- **Never report an unverified capability as implemented.** If you could not run it, say so. The
  project has a written record of having got this wrong before and correcting it.
- **Do not flip a task to `Done`** in `docs/bashwink/BASHWINK_TASKS_90.csv`. That register is the
  maintainer's record, written from evidence. State your evidence in the PR; the maintainer records it.
- **Do not push to someone else's branch**, and do not force-push a branch under review.
- **Keep the diff to the issue.** Refactors that "came up along the way" belong in their own issue.

### Areas where a change will be scrutinised hardest

`packages/bw-cli/src/standalone/security.ts`, `provider.ts`, `task-loop.ts`, `evidence` recording, and
anything touching `trust.json`, `permissions.json` or scope enforcement. Anything that could turn
"unverified" into "verified", or widen what an approved shell command can reach, needs its own test and
an explicit note on what is still not covered.

---

## 4. Open the PR

Push your branch and open the PR against `main`. Fill in every section of the template — in particular:

- **Verification**: the actual command you ran and its actual exit code. `npm run test:standalone` →
  `58 pass, 0 fail, exit 0`. Paste the tail of the output; do not summarise it.
- **Not verified**: a plain list of what you could not run and why ("no Windows machine", "no live
  provider key", "skipped: python3 pty unavailable"). This section is expected, not embarrassing — an
  empty one is usually a sign the author did not try.
- **New test**: name it and confirm you watched it fail without your fix.

### What CI will run

`.github/workflows/verify.yml` runs on every PR:

| Job | What it proves |
| --- | --- |
| `standalone` | The product gate — ubuntu, macos-15, **windows-latest** × Node `22.13.0` and `22`: unit/loop, install lifecycle, physical independence, PTY e2e (POSIX blocking, **Windows ConPTY informational** — it has never been qualified on a live Windows host) |
| `lint` | `oxlint --deny-warnings` plus a committed negative-control fixture proving the gate can actually fail |
| `docs integrity` | `verify_bashwink_docs.py`, register consistency, release-gate controls |
| `evidence`, `cli` | Workspace unit/typecheck under the pinned Bun, SIGKILL/resume fixture, contract lifecycle, runtime health |
| `fixtures` | Fixture baselines reset deterministically on Linux and macOS |
| `secret-scan` | Positive control fires, then zero credential patterns in the tree |
| `license-scope` | Every copyleft dependency has a recorded decision |
| `scope statement` | Records what a green run does and does not prove |

Two jobs you should **not** chase:

- **`full CLI suite on Windows (informational, not a gate)`** is already red on `main` itself. Check
  `gh api repos/ALDRIN121/bashwink/commits/main/check-runs` before blaming your branch.
- **`legacy npm package`** only runs on `workflow_dispatch`; it is the `v0.1.0-alpha.1` rollback
  path and is not part of the current product gate.

If a job fails for a reason that predates your branch, say so in the PR with the run link rather than
fixing it inside an unrelated change.

---

## 5. Review and merge

The maintainer reviews at your **head SHA** and checks claims against the checkout — anchors, npm
scripts, engine floors, install paths. Expect exact before/after text in the review rather than
"looks good". Address comments by pushing to the same branch; do not open a second PR.

Merging is the maintainer's call: squash-merge onto `main`, branch deleted. A PR may be kept open for a
missing piece of evidence — that is a request for evidence, not a rejection.

---

## 6. Security issues

**Do not open a public issue for a vulnerability.** Report it privately to the maintainer
([@ALDRIN121](https://github.com/ALDRIN121)) with repro steps and affected version. Do not include real
credentials, customer data, or exploit payloads against systems you do not own.

Context worth reading before you touch security code: [SECURITY notes](release/npm/docs/SECURITY.md),
[known limitations](docs/bashwink/KNOWN_LIMITATIONS.md), and the standing truth that **there is no
OS-level sandbox yet** — an approved shell command runs with the user's full access, so path checks are
best-effort, not containment.

---

## 7. Licence and attribution

MIT. There is no CLA and no DCO sign-off requirement. By opening a PR you agree your contribution is
licensed under the [MIT licence](LICENSE) (`Copyright (c) 2026 Bashwink contributors`).

Attribution that must be preserved: Bashwink carries MIT ports from OpenCode (`c0ad18b`) and Pi
(`b882d08`). If you port or copy code from elsewhere, say where in the PR and keep the notice. The
`license-scope` gate fails on any dependency with no recorded decision in
`docs/bashwink/DEPENDENCY_LICENSES.json`.

---

## 8. Good places to start

- **[#121](https://github.com/ALDRIN121/bashwink/issues/121) — cross-platform qualification.** Needs a
  Mac Intel, a Linux x64/arm64 box, or a Windows 11 machine. No code required; a rigorous report closes
  a gate item. Multiple rows are claimable independently.
- **[#122](https://github.com/ALDRIN121/bashwink/issues/122) — bounded live paid-provider session.**
  Needs a provider account and a disposable repo. Also no code required.
- **[#58](https://github.com/ALDRIN121/bashwink/issues/58) — running defect backlog.** Labelled by
  priority; the P0/P1 entries are the ones that matter for a distributable alpha.
- Docs and Windows gaps in [SUPPORTED_PLATFORMS.md](docs/bashwink/SUPPORTED_PLATFORMS.md) — several rows
  say `NOT_RUN`, and each one is a real task.

If you are an AI coding agent rather than a person: read [AGENTS.md](AGENTS.md) instead, it is stricter.

---

## Questions

Ask in the issue you are working, not in a new one. If you are unsure whether something is in scope,
say what you think the boundary is and ask for a yes/no — that is faster than guessing.
