# v0.1.0-alpha.1 RC2 — final qualification and stabilization report

RC1 (`13f003de…`, tag `v0.1.0-alpha.1-rc1`) is unchanged. RC2 is a new candidate. Nothing was pushed,
merged or published.

| | |
| --- | --- |
| **Candidate commit** | `20c8473b9a2b3bbff8f413a7e85acad5d7016007` |
| Later commits | harness, runner and documentation only (`git diff --name-only <candidate> HEAD`) |
| Archive | `bashwink-0.1.0-alpha.1-macos-arm64.tar.gz` |
| **SHA-256** | `8acedf7f7ed1461cb9f6a065c06c096ce890e478879b5bc5950b1d40680c68be` |
| Size | 291,241,824 bytes (278 MiB); installed 719,173,981 bytes (686 MiB) |
| Reproducible | **Yes.** Two independent builds of the commit are byte-identical (RC1 was not) |
| Local branch / tag | `release-candidate/v0.1.0-alpha.1-rc2` and `v0.1.0-alpha.1-rc2`, both at the candidate; not pushed |
| Host | macOS 27.0.1 (26A434), Apple M1, 8 GB, Docker present: an engineering host, **not clean** |

This candidate is the **optional sandbox** artifact. The product direction changed after it was cut:
standard native mode is now the default and sandbox mode is optional (see `ALPHA_RELEASE_PROGRESS.md`).

## 1. Live-provider qualification — BLOCKED

The CommandCode key file `~/.config/bashwink-qual/commandcode.key` **does not exist in the session's
view of the filesystem** (`ls` of the directory fails; nothing newer than 23 Nov in `~/.config`). It was
never read. Nothing in this section was run live on RC2:

| Item | Status |
| --- | --- |
| Credential initialization, real authentication | RC1: invalid key rejected by the live endpoint (401, 1 request, 0 tokens). RC2: **NOT_RUN** |
| Streaming, TUI conversation, tool calls, edit, tests, apply, resume, model switch, both cancellations, interruption, accounting, rate limits | **NOT_RUN** |
| Time to first token, live task duration | **NOT_RUN** |
| Credential containment with a real key | **NOT_RUN** (synthetic key: absent from guest state, transcripts and records) |

`fixtures/release/live.py` is written and syntax-checked but has never run against a key; it must be
treated as untested. It never prints the key, uses it only as `--key-file`, bounds spend with a
per-session request limit, and searches for the key afterwards. Action: make the file visible and run it.

## 2. Uninstaller safety defect — FIXED and tested

Stage directories are now registered per installation with an ownership marker; `uninstall.sh` no longer
contains a glob delete. A stage is removed only if its registry entry parses, the path is directly under
the stage root with the expected name shape, a real directory (not a symlink) of this user's with the
recorded device and inode is there, the marker nonce matches, the recorded process is gone and nothing has
the disk open. Everything else is kept and reported; unregistered directories are never examined.

| Negative control | Result |
| --- | --- |
| Old uninstaller logic on a decoy | deletes the unrelated matching directory (shown) |
| 19 unit tests: unrelated, other installation, live session, disk in use, symlink at the path, replaced directory, forged/missing/symlinked marker, hand-written registry entries (including `/` and the parent), other user, malformed entry, links inside a stage, determinism, idempotence | pass |
| Real `uninstall.sh` and CLI against decoys in `/private/tmp` (4 tests) | pass: other installation's stage, an older build's stage and a stranger's survive; declining keeps everything; plain uninstall touches nothing; exit status 0 |
| Release first-run harness | `--purge-state` exits 0 and the 28 pre-existing stage directories on this Mac were untouched |
| Registration failure | removes the empty stage; verified under a really full volume |

Stages from RC1 and earlier are unregistered and are never deleted automatically.

## 3. Root cause of the intermittent fixture failure — FOUND and FIXED

A **test-harness observation defect**, not an isolation defect. Full analysis:
[FIXTURE_FLAKE_ROOT_CAUSE.md](FIXTURE_FLAKE_ROOT_CAUSE.md). In short: the terminal renderer repaints only
changed cells, so a second identical-looking permission dialog leaves no new `Allow once` text; the fixture
waited for it, never approved, and the guest deadline ended the session with the tool never run. Fixed by
counting dialogs from OpenCode's own state events. 40/40 independent boots pass; the same driver with the
old logic restored fails 2/40; 20 more boots passed inside the exact-candidate run. No assertion was
weakened, no retries added.

## 4. Licensing and artifact — FFmpeg removed; legal sign-off still the owner's

[LICENSING_STATUS.md](LICENSING_STATUS.md). OpenCode 2.3.2 (macOS and Linux guest) is rebuilt from the pinned
source with a libopentui built without FFmpeg: 0 FFmpeg markers in the shipped binaries and the guest image
(stock: dozens), runtime fixtures and TUI render pass, the VM acceptance passes on the rebuilt guest runtime,
and the builder refuses any runtime that differs from its pin or contains FFmpeg. One bug found on the way:
the musl build also embeds the glibc library. **Still open:** Bun embeds JavaScriptCore (LGPL-2.0) in every
binary here; Alpine GPL components; web UI omitted; not byte-reproducible runtime build; no OpenTUI test
run; no legal sign-off. Not claimed compliant.

## 5. Execution-mode visibility — DONE

`[SANDBOXED VM]` / `[UNSAFE LOCAL MODE]` on the home screen and beside the prompt, through the supported TUI
footer slots, plus the start notice. Verified by rendering the real screen after the notice period and in the
session view, in the host TUI and the VM guest. Unknown mode is shown as unknown, never as isolated.

## 6. Lifecycle and cleanup — VERIFIED on the engineering host

| Item | Result |
| --- | --- |
| **30-minute deadline, end to end** | the guest ended the session itself at **1,746 s** (limit 1,740 s) with exit 0, printed that the limit was reached and the work saved; checkpoint held the edited files and the hash-chained evidence; host project unchanged; no VM process left |
| Lifecycle harness (38 checks) | normal exit, Ctrl+C, SIGINT, SIGTERM, SIGKILL: VM and helper stop, interrupted stage kept and registered, purged through the registry, a new session starts; 10 consecutive sessions (4.8–5.6 s each) with no process or stage accumulating; a VM owner that cannot start (exit 7): clear status, no request, stage recorded and purged |
| Disk exhaustion | state volume filled to 0 bytes: refuses with `ENOSPC … mkdir` (and says the failure could not be logged), no VM, no stage. **Not tested:** exhaustion at checkpoint-commit time |
| Harness cleanup | every VM harness purges its own recorded stages and removes its work directory on success, keeps it on failure for analysis. A defect of mine (cleanup only on success) filled the disk earlier; fixed |
| "Three remaining shells" | not found in any document. A process inventory at the time showed only other tools' shells and services (this session's shell, a five-day-old terminal, a mock provider and an OpenCode service that predate my work). None was started by these runs and none was touched. If you have PIDs, send them |

## 7. Platform qualification — BLOCKED

Qualified list unchanged (macOS 27.0.1 / 26A434). A bundle whose list excludes this Mac's real OS build refuses
it with the real facts and names the qualified list (test added). A **real** unqualified macOS build and a
**clean Docker-free host** were not available: both stay BLOCKED. Signing and notarization:
[SIGNING_AND_NOTARIZATION.md](SIGNING_AND_NOTARIZATION.md) (ad-hoc VM helper; Developer ID, `.pkg`/`.dmg` and
notarization are required for browser-downloaded distribution and need an Apple Developer account).

## 8. Documentation and manifest

The four mismatching documents were files I had edited on purpose (the manifest matched completely at the RC1
baseline). `scripts/refresh_docs_manifest.py` updates only existing entries and prints each change; the strict
check is unchanged and was run after the refresh (see TEST_EVIDENCE.md).

## 9. Candidate and hosted CI — NOT_RUN

New candidate cut, byte-reproducible archive, SHA256SUMS and inventory produced. Branch
`release-candidate/v0.1.0-alpha.1-rc2` prepared locally at the candidate. **Hosted CI needs a push, which is
not authorized.** The workflow keeps macOS and Linux jobs. New tests were made platform-aware so they hold on
Ubuntu (`/private/tmp`-dependent tests run on macOS only, not removed). Hosted CI proves source-level checks on
`ubuntu-latest` and `macos-15`; it does **not** run the Virtualization framework, so VM platform qualification
remains the local/clean-host harnesses.

## Performance (quiet machine, RC2)

Install 5.4 s; VM to TUI 4.1–4.7 s; whole workload (launcher + VM owner + Virtualization helper) 0.92 GiB at
idle, 0.98 GiB peak, 16–20% of one core at peak; review preview 0.23 s; four-file apply 0.17 s; protected
verification 2.0 s. Time to first token not measured. (An earlier RC2 run reported 1.9 GiB because a second VM
was running; it is not used.)

## Verdicts (RC2 as the optional sandbox artifact)

| | |
| --- | --- |
| **PERSONAL USE** | **CONDITIONAL** (qualified Mac, supervised, small dependency-free Git projects; live coding on RC2 unverified) |
| **INTERNAL ALPHA** | **CONDITIONAL** (same, plus the owner's licensing decision on Bun/Alpine components) |
| **EXTERNAL ALPHA** | **FAIL** (no clean host, no live qualification, no hosted CI, no licence sign-off, no notarization) |
| **PUBLIC RELEASE** | **FAIL** |

BW-031 and BW-032 remain `In progress`; successful qualification of a narrow macOS candidate is not completion of
the cross-platform sandbox roadmap.

## Remaining blockers

| # | Blocker | Closes with | Owner action |
| --- | --- | --- | --- |
| 1 | Key file not visible | `live.py` run on RC2 | make `~/.config/bashwink-qual/commandcode.key` (mode 600) reachable to the session |
| 2 | Clean Docker-free Apple Silicon host | harnesses run there | provide the host |
| 3 | Hosted CI | `verify` run at the candidate SHA | authorize pushing the branch |
| 4 | Licence sign-off (Bun JSC LGPL, Alpine GPL, rebuilt runtime) | signed decision | decide |
| 5 | Real unqualified macOS build refusal | refusal transcript | a second macOS build |
| 6 | Notarization | signed, notarized `.pkg`/`.dmg` tested on a clean Mac | Apple Developer account |
| 7 | Exhaustion at checkpoint-commit time; power loss; dependency audit; independent review | tests/reviews | — |
