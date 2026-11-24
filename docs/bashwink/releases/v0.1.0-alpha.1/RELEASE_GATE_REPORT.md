# v0.1.0-alpha.1 release candidate gate report

**Stop point:** the release candidate gate. Nothing was pushed, merged, published or
distributed. The owner has not approved distribution, and this report does not ask for it,
because mandatory requirements are unmet.

## Verdicts

| Audience | Verdict | Why |
| --- | --- | --- |
| **PERSONAL USE** | **CONDITIONAL** | Usable by the owner on this Mac or another qualified macOS build, supervised, on small dependency-free Git projects, backed up. The secure default, refusal paths, review/apply and recovery are evidenced on the candidate. Live coding on the candidate archive was not run, and one legacy fixture fails intermittently. |
| **INTERNAL ALPHA** | **CONDITIONAL** | Reasonable for a few trusted internal testers on exactly macOS 27.0.1 (26A434), Apple Silicon, supervised, after the owner has run a live coding smoke test and decided the licensing question for sharing the binaries. |
| **EXTERNAL ALPHA** | **FAIL** | Mandatory security and installation requirements lack evidence: no clean-host qualification, no live-provider qualification, no hosted CI for the commit, licensing not signed off. |
| **PUBLIC RELEASE** | **FAIL** | Everything above, plus a single qualified macOS build, no notarization, and no independent security review. |

## A. Exact installation command

From a folder holding the archive and `SHA256SUMS`:

```sh
shasum -a 256 -c SHA256SUMS && tar -xzf bashwink-0.1.0-alpha.1-macos-arm64.tar.gz && cd bashwink-0.1.0-alpha.1-macos-arm64 && ./install.sh
```

## B. Exact launch command

```sh
cd /path/to/git-checkout-root && bashwink
```

After the one-time provider setup in the tester guide (`bashwink auth add commandcode … --key-file …`,
`bashwink model use commandcode/claude-sonnet-5`). Review with `bashwink sandbox vm-review`.

## C. Archive path and checksum

`build/release/bashwink-0.1.0-alpha.1-macos-arm64.tar.gz` (a copy sits beside the manifest in
`docs/bashwink/releases/v0.1.0-alpha.1/`; both are git-ignored build output).
SHA-256 `f55db1940f917a7c41c91d12e9a2d1478ea91200a0c1bbee1fd65537cde486b2`, 333,567,141 bytes,
installed 713,992,249 bytes. The Swift VM helper is not bit-reproducible, so a rebuild from the
same commit has a different archive hash; this hash identifies this build.

## D. Supported platform scope

macOS on Apple Silicon, only builds named in `release/qualified-hosts.json`: **27.0.1 (26A434)**,
tier "engineering-host". Linux, Windows and Intel Macs unsupported. Recorded in
[ADR-013](../../DECISIONS.md). BW-031 and BW-032 stay `In progress`; their original
requirements are unchanged.

## E. Default isolation behaviour

Bare `bashwink`, `--continue` and `--session` run in the Apple Virtualization VM (no NIC, no
shared folders, unprivileged guest user) on a copy of the project, or stop. Any startup failure
stops before a model request or tool dispatch, prints a cause and fix, and is recorded in
`startup-failures.jsonl`. No environment variable selects the host. `--unsafe-local` is the only
host mode: typed acknowledgment every time, labelled before the UI and inside it (a 20-second
toast, **not** a persistent indicator), approvals and denials preserved. Mode also appears in
`doctor` and run records.

## F. Clean-host qualification

**BLOCKED.** No clean Docker-free Apple Silicon host was available. The Fresh-HOME, scrubbed-
environment simulation passed all 21 stages on the engineering host and is **not** substituted
for it. See [QUALIFICATION_RESULTS.md](QUALIFICATION_RESULTS.md).

## G. Live-provider results

- Live endpoint rejected an invalid key: 401 `provider.auth`, 1 request, 0 tokens: **PASS**.
- Live coding, model switching, streaming cancellation, interruption, upstream failure,
  budget exhaustion, credential isolation of a real key, guest cleanup after cancellation:
  **NOT_RUN**. No credential was available (`~/.config/bashwink-qual/commandcode.key` was
  suggested and never appeared).
- A live rate-limit response was deliberately not provoked.
- Synthetic results are labelled S/U and are never counted as live.

## H. Security verification results

Passed on the engineering host: release default and refusal tests (28), project structure tests
(15), release-image in-guest egress probe, release-image acceptance (SIGKILL, recovery, conflict,
links, protected tests, no credential in guest), unrestricted-mode controls (13), tamper
controls (archive, installed asset, damaged directory). Not done: independent review, clean-host
adversarial runs, dependency vulnerability audit, power-loss testing. See the matrix.

## I. Performance measurements

On an 8 GB M1 MacBook Air: install 5.7 s; VM start to TUI about 4.3 to 5.4 s; whole workload about
0.9 GB physical footprint and 52% to 129% of one core at peak; review preview 0.19 s; apply of
four files 0.15 s; protected verification 2.05 s; archive 318 MiB, installed 681 MiB. Time to first
token not measured. [PERFORMANCE.md](PERFORMANCE.md).

## J. Full regression and CI results

Local, not hosted: 22 of 23 steps passed. `bun test packages` 493/0; typecheck, lint, format, lint
negative controls, documentation audit, gate tests all exit 0; runtime fixtures 11/19/14/10.
**One failure**: the legacy guest-TUI boundary fixture, intermittent (about 1 run in 6 to 10),
cause not established. **Hosted CI: NOT_RUN** (pushing not authorized).

## K. Candidate commit

`13f003de321977d13bfac3839b8b721a01a95cef` (code). Later commits touch only harnesses,
documentation and the README. Local tag `v0.1.0-alpha.1-rc1` points at the candidate. Branch
`codex/v0.1.0-alpha-preparation`, not pushed.

## L. Remaining blockers, with the exact action and evidence needed

| # | Blocker | Action | Evidence that closes it |
| --- | --- | --- | --- |
| 1 | No clean Docker-free Apple Silicon host | On a factory-fresh or newly created macOS 27.0.1 (26A434) Apple Silicon Mac with no Docker: copy the archive and run `python3 fixtures/release/release_first_run.py <dir> --out r.json --live --key-file <file>` plus the other three harnesses | Matrix rows `PASS` with host facts and the candidate SHA; `verify_alpha_release.py` accepts the platform entry |
| 2 | Live provider qualification | Provide an authorized key (mode 600 file); run live coding, model switch, Esc/Ctrl+C cancellation with an independent connection observation, a connection drop, request-budget exhaustion, guest-process observation | Logs and usage records for each, labelled live |
| 3 | Hosted CI at the candidate SHA | Authorize pushing the branch and running the `verify` workflow when quota allows | Run and job reports for the exact SHA saved beside the manifest |
| 4 | Licensing of the shipped OpenCode binaries (LGPL FFmpeg inside libopentui, ADR-009) | Owner decision: counsel sign-off, or rebuild `libopentui` without FFmpeg and substitute it in the guest and host runtimes | Signed decision, or a no-FFmpeg build and a notices regeneration with `--no-ffmpeg` |
| 5 | Intermittent legacy fixture failure | Find why the second permission dialog's options are sometimes not observed (guest TUI redraw versus fixture detection); fix the fixture or the product | 20 consecutive passes of `vm-boundary.py --opencode-inputs` |
| 6 | Only one macOS build, tier "engineering-host", never refused for real | Run on a second macOS build to observe the unsupported-host refusal for real; qualify further builds | Refusal transcript; extended `qualified-hosts.json` with evidence |
| 7 | Ad-hoc signed VM helper, unnotarized archive | Developer ID signing and notarization decision; test Gatekeeper behaviour on a clean host | A clean-host install without quarantine workarounds |
| 8 | 30-minute session deadline not run end to end | Run one full-length session (or a shortened-deadline build) and confirm the guest saves at the limit | Saved checkpoint after a deadline stop |
| 9 | Persistent mode indicator is only a 20 s toast | Decide whether a persistent in-TUI indicator is required, and build it with the TUI slot API | PTY test seeing the indicator throughout a session |
| 10 | No dependency vulnerability audit; no independent security review | Run an advisory-database audit; commission a review of the release path | Audit output; review findings closed |
| 11 | Power-loss durability unverified | Test or keep the explicit "no durability claim" | n/a (stays documented) |
| 12 | Ubuntu rows of BW-032 | Outside this candidate's scope; still open for BW-031/BW-032 | Ubuntu qualification evidence |

## Housekeeping you may want to do

- `/private/tmp/bashwink-vm-*` holds 18 small (about 0.6 MB each) retained stage directories from
  development-build fixture runs on 24 November. They are mine; deletion was not done because the
  auto-mode classifier blocked a broad glob delete in `/private/tmp`.
- `uninstall.sh --purge-state` removes **every** `/private/tmp/bashwink-vm-*` directory you own, not
  only those of the install being removed. One earlier harness run executed it before this was
  guarded, so leftover stage directories from earlier Bashwink sessions on this Mac may have been
  removed. They were test leftovers; none is cited as evidence.
