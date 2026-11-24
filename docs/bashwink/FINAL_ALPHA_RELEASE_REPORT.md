# Final private-alpha report: standard npm package, candidate `npm-rc1`

Date 2026-11-25. Nothing was pushed, merged, published or uploaded. The RC1 and RC2 (optional sandbox) tags are untouched.

## A. Candidate

| | |
| --- | --- |
| Artifact | `bashwink-0.1.0-alpha.1.tgz` (187,654 bytes, 19 files), distributed out of band; not committed |
| SHA-256 | `e0a3f48fecfb46c29e1538b5ddfc1c17134ff711c279e24b20d29c34b8b4d458` |
| Built from | commit `2ba4b98156a5678bb223ab93983cd2707a61b84a`, clean tree; local tag `v0.1.0-alpha.1-npm-rc1` |
| Reproducible | **Yes**: independent builds are byte-identical |
| Manifest, checksums, results | `release/standard/0.1.0-alpha.1-npm-rc1/{RELEASE_MANIFEST.json,SHA256SUMS,*.json}` |
| Experience | `npm install -g ./bashwink-0.1.0-alpha.1.tgz`, `cd project`, `bashwink`: **works on macOS arm64** |
| Mode | STANDARD: native, permission-controlled, **not a sandbox**. `bashwink --sandbox` is not in the package and fails closed (exit 3, recorded, nothing started) |
| Runtimes | pinned public npm packages `bun@1.4.4` and `@opencode/cli@2.3.2`, installed by npm; not bundled |

## B. What was verified, and where

On one host: the developer's Mac (macOS 27, Apple M1), which is not a clean machine.

- Portable install check 10/10; PTY smoke 17/17 (first-launch trust question that says "not a sandbox", the TUI, the
  persistent `[STANDARD - native, not a sandbox]` label on the rendered screen, evidence boot, SIGTERM ends with 130 and the run
  record says `standard-native` / `recorded`, second launch does not ask again, no process left, `npm uninstall -g`
  leaves state and project alone). Reinstall over an existing install works.
- 541 unit and integration tests, lint and typecheck pass.
- Startup (time to the prompt, 7 alternating runs): bashwink **2.07 s** vs raw `opencode --standalone` **1.76 s**
  on the same machine (+0.31 s). Install about 17-20 s; installed tree about 315 MB including both runtimes. Memory and
  CPU, and time to first token, were not measured. Raw OpenCode's default background service could not be used as
  the baseline: its fixed port is held by a process on this machine that this work did not start and did not touch.

## C. Defects found by running the installed package and fixed

| # | Finding | Fix |
| --- | --- | --- |
| F-1 | npm's `bun` package moves the binary out of the platform package; the launcher could not find Bun | looks in both |
| F-2 | the launcher did not forward SIGTERM/SIGINT/SIGHUP: the run record stayed `pending` | forwards them; 130 verified |
| F-3 | OpenCode skips its JSX transform for any path containing `node_modules`: the TUI plugin failed to load ("Plugin failed" banner, no label) on every npm install | plugins are staged as a copy there and on Windows |
| F-4 | `HOME` unset (always on Windows) made config and data paths fall back to the current directory, i.e. into the user's project | `USERPROFILE`, then the OS home |
| F-5 | the standard help listed sandbox subcommands the package refuses and `BASHWINK_BACKEND=local (unrestricted host access)`; `trust` lacked its required `--by` | standard help derived from the general one; corrected |
| F-6 | documents claimed `--omit=optional` removes the runtimes; measured: it did not | claims removed |
| F-7 | CI waiters matching their own command line never finish (a harness fault, not a product one) | stopped |

## D. Not done, or not proven (stated plainly)

- **No live model session** on this package: the qualification key file is not visible to the session, so
  streaming, tool calls, edits, approvals in a real conversation, resume, cost and rate-limit behavior are **BLOCKED**.
- **No other platform**: Windows 11 x64, Linux, macOS Intel are NOT_RUN. The Windows work is static (see
  `SUPPORTED_PLATFORMS.md`). CI legs exist and have never run.
- **Standard-mode permission negative tests on the installed package: NOT_RUN.** The policy plugin was tested in earlier
  phases; its behavior inside this package is not shown here.
- **Minimum quality controls NOT DONE:** bounded retries, a per-session cost or request cap, running cost display.
  Protected-test disclosure and the evidence chain's limits are documented, not enforced differently.
- **The 25-question final audit and its finding records were not performed.** The findings in section C are the ones
  found by doing the work, not the result of a systematic audit.
- Licensing is **open** (stock OpenCode embeds LGPL FFmpeg, Bun embeds LGPL JavaScriptCore); notices are written;
  there is no legal sign-off. No dependency audit of the installed tree was run. No independent review.
- Upgrade from an earlier version, `--ignore-scripts` installs, offline installs: untested.

## E. Milestones

| M | Subject | State |
| --- | --- | --- |
| 0 | Baseline report | done (`ALPHA_RELEASE_PROGRESS.md`) |
| 1 | Native standard CLI | done: flavor, mode, fail-closed `--sandbox`, trust offer, help; tested |
| 2 | Platform matrix | written; only macOS arm64 PASS; rest NOT_RUN/BLOCKED |
| 3 | npm packaging | done and verified on macOS arm64 |
| 4 | Providers / live | BLOCKED |
| 5 | Security review | partial: uninstaller, cleanup, tarball audit, key handling; permission negatives NOT_RUN |
| 6 | Minimum quality controls | NOT DONE |
| 7 | Mode visibility / first run | done and verified on screen |
| 8 | Performance | startup only |
| 9 | Licensing | notices written; decision open |
| 10 | CI | jobs written, never run |
| 11 | Clean-host qualification | BLOCKED |
| 12 | Tester kit | written, unused by anyone but the author |
| 13 | Artifact layout | `release/standard/…` |
| 14 | Final audit | NOT DONE |

BW-031 and BW-032 remain `In progress`.

## F. Verdicts

| | |
| --- | --- |
| **PERSONAL USE** | **CONDITIONAL**: the owner's own Mac, a Git repository with a backup, supervised; no live session was run on this package |
| **SUPERVISED INTERNAL ALPHA** | **CONDITIONAL**: as above, plus the owner accepting the open licensing and permission-testing items |
| **WINDOWS X64 INVITED ALPHA** | **FAIL**: not qualified (NOT_RUN, blocked on hardware). Not a finding that it breaks; a finding that nothing shows it works |
| **WINDOWS ARM64 INVITED ALPHA** | **FAIL**: refused by design |
| **GENERAL PRIVATE EXTERNAL ALPHA** | **FAIL**: checklist rows 5-12 are not PASS |
| **OPTIONAL SANDBOX DISTRIBUTION** | **CONDITIONAL** for the owner's qualified Mac (RC2, see its report); **FAIL** for external users (no notarization, clean host, licence sign-off) |
| **PUBLIC NPM RELEASE** | **NOT AUTHORIZED** |

## G. Owner actions that unblock the rest

1. Make `~/.config/bashwink-qual/commandcode.key` (mode 600) visible to the session, then `live.py` and a live run of the installed package.
2. A Windows 11 x64 machine or runner (procedure in `SUPPORTED_PLATFORMS.md`), and Linux/Intel Mac if they are to be supported.
3. Authorize pushing a candidate branch so hosted CI can run the new legs.
4. A decision on licensing for npm-downloaded upstream runtimes.
5. Someone other than the author to follow `ALPHA_TESTER_GUIDE.md` on a clean machine.

## H. Next engineering actions

Permission negative tests against the installed package; bounded retries and a request/cost cap with display; the
systematic 25-question audit; `npm audit` and transitive licence listing; update the task register and status files.
