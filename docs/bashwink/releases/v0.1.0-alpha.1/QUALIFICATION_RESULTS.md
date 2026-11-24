# v0.1.0-alpha.1 — qualification results

**Status: external qualification NOT complete.** Every row that needs a clean Apple Silicon host
is `BLOCKED`, because no such host was available. The machine used is an engineering Mac that
has Docker installed and earlier Bashwink development state. Its results are recorded as
*engineering-host* results and are **not** presented as clean-host results.

## What was tested

| Fact | Value |
| --- | --- |
| Candidate commit (code under test) | `13f003de321977d13bfac3839b8b721a01a95cef` |
| Later commits | harness, documentation and README only (`git diff --name-only <candidate> HEAD`) |
| Archive | `bashwink-0.1.0-alpha.1-macos-arm64.tar.gz`, SHA-256 `f55db1940f917a7c41c91d12e9a2d1478ea91200a0c1bbee1fd65537cde486b2`, 333,567,141 bytes |
| Host | macOS 27.0.1 (build 26A434), arm64, Apple M1 MacBook Air, 8 GB, 8 cores |
| Docker on host | present (29.7.2) and **not used** by any Bashwink step; the host is therefore **not clean** |
| Bun / OpenCode | Bun 1.4.4; OpenCode 2.3.2 (guest and host builds, hashes in [ARTIFACT_MANIFEST.md](ARTIFACT_MANIFEST.md)) |
| VM image hashes | kernel `acb63544…24a6`, initramfs `bdd1b370…db4a`, VM owner `ca5eb6fe…0973` |
| Policy digest (VM asset manifest, pinned into the CLI) | `b58936fe1fca3bd5ec676ce9bfa14b02cc9c36e6f48f88890d69e312c32ffa9d` |
| Runner | `scripts/verify_candidate.sh` (local, not hosted CI). Logs: [evidence/exact-candidate](evidence/exact-candidate/) |

Evidence tiers used below: **E** = engineering host, not clean · **S** = synthetic upstream
provider · **L** = live provider endpoint · **U** = unit or integration test.

## Result of the exact-candidate run

22 of 23 steps exited 0; the 23rd (the release gate validator) refused as designed and is
discussed below. One step in that table, the legacy guest-TUI fixture, **failed (exit 1)** and
is an open item (see [Unresolved failure](#unresolved-failure)).

| Step | Exit | Result |
| --- | ---: | --- |
| `bun test packages` | 0 | 493 pass, 0 fail, 1,555 assertions, 30 files |
| Guest project program tests | 0 | 3 pass |
| Typecheck, Oxlint, formatting (78 files), lint negative controls | 0 each | 6 negative controls passed |
| Documentation audit, register summary, licence scope | 0 each | `Audit: PASS` |
| Native gate tests, alpha gate tests | 0 each | 4 and 5 tests |
| Runtime health, tool lifecycle, contract, idempotent resume (archive's own OpenCode) | 0 each | 11, 19, 14 and 10 checks passed |
| Development-build interactive entry (PTY) | 0 | TUI rendered in git, non-git and nested directories |
| VM boundary: forced stop, owner SIGKILL, launcher SIGKILL, SIGINT, timer | 0 | detached guest writer stopped each time |
| VM boundary: real OpenCode TUI in the guest | **1** | **FAIL** (intermittent, below) |
| VM boundary: project sessions, relay, apply recovery (fixture image) | 0 | |
| Release: first run, install, approval, TUI, uninstall (PTY) | 0 | 21 stages, all PASS |
| Release: unrestricted mode (PTY) | 0 | 13 checks, all PASS |
| Release image: project acceptance with SIGKILL, recovery, apply, verify | 0 | 9 controls |
| Release image: in-guest egress probe | 0 | PASS |
| Release gate validator | 1 | refuses (expected); see below |

## BW-032 controls for the macOS VM profile

`Release verdict` is the verdict the release gate would record. It is `BLOCKED` wherever a clean
host is required; the engineering-host observation is given beside it.

| Control | Release verdict | Engineering-host observation (tier) |
| --- | --- | --- |
| clean-install | **BLOCKED** | Fresh `HOME`, scrubbed environment (`PATH=/usr/bin:/bin:/usr/sbin:/sbin`), archive checksum verified, installer refused a damaged archive directory, install 5.7 s, uninstall removed the install and kept state, `--purge-state` removed state (E). Docker is present on this host, so it cannot count. |
| interactive-mock | **BLOCKED** | Release image ran the full installed-PTY project workflow against a synthetic provider: multi-file edit, approved guest tests, `--continue` and `--session`, launcher SIGKILL, corrupt and foreign checkpoints refused, SIGKILL during apply and recovery, review decline, conflict refusal, apply, protected-test verification (E, S). |
| interactive-live-provider | **BLOCKED** | Live endpoint rejected an invalid key with status 401 `provider.auth`, one request counted, zero tokens (E, L). **Live coding, model switching and cancellation were not run on this candidate: no credential was available.** Earlier lab runs of an earlier build are in `TEST_EVIDENCE.md` and are not candidate evidence. |
| file-and-link-policy | **BLOCKED** | Project-structure tests (15) and apply tests for symlinks, hardlinks, tampered receipts and quarantined staging (U); host `.env` and canary files unchanged through the acceptance run; the stage directory is removed after a committed session (E). |
| subprocess-and-detached-cleanup | **BLOCKED** | A detached guest writer stopped at VM retirement in the release-image acceptance and in the boundary fixture (E). Cleanup of an individual guest process after a *live* cancellation was not observed (NOT_RUN). |
| network-and-provider-transport | **BLOCKED** | From inside the release guest: only `lo`, no route, public and gateway fetches "Network unreachable", DNS failed, no host paths, user `nobody`, raw stage disk read and write denied, no shared mounts (E, S). Relay tests for size, deadline, disconnect, interruption, malformed and nonpublic-DNS responses (U). |
| secret-isolation | **BLOCKED** | The synthetic credential was absent from PTY transcripts, guest state and usage records (E, S). A live key was not available, so isolation of a real key on this candidate is **NOT_RUN**. |
| approval-and-alternate-dispatch | **BLOCKED** | Release default and refusal tests (U): environment switches ignored, host-style invocations refused, development sandbox commands refused. Unrestricted mode needs a typed phrase, labels itself, keeps denial and approval behaviour (E). |
| session-recovery-and-export | **BLOCKED** | SIGKILL at the journal, stage-created, prepared and mutated points; repeated recovery; three consecutive reviewed batches; receipt chain; resume after apply (E, S). Power loss is **NOT_RUN** and no durability claim is made. |
| unsupported-host-and-no-fallback | **BLOCKED** | Host verdict logic tested for other builds, Intel, Linux, Windows and an empty list (U). Missing, corrupt, tampered, symlinked and group-writable assets refused (U) and a tampered installed asset refused a real launch and failed `doctor` (E). **A real unqualified macOS build was not available (NOT_RUN).** |
| resource-limits | **BLOCKED** | Whole-workload memory and CPU measured ([PERFORMANCE.md](PERFORMANCE.md)); the owner timer fired at 4 s in the boundary fixture and exit 124 was observed (E). The 30-minute session deadline and a full request-budget exhaustion were **not** run end to end. |
| ci-or-reviewed-equivalent | **NOT_RUN** (hosted) | Hosted CI was not run: it needs the candidate pushed, which was not authorized. The local equivalent is the table above and is **not** hosted CI. |

## Provider and process reliability

| Behaviour | Synthetic (S / U) | Live (L) |
| --- | --- | --- |
| Authentication | Credential resolution, key-file privacy and host-only use tested | **PASS**: invalid key rejected, 401, body suppressed, 1 request, 0 tokens |
| Live coding | Scripted multi-file task passed on the release image | **NOT_RUN** (no credential) |
| Model switching | Per-model routes and attribution tested | **NOT_RUN** |
| Streaming cancellation | Client-disconnect cancels the upstream (test) | **NOT_RUN** |
| Connection interruption | Interrupted upstream stream fails without reporting success (test) | NOT_RUN |
| Rate limiting | 429 reported without the upstream body (test) | NOT_RUN. A live 429 was deliberately not provoked: that would spend paid quota. |
| Upstream failures | 5xx and malformed responses suppressed (tests) | NOT_RUN |
| Request-budget exhaustion | Dispatch limit counts failed requests (test) | NOT_RUN |
| Capability expiry | Capability from another run refused; revoked after shutdown (test) | NOT_RUN |
| Credential isolation | Key absent from guest state, transcripts and records (acceptance) | NOT_RUN with a real key |
| Independent guest-process cleanup | Detached writer observed stopping on the stage disk | NOT_RUN after live cancellation |

Unverified provider behaviour is listed in [KNOWN_LIMITATIONS.md](../../../../release/docs/KNOWN_LIMITATIONS.md).

## Unresolved failure

`VM boundary fixture: real OpenCode TUI in the guest` (the legacy single-prompt fixture in
`fixtures/native-offline/vm-boundary.py --opencode-inputs`) **failed in the exact-candidate run
and is intermittent**. Reruns on the same machine: 5 of 6 passed; 9 of 10 passed with the in-TUI mode toast
disabled; a further loop failed on its third run. In the failing runs the guest
displayed the second permission dialog (`$ sh check.sh`), the fixture never saw its option
text and never approved, and the guest's own 28-second deadline ended the session. The toast
is not the cause (the failure also occurs without it) and the project-session fixtures, which
approve shell commands through the same TUI, passed in every run. The root cause was **not
established**. This is recorded as an open failure, not a pass.

## Release gate validator

`python3 scripts/verify_alpha_release.py --revision 13f003de321977d13bfac3839b8b721a01a95cef`
refuses. The first refusal (above, in the logs) was only that this candidate's manifest did not
yet exist. With the manifest in place, [RELEASE_GATE_REPORT.md](RELEASE_GATE_REPORT.md) lists the
refusal reasons, which are the unmet rows above.
