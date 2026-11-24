# Bashwink — Test Evidence Register

## v0.1.0-alpha.1 release candidate RC1 (2026-11-24 to 25)

Candidate commit `13f003de321977d13bfac3839b8b721a01a95cef`; archive
`bashwink-0.1.0-alpha.1-macos-arm64.tar.gz`, SHA-256
`f55db1940f917a7c41c91d12e9a2d1478ea91200a0c1bbee1fd65537cde486b2`. macOS 27.0.1 (26A434) arm64,
Apple M1, 8 GB, Bun 1.4.4, OpenCode 2.3.2. Run with `scripts/verify_candidate.sh` (local, **not**
hosted CI) on an engineering host that has Docker installed. Full results, tiers and
logs: [qualification results](releases/v0.1.0-alpha.1/QUALIFICATION_RESULTS.md) and
`releases/v0.1.0-alpha.1/evidence/`.

| Command or control | Exit | Observed result |
| --- | ---: | --- |
| `bun test packages` | 0 | 493 passed, 0 failed, 1,555 assertions, 30 files (448 baseline plus 45 new: release default 2, release mode 28, project structures 15) |
| Typecheck, Oxlint, `bun fmt --check`, `lint:gate` | 0 each | 78 files formatted; 6 lint negative controls passed |
| Documentation audit, register summary, licence scope, native and alpha gate tests | 0 each | `Audit: PASS`; 4 and 5 gate tests |
| Runtime health, tool lifecycle, contract, idempotent resume | 0 each | 11, 19, 14 and 10 checks, using the OpenCode binary from the archive |
| Development-build interactive entry PTY | 0 | git, non-git and nested directories |
| `vm-boundary.py` basic | 0 | forced stop, owner SIGKILL, launcher SIGKILL, SIGINT and timer (124); detached writer stopped each time |
| `vm-boundary.py --opencode-inputs` (legacy guest TUI) | **1** | **FAIL**, intermittent: the fixture did not observe the second permission dialog's options and the guest deadline ended the session. 5/6 and 9/10 passed on rerun; toast ruled out; cause unresolved |
| `vm-boundary.py --project-cli --relay-inputs` (fixture image) | 0 | project sessions, relay, apply recovery |
| `fixtures/release/release_first_run.py` | 0 | 21 stages PASS: checksum, tampered archive, install 5.7 s, damaged-directory refusal, tampered-asset refusal, no-provider refusal, auth setup, approval decline and accept, TUI with mode shown before and inside, stage removed, repeat launches, uninstall, purge |
| `fixtures/release/release_unrestricted.py` | 0 | 13 checks PASS: three wrong acknowledgments refused, typed phrase starts host mode, labelled, run record `unrestricted-host`, untrusted shell denied, trusted shell asks, decline and approve |
| `fixtures/release/vm-acceptance.py` (release image) | 0 | 9 controls: edit, approved tests, resume, launcher SIGKILL, corrupt and foreign state, SIGKILL during apply, review/conflict/apply, protected tests, no credential in guest |
| `fixtures/release/vm_egress_probe.py` (release image) | 0 | only `lo`, no route, outbound fetches unreachable, DNS fails, no host paths, user `nobody`, raw disk denied, no shared mounts |
| `fixtures/release/release_first_run.py` with an invalid key | 0 | live endpoint answered 401 `provider.auth`; 1 request, 0 tokens; read from the saved session |
| `fixtures/release/vm_perf.py` | 0 | see [performance](releases/v0.1.0-alpha.1/PERFORMANCE.md) |
| `python3 scripts/verify_alpha_release.py --revision <candidate>` | 1 | refuses: every clean-host, live-provider and CI row is BLOCKED or NOT_RUN (`evidence/gate-validator-output.txt`) |

Not run: hosted CI, a clean Apple Silicon host, live coding, model switching, live cancellation,
live rate limit (deliberately not provoked), power loss, a real unqualified macOS build, the
30-minute session deadline end to end, and a dependency vulnerability audit.

Two defects found and fixed while building the candidate: the shipped uninstaller returned exit 1
after a successful purge when the last cleanup glob matched nothing, and release sessions left a
copy of the project in `/private/tmp/bashwink-vm-*`. A harness defect (cleanup only on success)
filled the disk once; harnesses now clean up on every exit path.

## Persistent VM project sessions and reviewed apply (2026-11-24)

Source `34a78e42b1052ed4c6a12ea00b00a179d47266dc`. macOS arm64 27.0.1 (26A434),
Bun 1.4.4, OpenCode 2.3.2. The installed project fixture used a disposable top-level
TypeScript Git project and the guest-only mock.

| Command or control | Exit | Observed result |
| --- | ---: | --- |
| `python3 fixtures/native-offline/vm-boundary.py <Alpine inputs> --opencode-inputs <runtime inputs> --project-cli` | 0 | Real installed PTY modified two files, added one, deleted one and ran an approved guest test. The original host checkout remained unchanged through coding and both restarts. Both `--continue` and `--session` restored the same OpenCode conversation, task plan, staged files, and evidence prefix. |
| Launcher SIGKILL and state refusal in the project fixture | harness 0 | A stopped orphan VM owner retained the project lock and refused review after launcher SIGKILL. After owner shutdown the last sealed checkpoint reopened. Corrupt state and a session ID from a different Git checkout were refused. The independently sampled detached guest heartbeat stopped when the VM retired. |
| Installed review and apply | harness 0 | Full preview distinguished added, modified and deleted files. Decline and SIGKILL at preview left the checkout unchanged. An occupied new-file path blocked apply. An explicitly selected one-file apply left the other candidate paths unchanged. |
| Approved apply interruption and recovery | harness 0 | Test subprocesses were SIGKILLed after approval before mutation and after the first file mutation. Installed `sandbox vm-recover` reconciled the approved batches. Retry kept the already installed inode. Three durable receipts identified the four exact resulting file states, including the deletion. Focused tests also exercised corrupt journals, interruption after durable completion, symlinks, hardlinks, and a concurrent change at the replacement boundary. |
| Installed `sandbox vm-verify` | refusal 3, clean run 0 | A modified protected host test was refused. A fresh VM ran `accept.test.ts` against the independently read final host source bytes and reported one pass. The checkout diff and unapproved file canaries matched the fixture expectations. |
| Bun test, typecheck, Oxlint, formatting and lint gate | 0 each | 418 passed across 25 files and 1,233 assertions. Six lint gate checks passed. The ten focused journal tests passed. |
| Pinned readiness, lifecycle, TaskContract and recovery fixtures | 0 each | 11, 19, 14 and 10 checks. Installed ordinary PTY, original installed VM, independent VM lifetime, and Seatbelt session, lifecycle and export fixtures also passed. |
| `bun run verify:evidence <saved-project-evidence>` | 0 | Independent check verified 19 chain entries and four distinct boot identities. |
| Release validator unit controls and external-alpha gate | 0 and 1 | Four native and five alpha controls passed. The gate refused external release. No hosted rerun was started. |

The verification record binds the test to fixture Git base
`abcda1336e3cdf2e46da7229b38ad7da43cd155a` and original protected
`accept.test.ts` SHA-256
`6cba73eb11236f633095f5815801a22e5783913adf4253453fb2c97e172dbe9c`.
Final source SHA-256 values were `15eca2fb141b255da42c6cd4c7d5b72c85374a803d748731950ed80ef3498be6`
for `one.ts`, `7888e8f34a30cf434ad16075eafbda22550fb37579688f212e6502197946134e`
for `two.ts`, and `8d5e665ef7e98461c1846569605c7a96a6b70737e0b5822e6040ed3b1c81c7b9`
for `new.ts`. `obsolete.ts` was absent. The protected acceptance test ran in its
own VM with the originally captured test bytes and no model session.

The profile covers bounded tracked top-level text files and compatible fresh VM
instances. Interrupted sessions retain the last sealed checkpoint. Multi-file
apply is visible one file at a time. An early crash before publishing the apply
staging directory identity remains quarantined before source mutations. At that historical source, automated baseline refresh, broader workspace support,
and power-loss behavior remained unverified. See the later milestone 5 observations. BW-031 and BW-032 remain In progress.

## v0.1.0-alpha freeze, VM runtime and installed entry (2026-11-24)

Freeze source `f69266bd32c63e7820fd58585fb36cb981588d74`. CLI fixes
`98f1adf9a587967827ff454090ed27af0e5ba613`. VM fixture source
`d9d8cf6d11a535d80b5673494a812c80dd18a104`. macOS arm64 27.0.1 (26A434),
Bun 1.4.4, OpenCode 2.3.2. Guest assets were pinned and fetched into disposable
directories. The VM had no NIC or host directory shares and used an offline mock.

| Command or control | Exit | Result |
| --- | ---: | --- |
| `python3 fixtures/native-offline/vm-boundary.py <Alpine inputs>` | 0 | **PASS at lab tier.** Forced stop, VM-owner SIGKILL, separate launcher SIGKILL, Ctrl+C, and timer stopped an independently observed guest writer. Owner stop, interrupt and timer returned 0, 130 and 124. Controlled SIGKILL exited -9. Concurrent open was refused while the owner held its lock. Fresh VMs reopened the same disk after owner and launcher death. |
| Same fixture with `--opencode-inputs <runtime inputs>` | 0 | **PASS at lab tier.** Plain guest Bashwink launched the pinned real TUI and server. One prompt streamed, edited a file and executed a shell tool after PTY approval. The guest process ran unprivileged. Host-path canary contents stayed unchanged. After whole-VM stop, the host checked the original disk inode, read two exact files and refused an unexpected path and bad digest. The fixture used a fixed synthetic result. |
| `bash fixtures/interactive-entry/run.sh` | 0 | **PASS at local-build tier.** Fresh install outside the checkout, version/help, doctor before and after coding-mode startup, and Git, non-Git and nested PTYs passed. Doctor disclosed local host access and refused an unavailable selected native backend. The legacy fixture initially failed doctor from an existing installation. Its broad process-name cleanup was replaced with owned PTYs and fresh state. |
| Installed Seatbelt recovery, lifetime, export-reconciliation, process-policy and admission-shutdown | 0 each | **PASS.** Session, reviewed one-file export, interrupted exchange, live-writer quarantine, OS process denial and shutdown admission controls repeated. |
| `bun run test`, typecheck, Oxlint, formatting, lint gate | 0 each | **PASS.** 404 tests across 23 files and 1,166 assertions, including CLI model-select parsing with workspace and standalone-server refusals. |
| Runtime health, tool lifecycle, contract and idempotent resume | 0 each | **PASS.** 11, 19, 14 and 10 controls against pinned host OpenCode. |
| Native and macOS-only alpha gate tests | 0 each | Four native and five alpha tests passed. The alpha gate refused the incomplete manifest and qualification. |
| Hosted candidate CI and external-user acceptance | — | **NOT RUN.** No candidate archive exists. Prior Actions quota pause remained in effect. |

The local install comes from a source build. Release-tier clean installation,
guest session persistence, reviewed project export, production launcher integration
and an authorized real provider remain open. No supported OS build is advertised.
[Release readiness](releases/v0.1.0-alpha/RELEASE_READINESS.md) ·
[Acceptance results](releases/v0.1.0-alpha/ACCEPTANCE_RESULTS.md)

## macOS shell VM feasibility and interrupted export (2026-11-24)

Source revision `22fc13aea0e3a27c6bbd1283d8e224d8fac58056`. macOS arm64 27.0.1
(26A434). Local CLI tests used Bun 1.4.4 and native OpenCode v2.3.2. The VM lab used
Alpine 3.23.8 arm64, two vCPUs, 512 MiB RAM, and a private 8 MiB raw stage disk.
No Docker runtime, host project share, provider credential or network device was used.

| Command or control | Exit | Result |
| --- | ---: | --- |
| `python3 fixtures/native-offline/vm-boundary.py <pinned-input-directory>` | 0 | **PASS at lab tier**. The guest shell read and wrote the private disk. Its worker entered a new session, verified inherited FD 3 was closed, and advanced a marker observed on the host. Attempts to write the protected host path and reach a synthetic listener failed. The host positive connection succeeded and the protected host hash stayed unchanged. |
| Whole-VM forced stop, abrupt owner death, and guest reopen in the same lab | owner 0, -9, 0 | **PASS at lab tier**. A concurrent launch returned 8 on the host lock while the writer was live. After each stop, the host acquired the lock and independently observed a stable disk marker for two seconds. The final markers were 3, 6 and 9. Reopen after SIGKILL saw marker 6 on the same disk inode. Boot to the guest's detached-worker control took 1.21, 1.00 and 1.02 seconds. No interactive OpenCode latency was measured. |
| Initial image diagnosis | owner 7 | An EFI-wrapped Alpine kernel passed VZ configuration validation and failed to start with `VZErrorDomain` code 1. Extracting the checksum-pinned raw ARM64 Image from the same artifact allowed boot. |
| `python3 fixtures/native-offline/export-reconciliation.py <installed> <runtime>` | 0 | **PASS**. PTY approval followed by exporter SIGKILL before exchange discarded the unused proposal with no commit receipt. SIGKILL immediately after exchange, after receipt publication, and after displaced-file cleanup each reconciled to the same approved inode and digest. The host observer verified the original file before cleanup and refused a divergent host edit and the wrong directory. Retry did not change the inode, receipt, protected canary or evidence chain. |
| Installed `recovery.py`, `lifetime.py`, `process-policy.py`, and `admission-shutdown.ts` | 0 each | **PASS**. File-only PTY turns, saved session recovery, live-writer protection and single-file approval still worked. Environment and alternate flag inputs could not enable shell. A legacy stage without a file-only destination was refused with both reopen flags. Seatbelt still denied fork and spawn with EPERM. |
| Pinned Bun tests, typecheck, Oxlint, format, lint gate | 0 each | **PASS**. 403 tests across 23 files and 1,161 assertions. 62 formatted files and six lint-gate controls. |
| Local OpenCode runtime health, tool lifecycle, contract, and idempotent resume | 0 each | **PASS**. 11, 19, 14 and 10 controls with the pinned runtime. |
| Evidence verification, documentation manifest, task summary and license inventory | 0 each | **PASS**. Nine reopened chain entries verified. The register and license inventory remained consistent. |
| Qualification validator tests and candidate release gate | 0 and 1 | Four validator tests passed. The candidate gate refused incomplete macOS and Ubuntu qualification. |
| Hosted CI, installed VM-backed Bashwink, real provider, abrupt death of a CLI separate from the VM owner, export during system power loss | — | **NOT_RUN**. Hosted Actions remain paused for quota. |
| Ubuntu and external alpha | — | **BLOCKED**. No supported Linux host was available. The shell prototype does not enable a Bashwink backend or satisfy release qualification. |

[Shell containment decision](BW-031_IMPLEMENTATION_REPORT.md#macos-shell-containment-decision) ·
[Qualification results](BW-032_QUALIFICATION_RESULTS.md).

## Native file-only workload lifetime (2026-11-24)

Source revision `35a59ec3a6bd75dcdb237816152d415b7b049994`. Clean local installation
using Bun 1.4.4 and native OpenCode v2.3.2 on macOS arm64 27.0.1 (26A434). The
PTY, loopback mock and host file canaries used disposable fixtures.

| Command or control | Exit | Result |
| --- | ---: | --- |
| `python3 fixtures/native-offline/run.py <historical-install> <runtime> --baseline-shell --lifecycle detached` | harness 0 | **FAIL** for cleanup at historical revision `d402900`. The launcher, TUI and server stopped. The detached worker retained the same PID and start identity, already had parent 1, and had its own group and a different session from the launcher. It wrote into staging after shutdown. The protected host hash was unchanged, and the worker exited on its bounded fixture control. |
| `python3 fixtures/native-offline/lifetime.py <installed> <runtime>` | 0 | **PASS**. A stopped real OpenCode server outlived launcher SIGKILL and retained its kernel lock. Repeated recovery, reopen and export were refused. Once the observed server exited, incomplete proof and manifest were refused. Partial readiness retirement, concurrent recovery and idempotent retry succeeded. A clean stage reopened. Killing the exporter at preview kept the stage interlocked and the original host hash intact. Interruption after atomic exchange was NOT_RUN here. |
| `python3 fixtures/native-offline/recovery.py <installed> <runtime>` | 0 | **PASS**. Installed PTY turns, `--continue` and `--session`, fresh boot proofs, unchanged evidence prefix and explicit one-file export passed. Wrong owner/profile, stale proof, corrupt evidence, links, traversal, FIFO, conflicting host edits and cancellation were refused safely. |
| `python3 fixtures/native-offline/process-policy.py` | 0 | **PASS**. The positive policy allowed fork and spawn, and the synthetic worker created a new session and a nested descendant. The production file-only rule returned EPERM for fork and posix_spawn. |
| `bun fixtures/native-offline/admission-shutdown.ts` | 0 | **PASS**. A prompt waiting on session lookup and a new prompt both received HTTP 403 after the admission gate closed. The upstream counted zero forwarded prompts. |
| `fixtures/native-offline/run.py` lifecycle modes | harness 0 | **PASS** for directly owned processes. Normal exit and Ctrl+C returned 0, server crash 3 and timeout 124. Both owned identities exited and the readiness lease was removed. Wrong executable startup refused before a provider request. Abrupt launcher exit -9 left a readiness lease for explicit verified retirement. |
| `bun run test`, typecheck, lint, formatting, lint gate | 0 each | **PASS**. 402 tests across 23 files with 1,159 assertions, including cancellation escalation and reaping of an inert direct child that ignored TERM. 62 formatted files and six lint-gate checks. |
| `fixtures/runtime-health/run.sh`, tool lifecycle, contract and idempotent resume | 0 each | **PASS**. 11, 19, 14 and 10 checks respectively with the pinned runtime. |
| `bun run verify:evidence <reopened-evidence.jsonl>` | 0 | **PASS**. Nine chain entries verified. |
| Manifest, register summary, license scope, credential-pattern scan and Git whitespace checks | 0 each | **PASS**. No added credential-pattern matches or dependency changes. |
| `python3 scripts/test_native_release_gate.py` and `python3 scripts/verify_native_release.py --revision <source>` | 0 and 1 | Four validator tests passed. The release gate refused the incomplete qualification. |
| Ubuntu / Bubblewrap | — | **BLOCKED**. No supported disposable Linux host was available. The historical Ubuntu readiness failure remains without a verified root cause. |
| New hosted CI | — | **NOT_RUN** under the Actions quota pause. |

Shell-capable native startup is disabled. File-only retirement depends on the
attested no-fork profile, the trusted pinned runtime, and an available host lock
inspector. A stage without a complete writer proof and an interrupted export stay
quarantined. BW-031 and BW-032 remain partial. External alpha remains blocked.
[Qualification results](BW-032_QUALIFICATION_RESULTS.md).

## Native offline recovery and single-file export (2026-11-24)

Source revision `f04c5cbdb4f892804bd5c4d204c36836cff0dbfe`. Installed outside the checkout with Bun 1.4.4 and
OpenCode v2.3.2 on macOS arm64 27.0.1 (26A434). Disposable host and stage directories,
an independent loopback mock, and a controlling PTY were used.

| Command or control | Exit | Result |
| --- | ---: | --- |
| `python3 fixtures/native-offline/recovery.py <installed-bashwink> <native-opencode>` | 0 | File-only Seatbelt admission verified the pinned runtime and kernel rejection of shell launch. Real in-process edits worked. `--continue` then explicit `--session` attached to the same SQLite session after a supervised SIGTERM. The provider saw the earlier and current prompt together. Three distinct boot proofs were recorded and the previous evidence bytes stayed intact. Foreign workspace, incompatible profile, active marker, stale readiness, and truncated evidence were refused with no model request. |
| Reviewed host export in the same PTY fixture | harness 0 | No export on ordinary exit. Declining and Ctrl+C at preview preserved the original hash. A conflict after preview preserved the host edit. Wrong directory, traversal, symlink, hardlink and FIFO were refused. Confirmed apply replaced only `task.txt` with the reviewed bytes and preserved the outside canary hash. |
| `fixtures/native-offline/run.py` supervised lifecycle modes | harness 0 | Normal exit and Ctrl+C returned 0. Server crash returned 3, timeout 124, and wrong-runtime startup 3 before any provider request. Both directly owned processes were gone after supervised exits, and their readiness lease was removed. |
| `run.py --lifecycle abrupt` | harness 0, launcher -9 | Both owned process identities were gone when observed. The readiness file and activation interlock remained. Recovery refuses an outstanding interlock. Abrupt stale-state retirement is unresolved. |
| `run.py --lifecycle detached` | harness 0, cleanup FAIL | A bounded disowned shell process with the same start-time and command identity outlived the owned server and client. The observer ended it through its fixture FIFO and verified it was gone. No PID-only cleanup of detached processes was used. |
| `run.py --lifecycle coding` under the original shell-capable profile | 0 | The file tool and real shell still worked. Seatbelt blocked writes to the protected sibling and the unrelated loopback connection. Host inode, hash and listener state were preserved. |
| `bun run packages/bw-evidence/src/cli.ts verify <reopened-evidence.jsonl>` | 0 | Nine entries verified after the recovered conversation. |
| `bun run test`, typecheck, lint, formatting, lint gate | 0 each | 399 tests passed in 23 files. 61 formatted files and six lint gate checks. |
| Existing runtime, tool permission, contract and resume fixtures | 0 each | 11, 19, 14 and 10 checks respectively using pinned local OpenCode. |
| Ubuntu / Bubblewrap | BLOCKED | Host is Darwin arm64. No local Bubblewrap, x86-64 QEMU or Lima command, no Podman machines, and no Docker daemon responded. The re-read historical Ubuntu job showed OpenCode v2.3.2 launching and a generic readiness failure before the tool fixture. This is insufficient to establish a root cause. New endpoint diagnostics distinguish malformed/oversized output and EOF, report exit/signal where known, and identify inventory, proof and ownership substeps without logging credentials or raw stdout. |
| Hosted CI | NOT_RUN | No new dispatch under the existing Actions quota pause. [Historical Ubuntu diagnostic baseline](https://github.com/ALDRIN121/bashwink/actions/runs/45266792026/job/138015719611). |

Detached cleanup and automatic reopening after launcher SIGKILL are release blockers.
The two experimental commands remain restricted to their fixture profiles. There is
no provider relay or general native coding admission.
[Qualification results](BW-032_QUALIFICATION_RESULTS.md).

## Installed macOS offline TUI milestone (2026-11-24)

Source revision `ac3566340a420304345c1419a2eea0e02ef1f4d2`. macOS arm64 27.0.1 build 26A434. Bun 1.4.4
and OpenCode 2.3.2 were pinned. The build landed outside the source checkout and used
a disposable workspace and local mock. No Docker or provider credentials were used.

| Command or control | Exit | Result |
| --- | ---: | --- |
| `./scripts/build_alpha.sh <temporary-output>` and `python3 fixtures/native-offline/run.py <installed-bashwink> <pinned-runtime> --lifecycle coding` | 0 each | The installed private server attested the evidence plugin and staged workspace. A normal keyboard prompt completed a real in-process write and shell child. ScopeFence refused a second in-process write outside the workspace. The OS rejected the real child's sibling write and unrelated IPv4 loopback connection. The host confirmed the same hash/inode and no connection on its unrelated listener. The durable SQLite session directory and evidence session agreed. |
| Lifecycle fixture with `--lifecycle ctrl-c\|server-crash\|timeout\|startup` | harness 0 each | App exit 0, 3, 124 and 3 respectively. Normal and supervised stops removed both directly owned processes and the lease. Wrong runtime startup made no provider request. |
| Lifecycle fixture with `--lifecycle abrupt` | harness 0, wrapper -9 | Both owned children were gone when externally observed. The readiness lease survived. This is an observed cleanup gap. Detached descendants were outside this test. |
| `bun run packages/bw-evidence/src/cli.ts verify <offline-evidence.jsonl>` | 0 | Native TUI run verified with nine entries. |
| `bun run test`, typecheck, lint, formatting, lint-gate controls | 0 each | 396 tests, zero failures, 59 formatted files and six lint-gate checks. |
| Existing real runtime and policy fixtures | 0 each | Runtime health, tool lifecycle, contract and idempotent resume passed 11, 19, 14 and 10 checks. These run the normal local backend. |
| Ubuntu and Bubblewrap | BLOCKED | Available host is Darwin arm64, no Bubblewrap helper, `podman machine list --format json` returned `[]`, and no Docker daemon responded. Historical Ubuntu readiness failure remains after SQLite bootstrap, before tool lifecycle. Its log lacks a specific readiness substep. No host security settings were modified. |
| Hosted CI for the review branch | NOT_RUN | No new run was started under the existing Actions pause. Historical macOS runtime job passed both steps. Historical Ubuntu runtime readiness failed and the tool lifecycle step was skipped. |

The first native TUI start failed at raw-mode setup. Granting ioctl access to the exact
inherited PTY resolved it. The keyboard test also needed to wait for the prompt surface.
The first shell-canary command used an absolute executable path and ScopeFence correctly
refused it before dispatch. The final run used the approved staged fixture helper and
verified the kernel denial inside the shell child. Native session reopening, host export,
detached cleanup and general native admission remain open.

[Historical hosted run](https://github.com/ALDRIN121/bashwink/actions/runs/45266792026)
· [Qualification results](BW-032_QUALIFICATION_RESULTS.md).

## Installed Seatbelt probe milestone (2026-11-24)

Code revision `368f81173a5c39efc65ae020ac23f4333a682763`. The installed command
`BASHWINK_OPENCODE_BIN=/absolute/path/to/pinned/opencode "$workspace/install/bin/bashwink" sandbox probe`
ran from a disposable directory in macOS 27.0.1 build 26A434, arm64, Darwin 27.0.0.
Bun was 1.4.4. OpenCode v2.3.2 was staged from the packaged native artifact.
The exact runtime, helper and policy template hashes and the probe run ID are recorded
in the [qualification matrix](NATIVE_SANDBOX_QUALIFICATION.json).

| Command or check | Exit | Result |
| --- | --- | --- |
| `./scripts/build_alpha.sh "$workspace/install"` then installed `bashwink sandbox probe` | 0 each | Six PASS. Verified staged write/read, denied child read, denied sibling write, denied symlink write, denied TCP loopback and pinned OpenCode version. Host check verified the protected file hash and device/inode. Host connection control reached the listener exactly once. Guest connection never reached it. |
| Early strict-profile OpenCode version probe | 133 | Bun trapped at startup. Read-only hardware and OS sysctls advanced startup to an ICU Segmenter initialization error. Allowing read-only system ICU data resolved it. All denied controls still passed with these grants. |
| `bun run test` | 0 | 395 pass, 0 fail, 23 files |
| `bun run typecheck`, `bun run lint`, `bun run format`, `bun run lint:gate` | 0 each | Both package checks, 58 formatted files and 6 lint gate assertions |
| `./fixtures/runtime-health/run.sh`, `./fixtures/tool-lifecycle/run.sh`, `./fixtures/contract/run.sh`, `./fixtures/idempotent-resume/run.sh` | 0 each | 11, 19, 14 and 10 checks in the existing local execution mode using the pinned tools |
| Installed `bashwink --prompt 'Bashwink local regression'` in an isolated PTY | 130 after SIGTERM | Local TUI rendered the startup prompt, then removed the readiness lease and reaped the owned server. No provider prompt was sent. |
| `PYTHONDONTWRITEBYTECODE=1 python3 scripts/test_native_release_gate.py` | 0 | Four tests cover valid format, missing/failed/blocked/stale evidence, unsupported targets and probe evidence separation |
| `./scripts/verify_native_release.py --revision 368f81173a5c39efc65ae020ac23f4333a682763` | 1 expected | Real release matrix denied external alpha. Both release targets have unmet required controls. |

Docker was present and unused. Clean macOS/Ubuntu installation, real native PTY coding,
live provider relay, detached cleanup and the current hosted workflow remain without
release-tier results. The earlier Ubuntu runtime failure remains unresolved.
[Qualification results](BW-032_QUALIFICATION_RESULTS.md).

## Native sandbox feasibility (2026-11-24)

The checks below used macOS 27.0.1 (26A434) arm64 and disposable paths and listeners.
Docker was unused. Its CLI was present on the machine and its daemon was unavailable,
so this was a Docker-independent run rather than the clean installation qualification.

| Check | Exit | Observed result |
| --- | ---: | --- |
| `/usr/bin/sandbox-exec -p '(version 1) (allow default)' /usr/bin/true` | 71 inside managed parent sandbox, 0 outside it | The nested attempt reported `sandbox_apply: Operation not permitted`. The approved standalone invocation accepted the profile. |
| Seatbelt disposable file canaries | 0 allowed write, 1 each denied operation | Workspace write succeeded. Sibling write and the same operation through a shell child returned `EPERM` and left the target absent. Reading a synthetic protected file returned `EPERM`. |
| Seatbelt `deny network*` with a fixture-owned loopback listener | 0 positive, 1 denied | Baseline connected. The sandboxed attempt returned `EPERM` and did not reach the listener. |
| Pinned OpenCode `--version` under the network-denied profile | 0 | v2.3.2 started. |
| `./fixtures/tool-lifecycle/run.sh` through a temporary exec-replacing Seatbelt wrapper, Bun 1.4.4 and OpenCode v2.3.2 | 0 | 19/19 with a deliberately narrow profile that protected a synthetic subtree and permitted the loopback mock. The real runtime ran shell and produced evidence. |

The narrow profile demonstrates primitive behavior and OpenCode compatibility under
those settings. A default-deny production policy, installed interactive native workflow,
live provider with protected credentials, detached-descendant cleanup, and clean Linux
execution remain unverified. No new GitHub Actions run was triggered.
[BW-031 feasibility](BW-031-SANDBOX-PROPOSAL.md) · [BW-032 platform controls](BW-032_PLATFORM_QUALIFICATION.md).

## Private runtime readiness and local backend verification (2026-11-23)

Local verification used macOS arm64, Bun 1.4.4 and OpenCode v2.3.2
(`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`). The real-runtime runs used disposable
workspaces, local state and an instrumented loopback mock provider.
[Historical hosted baseline](CI_BASELINE_RECONCILIATION.md).

| Command or check | Exit | Observed result |
| --- | ---: | --- |
| `bun run test` | 0 | 391 passed, 0 failed across 22 files. Includes backend selection, unsupported Docker refusal, policy-before-execution, exit status, cancellation, deadline, reaping, restricted scope and evidence. |
| `bun run typecheck`, `bun run lint`, `bun run lint:gate`, `bun run format` | 0 each | Both packages typechecked, Oxlint clean, gate positive and negative controls 6/6, 56 formatted files. |
| `./fixtures/runtime-health/run.sh` | 0 | 11 checks. The positive control ran a real shell. Missing entry, import failure, wrong export and setup crash each exited 3 with zero provider requests or tool calls despite a valid previous boot entry. A foreign saved session received no prompt. A registered managed server remained running and unused. A held plugin admitted no provider request until registration. A crash after readiness exited 3 with no new tool dispatch. Cancellation during readiness exited 130, launched no client and removed the lease. The evidence chain verified. |
| `./fixtures/tool-lifecycle/run.sh` | 0 | 19/19, no skips. An approved compound shell command created the disposable canary. Unattended shell and explicit denial with `--auto` both left the canary absent. The tool trace and evidence chain verified. |
| `./fixtures/contract/run.sh`, `./fixtures/idempotent-resume/run.sh` | 0 each | 14/14 and 10/10. Approval, revision, recovery and exactly one write. |
| `./fixtures/phase1-demo/run.sh` | 0 | All eight stages, including interruption, tool exit status and evidence verification. |
| `./scripts/build_alpha.sh <temporary output>` and installed CLI PTY smoke | 0 each | Git, plain and nested workspaces showed an attested boot and rendered the TUI. SIGTERM returned 130, recorded cancellation, reaped the owned server and removed the readiness lease in each case. |
| `python3 scripts/verify_bashwink_docs.py --check-manifest`, `python3 scripts/generate_status_summary.py --check`, `python3 scripts/check_license_scope.py --inventory docs/bashwink/DEPENDENCY_LICENSES.json --fail-on-open`, credential-pattern scan and `git diff --check` | 0 each | Manifest, register summary, license scope and diff verified. Credential scan detected the planted control and found no matching pattern in changed files. |

Local execution evidence covers the directly owned client and runtime during supervised
shutdown. There is no evidence for detached descendants, OS isolation or a paid-provider
run on this revision. The pinned client surface and host trust assumptions are recorded in
[ADR-012](ADR-012-PRIVATE-RUNTIME-READINESS.md) and the [backend design](BW-030_EXECUTION_BACKEND_DESIGN.md).

### Hosted qualification and follow-up (2026-11-24)

- `937c496` passed both hosted CLI jobs and macOS runtime health. Ubuntu executed and failed
  the real-runtime readiness fixture during database inspection. [First run](https://github.com/ALDRIN121/bashwink/actions/runs/45227264915).
- `8cfd7d1` identified the Ubuntu database error as `SQLITE_BUSY / 5`. [Ubuntu job](https://github.com/ALDRIN121/bashwink/actions/runs/45266347725/job/138014153559).
- `ce74b4e` added bounded retries for the transient lock and a safe refusal for persisted
  legacy schedules. Its pinned local suite passed 392 tests and its real-runtime fixture
  exited 0. Hosted CLI passed on Ubuntu and macOS. Both real-runtime fixture steps passed
  on macOS. On Ubuntu, readiness failed after database inspection and the downstream tool
  lifecycle step was skipped. The exact readiness substep remains unverified on Ubuntu.
  [Hosted run](https://github.com/ALDRIN121/bashwink/actions/runs/45266792026).

The local follow-up adds readiness substep diagnostics and preserves the pinned TUI prompt
and session arguments. The pinned local suite exited 0 with 393 passed across 22 files.
Typecheck, Oxlint, lint controls, formatting, runtime health (11 checks), tool lifecycle
(19/19), and documentation checks exited 0. The installed TUI showed the native `--prompt`
text after readiness. With the harness continuing to read terminal output through shutdown,
SIGTERM returned 130 and reaped the owned runtime. A prior harness attempt stopped reading
the PTY during shutdown and timed out. The local follow-up has no hosted result. The task
register retains BW-018 and BW-030 as In progress. Hosted execution is paused at the
maintainer’s request.

## BW-018 and BW-030 foundation verification (2026-11-23)

**Historical intermediate baseline:** local audit commit `3e50764` plus the first foundation working tree.
**Environment:** macOS arm64 27.0.1, Bun 1.4.4, OpenCode v2.3.2
(`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`). Integration runs used disposable
state and loopback-only test services. There is no hosted CI result for the foundation
working tree. The hosted cross-platform baseline remains the historical [reconciled run](CI_BASELINE_RECONCILIATION.md).

| Command or check | Exit | Observed result |
| --- | ---: | --- |
| `bun test packages/bw-cli/test/execution-policy.test.ts packages/bw-evidence/test/scope.test.ts` before hardening | 1 | Six expected failures, including server routing, untrusted opt-out, invalid policy, malformed calls and patch move checks. The compound path control already passed |
| `bun run test` | 0 | 387 passed, 0 failed across 21 files. Includes mock cancellation, real child timeout/reaping, missing executable, unavailable Docker refusal, contract shell refusal and atomic plugin registration across opt-outs |
| `bun run typecheck`, `bun run lint`, `bun run lint:gate`, `bun run format` | 0 each | Both packages typechecked, semantic lint clean, gate positive and negative controls 6/6, 52 formatted files |
| `./fixtures/runtime-health/run.sh` | 0 | 17/17, including a real silent import failure reported as missing evidence, invalid plugin resolution refused before spawn, and trusted explicit opt-out |
| `./fixtures/tool-lifecycle/run.sh` | 0 | 16/16, no skips. Real default shell refusal without approval, native deny survives `--auto`, mock can still see normal file tools, and any offered alternate execution tool is denied. Evidence chain verified |
| `./fixtures/contract/run.sh`, `./fixtures/idempotent-resume/run.sh` | 0 each | 14/14 and 10/10. Approved revisions, recovery and exactly one write |
| `./fixtures/phase1-demo/run.sh` | 0 | Eight stages. Real tool lifecycle, mock provider, plan and resume evidence verified |
| `./scripts/build_alpha.sh <temporary output>` and installed CLI PTY smoke | 0 each | Three workspace shapes booted a private `serve --stdio` service with no managed-service dispatch. SIGTERM produced wrapper 130 and recorded backend cancellation in each case |
| Private pinned runtime direct session shell negative control | harness 0 | Disposable workspace and safe canary. The API returned HTTP 500 on denied process creation, evidence contained the lower-hook denial, and the canary was absent. This ran the server route used by the TUI without relying on its keybinding |
| Docs verifier with manifest, generated status check, license scope, credential-pattern scan and `git diff --check` | 0 each | Manifests and task status agree. No matching credential pattern in changed files |

During verification, the first direct-shell keyboard harness entered the normal model prompt
rather than TUI shell mode. It recorded a denial of the unrelated `execute` tool and did not
prove the lower hook, so the direct local session API was used for that check. The real-runtime
permission test initially attached to an existing listener on the old default mock port. The
fixture now allocates its own port and requires its own readiness and request log. The final
check also distinguishes native removal of shell from refusal of any alternate execution tool.

The local backend reaps its direct child. Whole descendant cleanup, fresh hosted Linux and
macOS runs, and paid-provider execution were unverified for this increment. The policy
plugin's silent-load case still lacks pre-dispatch readiness, and BW-031 remains unimplemented.
The canonical status keeps BW-018 and BW-030 in progress. Raw local logs were collected under
the disposable audit directory, including `suite.final.log`, `runtime-health.final-offline.log`,
`tool-lifecycle.final-permissions.log` and `phase1-demo.final-offline.log`.
[BW-018 report](BW-018_IMPLEMENTATION_REPORT.md) · [BW-030 design](BW-030_EXECUTION_BACKEND_DESIGN.md).

## Independent handoff audit (2026-11-23)

**Revision:** `4731eaf11a447fe3a0f3d27c10cbe9a500d42f8a`. The worktree started clean.
**Local environment:** macOS 27.0.1 (26A434), arm64, Apple Git 2.54.0, Bun 1.4.4 (38afee6c8),
OpenCode v2.3.2. The shell default was Bun 1.4.5. Checks below used the pinned binary first
on PATH and local fixture state. Real-runtime fixtures used a throwaway HOME and loopback mock
provider. Hosted results were independently fetched through authenticated `gh api`. [Exact CI runs and attempts](CI_BASELINE_RECONCILIATION.md).

| Command or check | Exit | Observed result |
| --- | ---: | --- |
| `bun --version`, `opencode --version` | 0 each | 1.4.4 and v2.3.2 with isolated XDG paths. An initial bare runtime version probe with the real home hit a sandbox file-write restriction |
| `bun run test` | 0 | 369 pass, 0 fail, 19 files, 1,049 assertions |
| `bun run typecheck`, `bun run lint`, `bun run format` | 0 each | Both packages typechecked. Lint clean. 48 files formatted |
| `bun run lint:gate` | 0 | 6/6. Planted violation exits 1 with actual lint diagnostics |
| `./fixtures/contract/run.sh` | 0 | 14/14 |
| `./fixtures/idempotent-resume/run.sh` | 0 | 10/10. SIGKILL recovery writes exactly once and stays unverified |
| `./fixtures/runtime-health/run.sh` | 0 | 17/17, 0 skipped. Real runtime and mock provider |
| `./fixtures/tool-lifecycle/run.sh` | 0 | 13/13, 0 skipped. Real runtime and mock provider |
| `./fixtures/phase1-demo/run.sh` | 0 | Eight stages. Joined shell lifecycle, check exit 0, interrupted task remains unverified |
| `python3 scripts/check_license_scope.py --inventory docs/bashwink/DEPENDENCY_LICENSES.json --fail-on-open` | 0 | 1,643 inventoried, 48 decisions, no recorded release-blocking open item |
| `python3 scripts/verify_bashwink_docs.py`, `python3 scripts/verify_bashwink_docs.py --check-manifest`, `python3 scripts/generate_status_summary.py --check` | 0 each | Initial checks passed. Independent CSV comparison found outdated manifest metadata. The manifest and release guidance were reconciled |
| `git archive HEAD` into a temporary checkout, `bun install --frozen-lockfile`, separate `bun add @opencode/cli@2.3.2` and `./scripts/build_alpha.sh <temporary-alpha-dir>` | 0 each | Clean source install, pinned runtime postinstall and relocatable wrapper build. The initial build in the restricted environment exited 1 when installing the SDK. The build with registry access passed |
| Installed `bashwink --version`, `bashwink doctor`, and bare `bashwink` with neither stream a terminal | 0 each | Unrelated working directory. Version 0.1.0, doctor 12 checks/8 warnings/0 failures, bare noninteractive prints help |
| Installed bare `bashwink` through Python `pty.fork` in disposable Git, non-Git and nested CWDs | harness 0, children −15 by design | Each launch produced an alternate-screen frame and a boot entry with the expected resolved location, then received SIGTERM from the harness |
| `bun run packages/bw-evidence/src/cli.ts verify <preserved-log>` | 0 on four logs | 17 and 25 entries in two live-coding homes, 31 in a provider verification home and 6 boot entries in a historical PTY home |
| `git -C <preserved-repo> diff --exit-code -- run_tests.py`, `PYTHONDONTWRITEBYTECODE=1 python3 <preserved-repo>/run_tests.py` | 0 each | Tracked test script unchanged. Test output PASS. The tracked edit was `calc.py` only, with pre-existing untracked bytecode in the fixture |

The final docs checks, manifest check, generated status check, license-scope check and
`git diff --check` all exited 0. An independent check matched the 91 CSV tasks and all 36
listed documentation hashes and size fields, resolved relative Markdown file links and scanned
the 16 changed files using the workflow's credential patterns. An installed
`bashwink trust . --by "Bashwink audit"` exited 0 in the disposable non-Git directory. The
subsequent `doctor` exited 0 with six warnings and zero failures.

The PTY harness used an empty runtime argv, fresh Bashwink state per directory and
`{"disabled":true}` in the OpenCode `service.json` at `BASHWINK_HOME` for the successful
three-directory run. It disabled catalogue refresh and auto-update, checked the terminal's
alternate-screen control sequence and matched `location=` in fresh boot evidence. It did not
send a prompt. The first default managed-service case booted but the attempted graceful quit
failed to terminate the launcher in time. Two subsequent cases timed out on its occupied port
because the test placed `service.json` under the wrong config root. The smoke test's own
registered service was identified by PID and executable under its temporary tree and stopped.
This corroborates the documented managed-service lifecycle limitation. The repository fixture
uses broad process-name cleanup and fixed paths, so this audit used a disposable bounded harness
instead.

The preserved live coding fixture had nine CommandCode-attributed before entries, including
shell, read and edit events, two denials, seven after entries and four boot records in the
25-entry chain. The dated historical snapshot below had 24 entries before another boot.
Installed live coding and continuation are supported by the preserved artifacts and historical
transcript. No paid provider call was issued during this audit. The older provider and scope
increments below are historical records. Linux was checked using hosted evidence. No local Linux,
Windows, BW-031 sandbox, dependency advisory scan or new upstream-parity suite was run.

## Phase 2 increment 4 — interactive TUI smoke test (2026-11-23)

### What was actually driven, and what was only observed

This distinction is the point of the section, so it comes first.

| Claim | Evidence class |
| --- | --- |
| Bare `bashwink` starts the TUI in the CWD | **Observed** — real PTY, three directories, boot entry carries the resolved workspace |
| Typing a prompt into the chat works | **Executed** — keystrokes written to the PTY, prompt rendered, model replied |
| Model selection is live | **Observed** — status bar reads `Build · Claude Sonnet 5 CommandCode`; the runtime reported `claude-sonnet-5` in `session.step.started` |
| A real coding task completes | **Executed** — model ran the test, edited the file, re-ran, reported PASS; verified independently afterwards |
| Session recovery after restart | **Executed** — `--continue` restored the prior conversation and the model answered a follow-up about its own earlier fix |
| Evidence-plugin health | **Executed** — boot record per launch, chain re-verified independently, 9/9 tool calls attributed to a model |
| Model *switching* from inside the TUI | **NOT tested** — switching was verified via `--model` and `model use`, not via an in-session picker |

The last row is the gap. An interactive user changing models mid-session through the TUI was not
exercised; only the configuration path was. Do not read this section as "the interactive model
picker was validated".

### The coding task

Disposable repo at `~/Developer/bw-alpha-smoke/repo`, `add` implemented as subtraction:

```
$ python3 run_tests.py
FAIL add(2,3) -> -1, expected 5
1 FAILED                                                        (rc=1)
```

Prompt typed into the TUI:

> Run python3 run_tests.py then fix calc.py so the tests pass. Do not modify run_tests.py.

The TUI showed `add was subtracting instead of adding. Fixing it:`, then an edit, then a shell
call, then:

> Fixed. The bug was in calc.py's add function — it used subtraction (a - b) instead of addition.
> Changed it to a + b, and `python3 run_tests.py` now outputs PASS.

Verified independently after the session, not taken from the model's claim:

```
$ cat calc.py          -> return a + b
$ python3 run_tests.py -> PASS                                  (rc=0)
$ git status --short   ->  M calc.py        (run_tests.py untouched)
```

### Session recovery

Exiting the TUI printed the continuation hint:

```
  Session   calc.py test failures
  Continue  opencode -s ses_df7363038ffe0N4WrzUiYQ6ZLY
```

Relaunched with `--continue` and asked, in a fresh process, *"What was the exact bug you fixed,
and what is the current test output?"*. The model answered with the original defect (`a - b`),
the fix (`a + b`), and the current result (`PASS`, exit 0) in 3.1 s. Conversation and workspace
context survived the restart.

### Evidence health

```
phases: boot 3, model 3, before 9, denied 2, after 7
model-attributed before entries: 9/9
denials: 2
```

Boot records appeared once per launch, each naming its `location`. The chain was re-verified by
recomputing the linkage independently of Bashwink's own verifier: every entry chains to its
predecessor, 24 entries, no breaks.

### Two defects the smoke test found, both fixed

**1. A refusal that could not say why.** On an untrusted workspace the fence returned
`outside this task's allowed paths ()` and "this contract allows file edits only" — when there
was no contract at all. The model could only tell the user its permissions were wrong, not that
`bashwink trust` was the missing step, and it looped. Refusals now carry an `origin` and name the
cause and the command that fixes it:

```
DENIED this workspace is not trusted, so no file may be written. '/…/calc.py' would have written
       /…/calc.py. Run `bashwink trust /…/repo` to allow edits here.
```

Three tests in `scope.test.ts` pin this, including that the misleading "this contract" wording
cannot return.

**2. "May have done real work" about a process that never started.** `bashwink sessions` (the
runtime spells it `session`) exited 1 immediately. The wrapper reported *"the agent may have done
real work; none of it was recorded"*. Cause: the never-started branch tested the **whole chain**
for zero entries, so any earlier run's boot record disabled it. Now keyed on "no boot record for
*this* run" plus a nonzero exit, with a regression test that seeds an earlier run's boot record
first.

### Also corrected

Boot records labelled `cwd=<plugin host cwd>`, which is the runtime's shared host process, not the
workspace — observed as `cwd=/Users/me` for a workspace at `/Users/me/repo`. Renamed to `hostcwd`
so it cannot be read as the run's directory; `location` is the workspace.

### CI for this increment

**Code commit `b38dd51` — 13/13 jobs success, first attempt, no re-run**
([run 45195209661](https://github.com/ALDRIN121/bashwink/actions/runs/45195209661)).
CI ran **293 `cli` tests / 17 files** and **76 `evidence` tests**, against 369 locally.

**Evidence commit `5ff3ff9` — 11/13 success, 2 cancelled, and the cause is not the code**
([run 45196502945](https://github.com/ALDRIN121/bashwink/actions/runs/45196502945)).
`runtime health (macos-15)` and `evidence (macos-15)` were cancelled after queueing 15 minutes
with **`runner_name: ""` and `steps: []`** — GitHub never assigned them a runner, so nothing ran
and those steps could not report a test result. The other two macOS jobs in the same run (`cli`, `fixtures`) did get runners
and passed. This is the third occurrence of macOS runner capacity being unavailable; the code
those two jobs cover passed on `b38dd51` minutes earlier, and on macOS locally.

That distinction is recorded rather than papered over with a green tick: a cancelled job proves
nothing, and re-running until green would hide how often macOS capacity is unavailable.

Authenticated job metadata corrected the later counts. `45196502945` reached 11/13
success across each attempt view. macOS evidence and runtime health cancelled twice.
`45203060880` reached 10/13, including one successful macOS evidence job.
`45207176296` reached 12/13 with only macOS evidence cancelled. All cancelled jobs had
an empty runner name and no steps. All three workflows concluded failure. Use the green
`b38dd51` result as the cross-platform runtime code baseline and keep macOS CI active.
[Job-by-job reconciliation](CI_BASELINE_RECONCILIATION.md).

### Not tested here

- In-session model switching via the TUI picker.
- Windows, in any form.
- Any sandbox: there is none yet, which is why the shell escape in `KNOWN_LIMITATIONS.md` §1
  remains the external-alpha blocker. The reviewed approach is in [BW-031_IMPLEMENTATION_PLAN.md](BW-031_IMPLEMENTATION_PLAN.md).

## Phase 2 increment 3 — alpha stabilisation (BW-059, BW-091 register entry, 2026-11-23)

### The interactive entry point was broken

Bare `bashwink` printed help instead of starting a session, because the dispatcher treated
`first === undefined` as `--help`. For the alpha's most obvious invocation, the one thing it
could not do was start a conversation.

| Directory | Boot entry recorded | Workspace the runtime resolved |
| --- | --- | --- |
| `/tmp/bw-tui-git` (Git repo) | yes | `/private/tmp/bw-tui-git` |
| `/tmp/bw-tui-nogit` (no Git) | yes | `/private/tmp/bw-tui-nogit` |
| `/tmp/bw-tui-nested/deep/sub` | yes | `/private/tmp/bw-tui-nested/deep/sub` |

`fixtures/interactive-entry/run.sh` → **7/7**. The TUI is a full-screen application, so the
assertion is not on its escape-sequence output: each launch's boot entry carries the `location`
the runtime resolved, and a launch that failed produces none.

Two portability traps surfaced while writing that fixture, both of which failed **silently** as
"no boot entry" rather than as an error: macOS `script` has no `-c` flag (that is util-linux),
and `timeout` is absent on macOS. Both are recorded in the fixture's header.

A non-interactive bare invocation still prints help: neither stream is a terminal, and spawning a
TUI onto a pipe hangs instead of failing.

### A launch failure that was misreported

A session killed with `SIGKILL` leaves the runtime's managed service holding its port. The next
launch then dies during start-up with a port-in-use stack trace, and the wrapper reported
"evidence plugin did not initialise" — true, and actively misleading, because the agent never
started at all.

The wrapper now reads the runtime's own log for a known infrastructure failure and reports the
cause, the holding PID, and how to clear it. Unit controls:
`packages/bw-cli/test/service-health.test.ts` (7 tests). The patterns are copied from output the
pinned binary actually produced, and an ordinary provider error is explicitly **not** classified
as an infrastructure failure.

### BW-059 — allowedPaths is enforced

Enforcement is the plugin's `execute.before` hook: the one tool hook whose failure rejects the
call before the tool body runs (`packages/core/src/plugin/hooks.ts`). The wrapper writes the
policy per run from the approved contract; the plugin reads it once at setup, so a mid-run write
cannot change its own fence. A policy that fails to parse is treated as "enforce with no paths"
— fail closed, never open.

Live model, contract with `allowedPaths: ["src"]`, `fixtures/scope-fence/run.sh` → **10/10**:

| Attempt | Result |
| --- | --- |
| `../bw-scope-outside/pwned.txt` | refused; file absent |
| `/tmp/bw-scope-outside/absolute.txt` | refused; file absent |
| in-scope edit of `src/calc.py` | applied; test passes |
| edit of `test_calc.py` (outside scope) | refused; file hash unchanged |

The denials, as recorded in the chain:

```
DENIED write | '../bw-scope-outside/pwned.txt' resolves to /private/tmp/bw-scope-outside/pwned.txt,
             | which is outside this task's allowed paths (src).
DENIED write | '/tmp/bw-scope-outside/absolute.txt' resolves to /private/tmp/bw-scope-outside/absolute.txt, ...
```

Symlink escape is refused because containment is decided on `realpath` of the deepest existing
ancestor — `link -> /etc` then `link/passwd` is lexically inside the workspace and physically
outside it. Unit controls: `packages/bw-evidence/test/scope.test.ts` (23 tests), including that
case with a real symlink.

**Scope of the guarantee, stated precisely.** File writes are fenced and audited. A permitted
shell command is **not** path-bounded: obvious outside path arguments and an out-of-scope
`workdir` are refused, but an interpreter can write anywhere, so every permitted shell call is
recorded as `unconstrained`. Two markers were observed in a verified run:

```
UNCONSTRAINED: shell commands are not path-bounded; only their obvious path arguments were checked
```

`unconstrained` is a separate phase from `denied` so the denial count stays truthful.

### A false security claim, found and fixed

`doctor` said an untrusted workspace denies writes and shell "by default". It did not:
`evaluateCall` existed and was called by **tests only**. A fresh clone was as writable as a
trusted one.

Trust is now enforced through the same hook. Verified with a real model:

| Workspace state | Request | Result |
| --- | --- | --- |
| untrusted | create `proof.txt` | refused; file **absent** |
| after `bashwink trust .` | create `proof.txt` | created, contents correct |

This is the kind of defect that matters more than a missing feature: the documentation asserted a
boundary that did not exist.

### CI

Committed at `93ddfd5` — **13/13 jobs success** on `ubuntu-latest` and `macos-15`
([run 45182633571](https://github.com/ALDRIN121/bashwink/actions/runs/45182633571)).

| Job | ubuntu-latest | macos-15 |
| --- | --- | --- |
| lint / docs integrity / scope statement / license scope / secret scan | success | single-platform |
| `cli` | success — **292 tests / 17 files** | success |
| `evidence` | success — **73 tests** + 50 in the recorder job | success |
| `fixtures` | success | success |
| `runtime health` | success | success |

**The first run of this commit reported failure, and the reason matters.** All four macOS jobs
were `cancelled` with an **empty `runner_name`** and no logs at all — GitHub never assigned a
runner, they queued for exactly 15 minutes and were reaped. Re-running the failed jobs gave
13/13. The distinction is worth keeping straight: that was infrastructure, not code, and the
evidence for it is the absent runner rather than a red assertion.

### Totals

| Gate | Result |
| --- | --- |
| `bun test packages` | **365 pass / 0 fail**, 19 files, 1032 expect() |
| `bun test packages/bw-cli` (as CI runs it) | 292 pass / 0 fail, 17 files |
| `bun test packages/bw-evidence` | 73 pass / 0 fail, 2 files |
| typecheck / oxlint `--deny-warnings` / `bun fmt --check` | clean |
| existing fixtures | runtime-health 17/17, tool-lifecycle 13/13, contract 14/14, resume 10/10, phase1-demo 8/8 stages, scenarios 8/8, baselines 5/5 |
| new fixtures | interactive-entry 7/7, scope-fence 10/10 |

### Not run, and stated as such

- **Dependency vulnerability audit** (`bun audit` / advisory database): not run; no advisory
  source is configured here. Licence inventory **was** checked: 1643 packages, 48 requiring a
  decision, 48 recorded, `open + release-blocking: (none)`.
- **Windows**: untested.
- **Second independently credentialed provider**: still BLOCKED on credit.

## Phase 2 increment 2 — real-model integration (BW-091, 2026-11-23)

Everything in this section was executed. Where a claim could not be tested it is recorded as
**BLOCKED** or **not tested**, never as a pass.

### The provider/protocol defect, reproduced before it was fixed

A custom provider's `package` field selects the wire protocol for **every model of that
provider**. Declaring an OpenAI-chat package on a provider whose Claude models need the
Anthropic Messages endpoint validates, lists, and then fails at the first request:

| Declaration | Result |
| --- | --- |
| `package: openai/chat`, model `claude-sonnet-5` | `Error: Model "claude-sonnet-5" must be called via /provider/v1/messages (Anthropic Messages shape).` |
| per-model `package: anthropic` on that model, no provider-level package | works — both models serve on one provider id |
| per-model `package` for claude + gpt, same provider | works — `MIXED_A` and `MIXED_B` |

This is why `--model id:anthropic` exists and why a mixed-protocol provider writes no
provider-level package.

### Credential routes, verified against the real binary

| Route | Verified | Notes |
| --- | --- | --- |
| `env: ["VAR"]` only, key exported | yes | `{env:VAR}` inside settings was **not** required when the variable is exported — an important simplification |
| `settings.apiKey: "{env:VAR}"` | yes | works, but redundant when `env` is declared |
| `settings.apiKey: "{file:path}"`, mode 0600 | yes | file substituted at run time; value never in config |
| no credential | BLOCKED, not a pass | fails, as it should; the wrapper now pre-flights this |

### Real coding tasks (three, all in disposable workspaces)

| # | Workspace | Task | Model | Result |
| --- | --- | --- | --- | --- |
| 1 | throwaway repo, `calc.py` `add()` subtracts | fix so tests pass | `commandcode/claude-sonnet-5` | ran tests, read files, edited `calc.py`, re-ran tests: both pass. Only the source file changed. |
| 2 | throwaway repo, `median()` wrong for even counts | fix so tests pass | `commandcode/claude-sonnet-5` | identified the even/odd branch, edited, re-ran: 3/3 pass |
| 3 | throwaway repo, `is_palindrome()` ignores case/spaces | fix so tests pass | `commandcode/claude-sonnet-5` | normalised input, edited, re-ran: 2/2 pass |

Task 1 and 3 were run through the **installed** binary from
`~/Developer/bashwink-alpha-install`, outside the source checkout.

### Provider compatibility matrix

| Provider | Transport | Credential | Status | Evidence |
| --- | --- | --- | --- | --- |
| CommandCode (`api.commandcode.ai`) | `anthropic` (Claude models), `openai/chat` (GPT models) | `COMMANDCODE_API_KEY` env | **Verified** (paid) | completions, tool calls, edits, tests, attribution — all three tasks above |
| OpenCode gateway (`opencode/*`) | runtime-internal | none in Bashwink config | **Verified** (gateway, not a second credential) | `opencode/tidepool-alpha-free` → `PROVIDER2_OK`, exit 0 |
| DeepSeek | n/a | `DEEPSEEK_API_KEY` | **Not tested — BLOCKED** | HTTP 402 `Insufficient Balance` from the provider |
| Ollama Cloud | n/a | `OLLAMA_API_KEY` | **Not tested — BLOCKED** | HTTP 402 `Add usage credits or subscribe` |
| GitHub Copilot | device OAuth | none available non-interactively | **Not tested — BLOCKED** | requires interactive device flow |
| Local Ollama | — | — | **Not tested** | no local daemon running (`127.0.0.1:11434` closed) |

**So: one verified paid provider, one verified gateway transport, and no second independently
credentialed provider.** The multi-provider claim rests on that and nothing more.

### Model switching and session continuity

```
session ses_alpha1795433234:
  --model commandcode/claude-sonnet-5   "Remember the number 417"      -> "OK"
  --model commandcode/gpt-6.1-sol       "What number did I remember?"  -> "417"
```

Repeated with the codeword ORCHID through the installed binary: `ORCHID` returned by the
second model in the same session. A session survives a model switch **across two different
wire protocols**.

### Evidence model attribution

Real run, installed binary, 14 entries:

```
phases: {'boot': 1, 'model': 1, 'before': 6, 'after': 6}
models seen: ['commandcode/claude-sonnet-5']
tools called: ['shell', 'read', 'read', 'shell', 'edit', 'shell']
unattributed tool entries: 0
```

A switch records both models:

```
2  model  step model=commandcode/claude-sonnet-5
14 model  step model=commandcode/claude-sonnet-5 variant=default
16 model  step model=commandcode/gpt-6.1-sol variant=default
```

Exported table:

```
## Models

| model | tool calls | steps served | switched |
| --- | ---: | ---: | --- |
| `commandcode/claude-sonnet-5` | 6 | 1 | no |
```

### Evidence survives process termination

A run was started and killed with `SIGKILL` mid-session:

| Measure | Result |
| --- | --- |
| entries before / after | 18 / 22 (grew) |
| chain verification afterwards | `{"ok":true,"entries":22,...}` |

The recorder resumes a verified chain rather than forking or discarding it.

### Redaction at the real boundary

Asked the agent to run a command echoing credential-shaped strings. The evidence log recorded:

```json
{"exitCode": 0, "output": "[REDACTED] and [REDACTED]\n", "wallTimeSeconds": 0.036}
```

The raw strings (`sk-live-…`, `Bearer …`) appear nowhere in the log.

### Secret-on-disk audit

After configuring a provider and running three real tasks, every file under the install and
data directories was searched for the actual `COMMANDCODE_API_KEY` value:

| Location | Real key present |
| --- | --- |
| `opencode.json` | no |
| `data/evidence/evidence.jsonl` | no |
| any file under the data/install roots | **NONE** |

### Clean installation

`scripts/build_alpha.sh` → copied to `~/Developer/bashwink-alpha-install` (outside the repo):

| Check | Result |
| --- | --- |
| no absolute source paths baked in | 0 occurrences of the source paths |
| CLI starts | `bashwink 0.1.0` |
| doctor executes | `12 checks, 7 warning(s), 0 failures` |
| provider config loads | `✓ commandcode`, protocols `anthropic, openai` |
| evidence plugin resolves | `bashwink-evidence resolves to <install>/lib/evidence/src/index.ts` |
| boot entry recorded | `bootSeq 1` on the real run |
| missing credential fails clearly | exit 1, `COMMANDCODE_API_KEY is not set` + `export …` |
| session persistence | verified (above) |
| evidence survives termination | verified (above) |

**Note on installation method.** `bun add` of the packed tarballs **fails**:
`@bashwink/evidence` is `private: true` and depends on `workspace:*`, so it cannot resolve from
the registry. The supported alpha path is the bundled build, not npm publish. Publishing the
scope is a release decision that has not been taken.

### Test totals and CI

Committed at `d586bea` — **13/13 jobs success** on `ubuntu-latest` and `macos-15`
([run 45172805516](https://github.com/ALDRIN121/bashwink/actions/runs/45172805516)).

| Job | ubuntu-latest | macos-15 |
| --- | --- | --- |
| lint / docs integrity / scope statement / license scope / secret scan | success | single-platform jobs |
| `cli` | success — **285 tests / 16 files** | success |
| `evidence` | success | success |
| `fixtures` | success — 8 scenarios | success |
| `runtime health` | success — **17/17** and **13/13** | same |

Local suite under the pinned Bun 1.4.4: **335 tests / 17 files, 973 expect() calls, 0 fail**,
typecheck clean, oxlint `--deny-warnings` clean, `bun fmt --check` clean (44 files).

**The `cli` CI job runs 285 of the 335 tests** because it runs only `packages/bw-cli`; the
remaining 50 run in the `evidence` job. Both jobs are green, so the full 335 are executed
across the two.

**Skipped tests: one, in the `fixtures` job.** The Phase 1 demo's mock-provider leg skips when
the mock provider is not started in that job; it is not a pass and is reported as
`skipped: 1`. It is exercised by the local `fixtures/phase1-demo/run.sh` (8/8 stages) and is
not relied on by any claim above.

### A CI failure this increment produced, and what it taught

The first run at `9b0ed24` failed **both** `cli` legs with exit 127 while all other 11 jobs
passed. Two pre-flight tests assumed "there is no runtime here"; that held on this machine
(a runtime is on PATH) and not on the Linux runner. They now supply an explicit stub runtime,
which also proves the refusal happened *before* spawning and that the runtime's exit code is
propagated when the call is allowed through. Re-run with no runtime on `PATH` locally to
reproduce the CI condition: **335 pass** — so the suite no longer depends on the environment
it happens to run in.

## Phase 2 evidence (2026-11-23) — runtime reliability and BW-055

### The defect, reproduced before it was fixed

Run against the real OpenCode binary with a hand-staged plugin, one case per row. The point is
the last column: a broken plugin did not change the runtime's exit code.

| Case | Runtime exit | Evidence log | What the runtime said |
| --- | ---: | --- | --- |
| entry throws at import | 0 | absent | `WARN … message="failed to load plugin" … cause="Cause([Die(Error: probe: import boom)])"` |
| directory with no resolvable entry | 0 | absent | **nothing** |
| module with the wrong export shape | 0 | absent | `WARN … Plugin must export a default definition with an id and an effect or setup function` |

The wrapper previously returned the child's `0` verbatim, so all three looked like a successful
session that happened to call no tools.

### Commands and actual results

All commands run from the repository root with `BASHWINK_OPENCODE_BIN` pointing at the cached
`@opencode/cli@2.3.2` binary for the runtime-dependent fixtures.

Local run, then the same checks hosted at `0fd50b0`.

| Command | Exit | Actual output |
| --- | ---: | --- |
| `bun --version` | 0 | `1.4.4` |
| `bun test packages` | 0 | `252 pass / 0 fail / 731 expect() calls`, 13 files |
| `bun test packages/bw-cli` (as CI runs it) | 0 | `202 pass / 0 fail`, 12 files |
| `bun run lint` (`oxlint --deny-warnings`) | 0 | no findings |
| `bun run format` (`bun fmt --check`) | 0 | `All 38 files are formatted.` |
| `bun run typecheck` | 0 | both packages clean |
| `./fixtures/runtime-health/run.sh` | 0 | `passed: 17  failed: 0  skipped: 0` |
| `./fixtures/tool-lifecycle/run.sh` | 0 | `passed: 13  failed: 0  skipped: 0` |
| `./fixtures/contract/run.sh` | 0 | `passed: 14  failed: 0` |
| `./fixtures/idempotent-resume/run.sh` | 0 | `passed: 10  failed: 0` |
| `./fixtures/scenario_check.sh` | 0 | `passed: 8 / failed: 0` |
| `./fixtures/phase1-demo/run.sh` | 0 | `DEMONSTRATION PASSED (8 stages)` |
| `./fixtures/reset.sh --check` | 0 | `all 5 fixture(s) at baseline` |

### What the runtime-health fixture proves (17 assertions)

1. **Healthy plugin:** the real runtime boots the plugin, a `boot` entry joins the hash chain,
   and the run record says `evidence=recorded`, `expected=true`.
2. **Import throw:** wrapper exits **3**, not the child's 0; stderr names the failure and says
   the run is NOT verified; the run record persists `evidence=missing`; `evidence status`
   exits 3 and lists it; `doctor` fails its last-run check and prints the runtime log path.
3. **Unresolvable entry:** staging refuses **before the runtime starts**; the exit is 3, the
   diagnostic names the resolution rule, and the evidence log does not grow.
4. **`BASHWINK_EVIDENCE=off`:** the child's exit code is returned, stderr announces the run is
   unverified, and the record says `evidence=disabled` — distinguishable from `missing`.
5. The hash chain still verifies after all four cases.

### What the contract fixture proves (14 assertions)

- A derived contract starts at revision 1, draft, with every plan check required.
- `plan task inspect in_progress` is refused under a draft with the reason and the fix; it is
  allowed after `contract approve`.
- An observation moves the matching criterion to `passed` and records one evidence row whose
  `observationId` is the stored observation.
- One passing check does not verify a task that declares three.
- A revision that omits a criterion reports `1 dropped (kept, not deleted)`; the dropped
  criterion keeps its status, reason and evidence; approval resets to draft.
- Re-adding a dropped id is refused with exit **1** (not a crash), naming why.
- A criterion citing an undeclared check is refused before storage.
- Revision history reads back across a process boundary: 2 revisions, current = 2.

### Phase 2 hosted CI — green on both platforms

[Run 45148495146](https://github.com/ALDRIN121/bashwink/actions/runs/45148495146) at
`0fd50b0`: **13/13 jobs, `ubuntu-latest` and `macos-15`, zero failure annotations.** The first
attempt at this increment,
[run 45148067068](https://github.com/ALDRIN121/bashwink/actions/runs/45148067068), failed in
the two `runtime health` jobs **before any fixture ran**: a fresh `bun add @opencode/cli@2.3.2`
under Bun 1.4 leaves the platform binary as a stub because postinstall scripts are blocked by
default. Fixed in `0fd50b0` by declaring `@opencode/cli` as a trusted dependency in the
throwaway probe manifest. It is a genuinely CI-only defect — the local install had already run
its postinstall — and it is recorded here rather than quietly amended.

Re-run at `394b02f` ([45150430237](https://github.com/ALDRIN121/bashwink/actions/runs/45150430237))
and again at HEAD `c731ab6` ([45151661558](https://github.com/ALDRIN121/bashwink/actions/runs/45151661558)):
**13/13 jobs success**, `opencode v2.3.2` on both platforms, runtime-health 17/17 twice. On
the `c731ab6` attempt the `evidence (macos-15)` job was reported `cancelled` with no steps and
no runner assigned — an infrastructure event, not a test result — and `gh run rerun --failed`
produced a full green run. Recorded because "cancelled with no runner" is not a pass.

| Job | ubuntu-latest | macos-15 |
| --- | --- | --- |
| lint / docs integrity / scope / license scope / secret scan | success | — (single-platform jobs) |
| evidence | success | success |
| cli | success — `Ran 202 tests across 12 files` | success — `Ran 202 tests across 12 files` |
| runtime health | success — runtime-health 17/17, tool-lifecycle 13/13, `opencode v2.3.2` | success — 17/17 and 13/13 |
| fixtures | success | success |

### Unit and integration tests added (64)

| File | Tests | Covers |
| --- | ---: | --- |
| `packages/bw-cli/test/runtime-health.test.ts` | 16 | plugin entry resolution, staging refusal, run records, boot detection, tamper detection |
| `packages/bw-cli/test/contract.test.ts` | 22 | schema validation, path rules, transitions, execution gate |
| `packages/bw-cli/test/contract-store.test.ts` | 19 | migration v2, round-trip, revision sequencing, drop semantics, evidence linkage |
| `packages/bw-cli/test/contract-cli.test.ts` | 4 | the lifecycle through real subprocesses |
| `packages/bw-evidence/test/recorder.test.ts` | +3 | `boot` entries in the chain |

### What this does NOT prove

- No Windows run; the new CI job covers Linux and macOS only.
- The boot record proves `setup()` completed, not that a tool ran. A zero-tool session is
  legitimate and still recorded.
- Running the OpenCode binary directly bypasses the wrapper's health check by design.
- The contract gates task *start*, not each file/shell action (BW-059).
- No real-model run: every agent turn used the local mock provider.

## Phase 1 evidence (2026-11-23) — implemented and locally verified

### Phase 1 hosted CI — green on both platforms

Current HEAD `ad9d44e` is covered by run
[45129207277](https://github.com/ALDRIN121/bashwink/actions/runs/45129207277): **11/11 jobs, both
`ubuntu-latest` and `macos-15`**, and **zero failure-level annotations** across all eleven jobs.

The run below at `f753920` is the one that first proved the Phase 1 suite on both platforms and
is retained because its job log is quoted here; `ad9d44e` changes only workflow framing (see
"Two misleading CI signals, removed" below), not product code.

Run [45119233542](https://github.com/ALDRIN121/bashwink/actions/runs/45119233542) at
**`f753920`**: **11/11 jobs, both `ubuntu-latest` and `macos-15`.**

| Job | ubuntu-latest | macos-15 |
| --- | --- | --- |
| `cli` | success | success |
| `evidence` | success | success |
| `fixtures` | success | success |
| `lint`, `docs integrity`, `license scope`, `scope statement`, `secret scan` | success (single-instance) | — |

Read out of the `cli (ubuntu-latest)` job's own log, not inferred from a green tick:

```
Ran 141 tests across 8 files. [1.91s]        141 pass / 0 fail
$ tsc --noEmit -p tsconfig.json              (clean)
PASS  child was SIGKILLed while holding an attempt open
passed: 10  failed: 0                        (idempotent-resume fixture)
version: bashwink 0.1.0
initialised /home/runner/work/_temp/bw-smoke
8 checks, 1 failure(s): runtime              (doctor, rc=1 as asserted)
SKIP  no OpenCode runtime available          (tool-lifecycle, honestly skipped)
```

**The three risks that this run existed to settle are settled:**

1. **`bun:sqlite` on Linux** — the store passed all 141 tests including the migration,
   durability and attempt-tracking suites. The single-writer WAL assumption holds on Linux.
2. **Symlinked plugin staging on Linux** — no failure. The fixture could not exercise it
   end-to-end because the runtime is absent (it skips honestly), but `stagePlugins` and
   `stagedPluginIds` are covered by the passing unit tests on both platforms.
3. **Git subprocess fixtures on Linux** — `git --no-color diff` behaviour differs by version;
   the three git fixtures passed on `git 2.56.1` (Linux) as well as Apple Git 2.54.0.

The first attempt, run [45118931489](https://github.com/ALDRIN121/bashwink/actions/runs/45118931489)
at `ee4652f`, failed — **in the workflow, not the code**: the smoke step asserted
`test -d "$BASHWINK_HOME"` after `--version`, which never touches the filesystem, and used
`doctor || true`, discarding the exit code that *is* the BW-009 acceptance criterion. Both fixed
in `f753920`.

### Two misleading CI signals, removed in `ad9d44e`

Both were green runs saying something red, and neither was a test or product defect.

1. **The `fixtures` job carried a red failure annotation on a run where every step exited 0.**
   `bun test` detects GitHub Actions via `GITHUB_ACTIONS=true` and emits each assertion failure as
   an `::error::` workflow command. The `failed-test` fixture is *supposed* to fail — that is the
   assertion — so the step passed while the UI showed `Expected: "hello-world" /
   Received: "-hello-world-"` as a failed check at `.github#23`. Present on both `fixtures` legs.
   Fixed by unsetting the variable for that one command (`env -u GITHUB_ACTIONS bun test`); the exit
   code is still the signal and a negative control confirms the step still fails when the suite
   genuinely passes.

2. **Every job carried `Node.js 20 is deprecated … forced to run on Node.js 24`.** `checkout@v4`
   and `setup-python@v5` declare `runs.using: node20`, so they were executing on GitHub's
   compatibility shim. Currently a warning; when the shim is removed those jobs stop starting
   entirely. Bumped to the first majors that declare `node24` — `checkout@v5`,
   `setup-python@v6` — confirmed per tag from `action.yml`, not from the version number (the two
   actions moved at different majors).

Read from the run rather than inferred: run `45129207277` reports **0** failure-level annotations
across all eleven jobs (three `notice` annotations remain, all macOS arm64 queue-capacity), and the
job log on `fixtures (ubuntu-latest)` still shows `2 pass / 1 fail` — the fixture still reproduces
its bug — with the step itself green because the failure is the assertion.

### Test totals

| Suite | Tests | Result | Command |
| --- | ---: | --- | --- |
| `@bashwink/evidence` (Phase 0 recorder) | 47 | **47 pass / 0 fail** | `bun run test:evidence` |
| `@bashwink/cli` (Phase 1) | 141 | **141 pass / 0 fail** | `bun run test:cli` |
| **Total** | **188** | **188 pass / 0 fail** — on Linux and macOS | `bun run test` |

Typecheck: `tsc --noEmit` clean on **both** packages (`bun run typecheck`). Semantic lint:
`oxlint --deny-warnings` clean over 32 files. Formatting: `bun fmt --check` clean.

### What each Phase 1 acceptance criterion was verified *by*

| Task | Acceptance criterion | Verified by | Result |
| --- | --- | --- | --- |
| BW-008 | `--help`/`--version` work from a clean install | subprocess tests asserting exit 0 and the Bashwink name | pass |
| BW-008 | upstream name only where attribution requires | `--version` prints `bashwink 0.1.0` | pass |
| BW-009 | missing preconditions → actionable message + nonzero exit | `doctor` exit **1** without a runtime, **0** with one | pass |
| BW-009 | no credentials printed | planted sentinel must not appear in stdout **or** stderr; reports length+fingerprint only | pass |
| BW-010 | onboarding tested against clean home and untrusted fixtures | trust tests + `BASHWINK_HOME`-isolated subprocess runs | pass |
| BW-010 | defaults cannot silently grant shell/write | `UNTRUSTED_POLICY` asserted as data; `--approve` cannot override a hard `deny` | pass |
| BW-011 | build agent can edit, plan agent cannot | `assertEditable` refuses `draft`/`rejected`; file bytes unchanged | pass |
| BW-011 | edits, diffs, undo, cancellation, resume across three fixtures | three real git fixtures; undo byte-identical and idempotent | pass |
| BW-012 | invalid transitions rejected | `InvalidTransitionError` with from/to and the allowed set | pass |
| BW-012 | task graph survives restart | reopen test: plan + statuses + transition history restored | pass |
| BW-012 | migration rollback documented | `Store.rollback()` executed by a test, then re-migrated | pass |
| BW-013 | example plan and machine schema validate | 19 validator tests incl. cycles, unknown deps, approval attribution | pass |
| BW-013 | plan renders in terminal and can be inspected before editing | `plan show` renders the graph; `--json` emits the schema | pass |
| BW-014 | tool sequence complete for fixture runs | **real runtime**: `before`/`after` joined on call id | pass |
| BW-014 | secret fixture values absent | planted `sk-proj-…` sentinel absent from the log | pass |
| BW-014 | events append-only and survive crash | second run extended 2 → 4 lines; chain verified | pass |
| BW-015 | export verified against raw process result | `digestFile()` sha256 of the raw output, recomputable | pass |
| BW-015 | failure and `not_run` statuses | `pass`/`fail`/`not_run` kept distinct end to end, incl. rendering | pass |
| BW-016 | tool events task-linked or `unassigned` with reason | `taskID` from the durable marker; `unassignedReason` otherwise | pass |
| BW-016 | interrupted state survives restart | SIGKILL fixture then a fresh process reads it back | pass |
| BW-019 | kill/restart neither double-edits nor falsely verifies | real SIGKILL, `writes=1`, reopened to `in_progress` | pass |

### The two fixtures, with their real output

**`fixtures/idempotent-resume/run.sh` — 10 pass / 0 fail (real SIGKILL)**

```
PASS  child was SIGKILLed while holding an attempt open
PASS  the unfinished attempt survived the kill and is reported
PASS  the interrupted task is reported as in_progress, not verified
PASS  resume reopened the task into in_progress
PASS  resume did NOT claim the abandoned task passed
PASS  resume states the work is unverified and lists what to re-run
PASS  an abandoned attempt is not counted as applied, so resume re-checks the file
PASS  the identical write was applied exactly once
PASS  the second attempt was skipped by fingerprint, not by luck
PASS  verification refused: the state machine forbids it from here
passed: 10  failed: 0
```

**`fixtures/tool-lifecycle/run.sh` — 13 pass / 0 fail against the real OpenCode binary**

```
{"total":2,"befores":1,"afters":1,"matched":1,"exits":[0],"tools":["shell"],
 "linked":2,"reasoned":0,"bare":0,"taskIDs":["inspect"]}
PASS  at least one 'before' event was recorded
PASS  at least one 'after' event was recorded — the outcome is captured
PASS  every after-event shares a call id with its before-event
PASS  the shell exit status was captured (0)
PASS  no event is silently unattributed
PASS  events were attributed to the active task
PASS  the planted secret never reached the log
PASS  the second run extended the log instead of rewriting it
PASS  the hash chain still verifies after two runs
PASS  running a tool did not verify the task
passed: 13  failed: 0  skipped: 0
```

`tool: "shell"` and `exit: 0` are the real values read out of the log, not asserted into
existence: the mock asked the agent to run `printf 'bw-mock-ok\n'` and that command's exit
status is what was captured (see the `Nested exit code` pitfall in the Phase 0 section — the
status is lifted out of `output.exitCode`, not read from a top-level field).

**`fixtures/phase1-demo/run.sh` — the Phase 1 exit demonstration, 8 stages, one plan**

```
1. doctor — preconditions              5. patch — one real agent turn
2. trust the workspace                 6. terminate mid-check (SIGKILL)
3. plan — inspectable objective        7. resume — reopen, claim nothing
4. approve — edits blocked until then  8. inspect events — what actually ran

PASS  an after-event is joined to its before-event
PASS  the shell exit status was captured
PASS  every event is task-linked or explicitly unassigned
PASS  the killed task is back in_progress, not verified
PASS  nothing was verified by the interruption
PASS  the evidence hash chain verifies after the whole walkthrough
DEMONSTRATION PASSED (8 stages)
```

### Three real defects found only by running the thing

1. **The evidence plugin was never staged.** `stagePlugins()` existed and was unit-tested, but
   `main.ts` never called it — so the real runtime ran the tool, printed the output, exited 0,
   and recorded **nothing**. Every unit test passed throughout. The end-to-end fixture is what
   caught it, and it is the reason BW-014's acceptance is worded "the tool sequence is complete
   for fixture runs" rather than "the hooks fire".
2. **An `exports` target cannot be an absolute path.** The first staging attempt wrote
   `{"exports": {".": "/abs/path/index.ts"}}`, which the loader skipped **silently** — no
   plugin, no error, no log line. Then a relative re-export shim failed too, because `/tmp` is a
   symlink to `/private/tmp` on macOS so the computed `../../..` did not resolve. Both are
   recorded in `stagePlugins`'s docstring; the fix is a symlink to the real package, which
   cannot drift from it and resolves its dependencies from the real location.
3. **`git --no-color diff` is not valid.** The flag belongs to the subcommand. Two git fixtures
   were asserting against empty output until this was fixed — the tests were wrong, not the
   code, and the failure was an empty string rather than an error.

### What Phase 1 evidence is and is not

- **Verified on Linux and macOS.** `cli` and `evidence` jobs are green on `ubuntu-latest` and
  `macos-15` (run 45119233542). The end-to-end runtime evidence (BW-014, the 8-stage demo) was
  produced **locally on macOS arm64** only, because CI deliberately does not install the
  225 MB runtime package; the fixture reports `SKIP` there rather than passing vacuously.
- **No real model provider was used.** The agent turns went through the local mock
  (`127.0.0.1`, ADR-006). That proves the tool-lifecycle seam; it does not prove behaviour
  against a hosted model.
- **`bun:sqlite` is a single-writer assumption.** Concurrent agents are Phase 4 (ADR-004).
- **The doctor's `docker` check only tests presence on `PATH`.** It does not verify the daemon
  is reachable.
- **`current-plan.json` and the SQLite store are two sources of truth**, written together by
  the CLI. A crash between the two writes could desynchronise them.


## Final remediation evidence (2026-11-23)

### Licensing (ADR-009)

| Check | Command / method | Result |
| --- | --- | --- |
| FFmpeg is inside `libopentui.dylib` | `nm -gU libopentui.dylib` | **796** FFmpeg symbols, 0 external `libav*` dylib deps |
| The dylib is embedded in the binary | full-length byte compare at offset | **True**, offset **167,016,147** |
| No-FFmpeg build is possible | `zig build -Doptimize=ReleaseFast` (no prefix) | `warning: … building without video`, **exit 0** |
| FFmpeg symbols after rebuild | `nm -gU` | **796 → 0 genuine** (1 regex hit is `_ot_video_set_av_sync_offset`, an OpenTUI API name) |
| Public video API preserved | `nm -gU \| grep ot_video` | **11** symbols still exported |
| Exported-symbol delta | `comm -23` on sorted symbol sets | 2,702 → 1,888; **814 removed**, 795 of them `_ff_*` internals |
| No-FFmpeg library loads and renders | `OPENTUI_LIB_PATH` + TUI start | **no init errors**, TUI rendered (10,792 B) |
| ABI check passes | `ot_context_abi_version` | version **1** matches |
| `OPENTUI_LIB_PATH` is honoured | negative control → nonexistent path | `Error: Failed to initialize OpenTUI render library (set by OPENTUI_LIB_PATH)` |
| Mechanism enables replacement | positive control → re-signed modified dylib | TUI rendered normally |
| Notices bundle generated | `generate_notices.py --model PM-1 --no-ffmpeg` | 7 components, 30,075 B, **FFmpeg excluded** |
| Notices bundle (stock) | `generate_notices.py --model PM-1` | 8 components, 58,866 B, FFmpeg + LGPL included |
| Release licensing gate | `check_license_scope.py --fail-on-open` | **exit 0** — no release blockers |

### Fixture scenarios (previously unexecuted)

| Check | Result |
| --- | --- |
| `fixtures/scenario_check.sh` | **8 / 8 pass** |
| cancellation: killed mid-run (SIGKILL) | 3/5 steps done, **step-5 absent** — no completion claimed |
| cancellation: partial artifacts visible | yes; fixture resets clean afterwards |
| rollback: mutate then revert | file **byte-identical** to baseline (`3d29c1f0…`) |
| rollback: working tree clean after revert | yes |

### Mock provider defect (Part 3 finding)

The mock previously ran `printf 'bw-mock-fail'; exit 7` while its final message claimed
"the command printed bw-mock-ok" — so the failure path was indistinguishable from success and
every transcript's `exit=7` was unexplained. Fixed with `--scenario ok|fail`.

| Scenario | Command run | Evidence `exit` | Model's final text |
| --- | --- | ---: | --- |
| `ok` | `printf 'bw-mock-ok\n'` | **0** | claims success (matches) |
| `fail` | `printf 'bw-mock-fail\n'; exit 7` | **7** | **admits exit 7** (matches) |

Both verified end-to-end: **4 / 4 assertions pass**.

### Pinned toolchain

| Check | Result |
| --- | --- |
| `bun install --frozen-lockfile` under Bun 1.4.4 | exit 0, no changes |
| `bun run test:evidence` under Bun 1.4.4 | **47 pass / 0 fail** |
| `typecheck` under Bun 1.4.4 | exit 0 |

### Full local verification (9 checks)

| # | Command | Exit |
| ---: | --- | ---: |
| 1 | `bun run test:evidence` → 47 pass / 0 fail | 0 |
| 2 | `bun run --cwd packages/bw-evidence typecheck` | 0 |
| 3 | `python3 scripts/verify_bashwink_docs.py` → `Audit: PASS` | 0 |
| 4 | `python3 scripts/generate_status_summary.py --check` | 0 |
| 5 | `python3 scripts/check_license_scope.py --inventory …` | 0 |
| 6 | `python3 scripts/check_license_scope.py … --fail-on-open` | **0** (was 3) |
| 7 | `./fixtures/reset.sh --check` | 0 |
| 8 | `./fixtures/scenario_check.sh` | 0 |
| 9 | `python3 scripts/generate_notices.py --model PM-0` | 0 |

### CI — still never executed

**No hosted run exists.** Verified concretely: `git remote -v` returns **nothing** (no remote
is configured) and `gh auth status` reports *"You are not logged into any GitHub hosts."*
Every workflow step was validated locally instead (see the table above), but **local success
is not evidence that CI passes**. BW-006 stays In progress.

## Recorder defect remediation (F-02 / F-03 / F-08)

| Finding | Command | Observed before fix | Observed after fix |
| --- | --- | --- | --- |
| **F-02** object bypass | `normalise({nested:{message:'x'.repeat(10000)}}, 100)` | **10,025 bytes** stored, `truncated: true` | **105 bytes** stored, `truncated: true` |
| **F-02** array bypass | `normalise(<2000-element array>, 100)` | **134,891 bytes** | **111 bytes** |
| **F-02** multibyte | `normalise({t:'€'.repeat(5000)}, 100)` | **15,008 bytes** | **104 bytes** |
| **F-03** note redaction | token written via `note` | **present on disk** | `[REDACTED]` |
| **F-03** raw `record()` | token written via `record()` | **present on disk** | redacted |
| **F-04** peer pin | `packages/bw-evidence/package.json` | `^2.3.2` (caret) | exact `2.3.2` |
| **F-04** clean consumer | `bun install` in empty dir, registry only | never performed | **259 packages, exit 0**, `@opencode/plugin@2.3.2` |
| **F-04** plugin identity | `import("@opencode/plugin")` | unverified | `Plugin` export present; our definition's key set **matches** `Plugin.define` output |
| **F-01** runner label | `grep macos-14 .github/workflows/` | present | absent; `macos-15` (retirement confirmed from GitHub's changelog) |
| **F-08** resume on tampered log | reopen after editing an entry | extended the corrupted chain | **refuses**; `health.ok === false`, `length === 0` |

### Bashwink's own suite

| Command | Result | Exit |
| --- | --- | --- |
| `bun run test:evidence` | **47 pass / 0 fail**, 95 `expect()` calls | 0 |
| `bun run --cwd packages/bw-evidence typecheck` | clean | 0 |
| `python3 scripts/verify_bashwink_docs.py` | `Audit: PASS` | 0 |
| `python3 scripts/generate_status_summary.py --check` | status block matches the register | 0 |
| `python3 scripts/check_license_scope.py --inventory docs/bashwink/DEPENDENCY_LICENSES.json` | 48/48 decided | 0 |
| `... --fail-on-open` | correctly fails on the one OPEN release blocker | **3** |
| `./fixtures/reset.sh --check` | all 5 at baseline | 0 |
| live agent run, hardened recorder | `before` + `after`, `exit=7` recorded | 0 |

Test count went 32 → 47: **15 new regression tests**, none existing test weakened or removed.

### Reproduction harness output (before → after)

```
F-02 serialized length = 10025 (cap 100)   ->  105
F-02b array serialized length = 134891     ->  111
F-02c multibyte bytes = 15008 (cap 100)    ->  104
F-03 token on disk in note = true          ->  false
F-03b raw record() token on disk = true    ->  redacted
--- 5 defect(s) reproduced ---             ->  --- 0 defect(s) reproduced ---
```

## Phase 0 tasks

## CI execution (real GitHub Actions runs — 2026-11-23)

**Repository:** `https://github.com/ALDRIN121/bashwink`, branch `main`.
**CI DID run on the initial push.** `gh run list` returning "no runs found" was a timing
artifact; the run existed moments later. Nothing was wrong with the trigger configuration.

### Run history

| Run | Commit | Workflow | Conclusion | Duration |
| --- | --- | --- | --- | ---: |
| [45064795624](https://github.com/ALDRIN121/bashwink/actions/runs/45064795624) | `437c742` | `verify` | **failure** — 7/8 jobs, secret scan failed | 26 s |
| [45065505536](https://github.com/ALDRIN121/bashwink/actions/runs/45065505536) | `9b95d37` | `verify` | **success** — 8/8 jobs | 22 s |
| [45066245596](https://github.com/ALDRIN121/bashwink/actions/runs/45066245596) | `0b09620` | `verify` | **success** — 8/8 jobs | — |
| [45067382809](https://github.com/ALDRIN121/bashwink/actions/runs/45067382809) | `8a3286c` | `verify` | **success** — 8/8 jobs | 29 s |
| [45111515216](https://github.com/ALDRIN121/bashwink/actions/runs/45111515216) | `c536466` | `verify` | **success** — 9/9 jobs (format-only gate) | 25 s |
| [45112004423](https://github.com/ALDRIN121/bashwink/actions/runs/45112004423) | `0c299df` | `verify` | **success** — 9/9 jobs | 27 s |
| [45112152598](https://github.com/ALDRIN121/bashwink/actions/runs/45112152598) | `a86de7a` | `verify` | **success** — 9/9 jobs | 34 s |
| [45112989970](https://github.com/ALDRIN121/bashwink/actions/runs/45112989970) | `bf33e20` | `verify` | **success** — 9/9 jobs, **semantic lint + gate self-test** | 28 s |
| [45065638555](https://github.com/ALDRIN121/bashwink/actions/runs/45065638555) | `9b95d37` | `upstream-compat` | **failure** — 28 `Ripgrep` tests per platform | — |
| [45066246923](https://github.com/ALDRIN121/bashwink/actions/runs/45066246923) | `0b09620` | `upstream-compat` | **success** — both platforms, all 11 steps each | ~5 min |
| [45110993064](https://github.com/ALDRIN121/bashwink/actions/runs/45110993064) | `8a3286c` | `upstream-compat` | **success** — both legs | 9 m 46 s |
| [45112577853](https://github.com/ALDRIN121/bashwink/actions/runs/45112577853) | `8a3286c` | `upstream-compat` | **cancelled** — superseded by the run below | — |
| [45113462602](https://github.com/ALDRIN121/bashwink/actions/runs/45113462602) | `bf33e20` | `upstream-compat` | **success — both legs at the lint-gate commit** | 10 m 4 s |

### `upstream-compat` results, run 45113462602 (commit `bf33e20`)

Re-dispatched at the commit carrying the real lint gate. This proves the **upstream** OpenCode
baseline, not Bashwink code, and it is the run that satisfies the documented gate at the current
commit rather than three commits behind it.

| Step | ubuntu-latest | macos-15 |
| --- | --- | --- |
| Check out the pinned upstream | success (`v2.3.2`) | success |
| Install upstream dependencies | success | success |
| Ensure bash >= 4 | success | success |
| Install the pinned ripgrep | success (`15.1.0`, SHA-256 checked) | success |
| **Upstream core suite** | **7,251 pass / 0 fail** (`Ran 7596 tests across 326 files`) | **7,561 pass / 0 fail** (`Ran 7595 tests`) |
| Upstream SDK suite | success — 40 tests / 0 fail | success — 40 tests / 0 fail |

Note the commit relationship honestly: `verify` ran at `bf33e20` (the lint gate) and
`upstream-compat` also ran at `bf33e20`. HEAD moved to `b76c8f2` afterwards, which is a
**documentation-only** commit — `git diff bf33e20..b76c8f2` touches four `.md` files and no
source, workflow or lockfile, so the upstream baseline result carries over unchanged.

### `upstream-compat` results, run 45066246923 (commit `0b09620`)

This job proves the **upstream** OpenCode baseline, not Bashwink code. Both platform legs fully
green, including the step that previously failed on every platform:

| Step | ubuntu-latest | macos-15 |
| --- | --- | --- |
| Check out the pinned upstream | success (`v2.3.2 @ c0ad18b402eb…`) | success (same SHA) |
| Install upstream dependencies | success | success |
| Ensure bash >= 4 | success | success |
| **Install the pinned ripgrep** | **success** — `downloading …x86_64-unknown-linux-musl.tar.gz`, `rg.tar.gz: OK`, `ripgrep 15.1.0 (rev af60c2de9d)` | **success** — `…aarch64-apple-darwin.tar.gz`, `rg.tar.gz: OK`, same version |
| **Upstream core suite** | **success — 7,251 pass / 345 skip / 0 fail** | **success — 7,561 pass / 34 skip / 0 fail** |
| Upstream CLI suite | success — 408 pass / 9 skip / 0 fail | success — same |
| Upstream SDK suite | success — 40 pass / 0 fail | success — same |
| Upstream compatibility report | success — `Baseline c0ad18b402eb (v2.3.2)`, `Commits ahead: 0` | success |

The zero-failure result on **both** platforms is the direct proof the ripgrep fix was correct:
the same 28 tests failed on both legs before it, and now none do.

### `verify` job-level results, run 45065505536 (commit `9b95d37`)

| Job | Conclusion | Duration |
| --- | --- | ---: |
| docs integrity | **success** | 6 s |
| evidence (ubuntu-latest) | **success** | 10 s |
| evidence (macos-15) | **success** | 11 s |
| fixtures (ubuntu-latest) | **success** | 10 s |
| fixtures (macos-15) | **success** | 23 s |
| license scope | **success** | 5 s |
| secret scan | **success** | 9 s |
| scope statement | **success** | 5 s |

### Lint gate — the criterion was unmet twice, and how it was finally satisfied

BW-006's acceptance reads *"PR gets deterministic **lint**, typecheck, unit, secret scan and
supported-platform smoke status"*, and the independent review (correction item 2) asked for a
root lint gate. Typecheck existed; **lint did not** — no linter config, no script, no step. So
BW-006 was marked Done while the criterion was unmet.

**First attempt was insufficient.** `bun fmt --check` was added and described as the lint gate.
That was wrong: `bun fmt` is a **formatter**. It rewrites whitespace and reports nothing about
unused bindings, unreachable code, `debugger` statements, or any other semantic defect. A tree
can be perfectly formatted and full of real lint errors. Presenting it as lint is precisely the
kind of criterion-relabelling this gate exists to prevent.

**Actual lint gate.** `oxlint` 1.94.0, pinned exactly in `package.json` and `bun.lock`. Chosen
over ESLint because it is one self-contained binary with no plugin resolution, so a runner
installs and runs it deterministically. `categories.correctness: error` in `.oxlintrc.json`,
and `--deny-warnings` so a warning cannot exit 0.

Two gates, deliberately separate — neither substitutes for the other:

| Gate | Command | What it proves |
| --- | --- | --- |
| Semantic lint | `bun run lint` → `oxlint --deny-warnings packages` | no correctness defects |
| Formatting | `bun run format` → `bun fmt --check packages` | style is deterministic |
| Gate self-test | `bun run lint:gate` → `scripts/check_lint_gate.sh` | both directions actually work |

`check_lint_gate.sh` asserts four independent things, because a nonzero exit alone proves
nothing about a working gate:

| # | Assertion | Why it is needed |
| --- | --- | --- |
| 1 | the real tree lints clean | the positive control |
| 2 | the scope linted **>0 files** | oxlint exits **0** on `No files found to lint` — a scope typo would otherwise be a vacuous green |
| 3 | `fixtures/lint-violation/bad.ts` is rejected | the negative control |
| 4 | rejection names `no-unused-vars` **and** `no-debugger`, and is not a crash/config error | an exit 1 from a broken invocation is not a detection |

Negative controls exercised by hand as well:

| Control | Result |
| --- | --- |
| Committed fixture with `no-unused-vars` + `no-debugger` | exit **1**, both rules named |
| Scope typo (`packges`) | gate **FAILS** as vacuous — `linted ZERO files` |
| `.oxlintrc.json` categories gutted | still exit 1 — rules fire from defaults, not only the config |

Applying the formatting gate earlier was **formatting-only** (5 trailing commas plus rewraps);
47/47 tests and typecheck were re-run afterwards.

### CI results for both gates, run 45112989970 (commit `bf33e20`)

Read out of the lint job's own log, not inferred from a green tick:

```
$ oxlint --deny-warnings packages
Found 0 warnings and 0 errors.
Finished in 5ms on 5 files with 82 rules using 2 threads.

PASS  tree lints clean (exit 0)
PASS  lint scope 'packages' actually contained 5 file(s)
PASS  fixture rejected with exit 1
PASS  fixture rejected for no-unused-vars (a semantic rule actually fired)
PASS  fixture rejected for no-debugger (a second independent rule fired)
PASS  failure came from lint diagnostics, not from a broken invocation
passed: 6  failed: 0

$ bun fmt --check packages
All 7 files are formatted.
```

### What the CI logs prove was actually executed

Not inferred from a green tick — read out of the job logs:

| Check | CI evidence |
| --- | --- |
| Pinned Bun | `bun-version: 1.4.4`, log: `Using a cached version of Bun: 1.4.4+38afee6c8` |
| **Lint** | `$ oxlint --deny-warnings packages` → `Found 0 warnings and 0 errors. Finished in 5ms on 5 files with 82 rules` |
| **Lint gate self-test** | `passed: 6  failed: 0` — tree clean, scope non-empty, fixture rejected for both rules |
| **Formatting** | `$ bun fmt --check packages` → `All 7 files are formatted.` |
| Evidence suite | `47 pass / 0 fail`, `Ran 47 tests across 1 file` — **on both** ubuntu and macos-15 |
| Individual assertions ran | `(pass) redact > scrubs github, aws, slack and bearer tokens`, `(pass) redact > scrubs PEM private key blocks`, … |
| Fixtures on Linux | `created 5 fixtures`, then `OK read-only-explore / one-file-edit / failed-test / cancellation / rollback`, `all 5 fixture(s) at baseline` — **the platform risk did not materialise** |
| Dirty-tree gate | `# --check must FAIL on a dirty tree` executed |
| `failed-test` at baseline | `Ran 3 tests across 1 file` and the job asserts it fails for the documented reason |
| Cancellation & rollback | `scenario_check.sh`: `passed: 8 / failed: 0` on both platforms |
| License scope | `packages inventoried: 1641`, `decisions recorded: 48`, `open + release-blocking: (none)` |
| Secret scan | `OK: scanner detects a planted credential` + `OK: no credential patterns in the tree (no path exclusions)` |

### Two real CI defects found, which local validation had missed

**1. Secret scan failed on the initial push** (`45064795624`). The scanner flagged
`packages/bw-evidence/test/recorder.test.ts` lines 84–86, 97, 439. Those were the redaction
tests' own inputs — placeholder shapes (`ghp_` + 36 repeated chars, AWS's documented
`AKIA...EXAMPLE`, an all-`A` `github_pat_`) — not a credential leak. They were still
credential-shaped literals at rest.

My previous local "validation" of this job had only checked the scanner's *logic*, never run it
against the tree. **That is exactly what CI is for.**

Fix: a `credential(...)` helper assembles each fixture from parts at runtime. All five samples
were re-verified to still be caught by `redact()` with `[REDACTED]` emitted, so no assertion
was weakened. The workflow's pre-existing `--exclude='*.md'` and `--exclude='mock_provider.py'`
workarounds were also removed — they hid genuine blind spots and are no longer needed; the tree
now scans clean with **no path exclusions**.

**2. `upstream-compat` failed on both platforms** (`45065638555`), 28 tests each, all
`Ripgrep > ...`. Root cause from the log:

```
error: test attempted network request:
  GET https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/
      ripgrep-15.1.0-aarch64-apple-darwin.tar.gz
  — provide an explicit HttpClient or disable the fetch
```

The upstream filesystem suite shells out to `rg`; finding none on `PATH` it tries to download
15.1.0 mid-test, and the effect harness forbids network access. Invisible locally because
Homebrew's `rg` 15.1.0 is on this machine's `PATH`. Fix: install exactly the version pinned in
`packages/core/src/ripgrep/binary.ts` and verify its published SHA-256 before use.

**This is an environment requirement, not a Bashwink defect** — three prior local runs of the
same suite passed only because the binary happened to be present.


| Task | Revision | Command / test | Exit | Evidence | Supports acceptance? |
| --- | --- | --- | ---: | --- | --- |
| BW-001 | `c0ad18b40` | `git describe --tags` → `v2.3.2`; `bun install --frozen-lockfile` (1,583 pkgs, 75 s) | 0 | `UPSTREAM_BASELINE.md` §1–2 | Yes — SHA, license, toolchain, commands recorded |
| BW-002 | `c0ad18b40` | `bun run --cwd packages/core test` (macOS `/bin/bash` 3.2.57) | 1 | 7,553 pass / 39 skip / **3 fail** | Yes — failures diagnosed, not hidden |
| BW-002 | `c0ad18b40` | `bun run --cwd packages/core test` (**bash 5.3.20 first on `PATH`**) | **0** | **7,556 pass / 39 skip / 0 fail**, 98,776 `expect()` calls, 293 s | **Yes — the 3 failures were the interpreter, confirmed** |
| BW-002 | `c0ad18b40` | `bun run --cwd packages/cli test` | 0 | 408 pass / 9 skip / 0 fail | Yes |
| BW-002 | `c0ad18b40` | `bun run --cwd packages/sdk test` | 0 | 40 pass / 0 fail | Yes |
| BW-002 | local | `bun run --cwd packages/cli build --single --skip-install --skip-web-ui` | 0 | `dist/cli-darwin-arm64/bin/opencode`, 198 MB | Yes |
| BW-002 | local | `./opencode --version` | 0 | `opencode v0.0.0-detached-202611221836` | Yes |
| BW-002 | macOS `/bin/bash` 3.2.57 | `bash -c '[[ -n <(printf x > m) ]]; wait "$!"'` | 127 | `wait: pid … is not a child of this shell` | Yes — root cause of the 3 failures |
| BW-003 | local | 32 unit tests, `bun run test:evidence` | 0 | 32 pass / 0 fail | Yes |
| BW-003 | local | `tsc --noEmit -p packages/bw-evidence/tsconfig.json` | 0 | clean | Yes |
| BW-003 | live | agent turn vs. mock provider: tool call → `printf 'bw-mock-ok\n'` → evidence `before`+`after` `exit=0` | 0 | `evidence.jsonl` 2 entries, chain verified | **Yes — controlled tool call recorded** |
| BW-003 | live | failing variant: `printf 'bw-mock-fail\n'; exit 7` | 0 | evidence recorded `exit=7`, not a false success | Yes |
| BW-003 | live | deny probe: throw in `execute.before` | 0 | tool result `✗ … failed`; **no marker file created** | **Yes — deny seam proven** |
| BW-003 | live | ordering swap (deny registered before evidence) | 0 | evidence log **empty** after denial | Yes — found constraint 1: a throwing hook aborts the rest of the chain |
| BW-003 | live | removed `zz-deny` from config `plugins` array, directory still on disk | 0 | call still denied | Yes — found constraint 2: `plugin/` auto-loads every subdirectory, config list does not disable |
| BW-004 | — | ADR-001 written and signed | — | `ADR-001-FOUNDATION-AND-FORK.md` | Partial — **owner unassigned, no reviewer** |
| BW-005 | `c0ad18b40` | walk 1,641 `package.json` files, tally `license` | — | MIT 1,218 / Apache 142 / ISC 118 / LGPL 4 / none 37 | Partial — **notices file not generated** |
| BW-006 | — | `.github/workflows/verify.yml` written | — | **never executed** | **No** |
| BW-007 | local | `fixtures/create_fixtures.sh` | 0 | 5 fixtures, baselines in `BASELINES.txt` | Yes |
| BW-007 | local | `fixtures/reset.sh --check` on dirty tree | 1 | rejects: `HEAD is baseline but the working tree is dirty` | Yes — negative path |
| BW-007 | local | `fixtures/reset.sh` then `--check` | 0 | all 5 at baseline, tree clean | Yes |
| BW-007 | local | `cd fixtures/failed-test && bun test` at baseline | 1 | 2 pass / 1 fail (`trims leading and trailing dashes`) | Yes — reproduces the bug |
| BW-007 | local | same fixture, fixing **implementation** only | 0 | 3 pass / 0 fail | Yes — fix shape is correct |
| BW-007 | local | `cd fixtures/one-file-edit && bun test` at baseline | 1 | 2 pass / 1 fail (`subtracts in the documented order`) | Yes |
| BW-043 | `c0ad18b40` | `upstream_sync.py --offline` | 0 | verdict `BASELINE_ONLY` | Yes |
| BW-043 | `v2.3.1` | `upstream_sync.py --target v2.3.1` | 0 | `LOW_RISK`, 77 files, 1 commit | Yes |
| BW-043 | `v2.2.7` | `upstream_sync.py --target v2.2.7` | **1** | `REVIEW_REQUIRED`, 3,404 files, **18 breaking declarations** | Yes — detector is not vacuous |
| BW-090 | — | ADR-002…006 written | — | `ADR-002`…`ADR-006` | Yes |

## Known failures — resolved

The 3 shell-scan parity failures seen on the first run were **entirely the interpreter**, now
confirmed rather than inferred. Re-running the identical suite with bash 5.3.20 first on
`PATH`:

```
7556 pass   39 skip   0 fail   98776 expect() calls
Ran 7595 tests across 326 files. [293.35s]      EXIT=0
```

Baseline expectation for CI: **7,556 / 0 fail with bash ≥ 4.3**, and `3 fail` with macOS
`/bin/bash` 3.2.57. Both are recorded so a future run can be diagnosed instantly.

Root cause, reproduced outside the harness:

```
$ /bin/bash --noprofile --norc -c '[[ -n <(printf x > m) ]]; wait "$!"'
/bin/bash: wait: pid … is not a child of this shell      # exit 127
```

macOS `/bin/bash` is 3.2.57 (GPLv2; Apple does not ship bash 4+). The suite needs
`probe() case … esac` in command substitution and `wait "$!"` after a process substitution,
both bash-4 syntax. Upstream files were **not** patched (BW-002 says document first).

## Claims explicitly NOT made

- No Windows run of any command. Linux and macOS are covered by CI.
- No real-model agent run; every agent turn used the local mock provider (ADR-006).
- `ctx.event.subscribe` and `permission.hook("evaluate")` are source-verified only, never
  exercised.
- Upstream files were not patched (BW-002).
- Evidence health is proven at plugin start-up, not continuously through a session.
- The TaskContract gates task start; it does not yet police individual file or shell actions
  (BW-059), and there is no interactive edit/assumption-ledger UX (BW-056).
- No claim is made that a green CI run on this repository proves the same on an untested
  platform or a different runtime version.


## VM provider relay — synthetic milestone

On macOS arm64 with pinned Bun 1.4.4 and OpenCode 2.3.2, the local package suite
passed 427 tests with exit 0. Relay and guest negative tests passed with synthetic
credentials. The disposable Apple VM fixture used the private virtual socket and a
host-only synthetic upstream. The pinned OpenCode TUI completed a multi-file coding
task, approved guest tests, resumed the session, rejected foreign or corrupt state,
reviewed and applied changes, and ran protected tests. Guest state, PTY capture and
host usage records did not contain the synthetic credential. This test uses the
test-only launcher to inject a synthetic upstream into the same VM runner.

The relay tests cover invalid capabilities, route and model denial, private DNS
addresses, redirect refusal, request limits, hosted-tool denial and a credential
reflected in a successful JSON response. They do not establish comprehensive
credential non-disclosure against a malicious upstream. A real paid provider, live
stream interruption, rate-limit and authentication failures, and an installed live
coding session are BLOCKED or NOT_RUN. Authentication and rate-limit errors have synthetic status tests. Other upstream errors
currently report a generic failure. Request limits are not a monetary ceiling. BW-031 and BW-032 remain partial.

Reproduce the synthetic VM fixture with pinned input directories using
`PYTHONPATH=<PySquashfsImage-dir> python3 fixtures/native-offline/vm-boundary.py
<alpine-inputs> --opencode-inputs <runtime-inputs> --project-cli --relay-inputs
<relay-inputs>`. The host requires Virtualization.framework entitlement and a
disposable workspace. Existing workspace, baseline refresh and early-journal
limitations remain open. No CI run was requested for this milestone.


## Milestone 4 baseline — live-provider gate

On 24 November 2026, the clean `codex/v0.1.0-alpha-preparation` checkout at
`f7921bd548ce4ed39fb151ac3d35616cf33cb11a` ran `bun test packages` using Bun
1.4.4 on Darwin arm64. The command exited 0 with 428 passed and 0 failed across
27 files. This result is the package suite, not a live-provider or VM acceptance run.
No commonly named supported provider credential was present in this agent process.
No authorized live account was identified. Live-provider qualification is BLOCKED.
The remaining milestone checks were not run at this gate.


## CommandCode live VM coding — 24 November 2026

On macOS 27.0.1 build 26A434 arm64, the installed VM fixture built from
`90687438` with the `f7921bd` relay selected `commandcode/claude-sonnet-5` through
the host relay. The live provider streamed responses and invoked file tools. A
disposable PTY session approved edits to `one.ts` and `two.ts` and the guest
`bun test accept.test.ts` command. Evidence records show exit 0 and one passing test.
`--continue` restored the same session and extended its evidence chain. The reviewed
two-file diff was approved and applied. The independent host test and fresh VM
protected-test verification exited 0. The host canary and original test hash stayed
unchanged. The inspected guest state and host usage records did not contain the raw
provider key. Fixture artifacts are under `/private/tmp/bw-live-commandcode-nm8j4_ft`.
The process-list check found no remaining fixture VM owner. Detached-writer behavior
was not independently exercised in this live run.

The coding run used five relay requests and the resume used one. These are observations
for this small task, not a budget recommendation. The prior usage summary omitted
Anthropic cache-read and cache-write input counters. A focused regression covers the
new separate counters. The final local complete package run reported 434 passed and 0 failed, exit 0. Live tests used the previously built installed fixture,
so the new usage display is covered by regression tests rather than that installed run.
Synthetic relay tests cover oversized requests and responses, client disconnect,
timeout, interrupted streams, malformed response and upstream 5xx. Real-provider model switching and
cancellation, complete network and replay negatives, and full BW-032 qualification
remain unverified. External alpha remains blocked.

The updated local installation subsequently completed a live read-only CommandCode
task with the guest file tool and a finished model response. It reported 2 requests,
17,454 Anthropic cache-read input tokens and 194 cache-write input tokens. Its full
coding workflow was not rerun after the reporting change. One earlier live coding
attempt hit the 100-second guest execution deadline while the automation was waiting
for an edit approval. The stage was retained and the host checkout stayed unchanged.


## Milestone 5 stabilization observations

Host macOS 27.0.1 build 26A434 arm64, Bun 1.4.4 and pinned OpenCode 2.3.2.
The installed synthetic VM fixture used a disposable Git project. It tested
SIGKILL after journaling and before stage identity, preserved the unidentified
directory and host files, repeated recovery, resumed after the first reviewed batch,
and omitted the already-applied file from the next review. The fixture also passed
partial apply recovery and protected tests. Changes are applied one file at a time.
The legacy receipt-chain and host-conflict cases have focused local tests.

A live CommandCode session used `claude-sonnet-5`, then selected `gpt-6.1-sol`
through the TUI picker. The saved session recorded the model identities and GPT
recalled the earlier conversation. Changing the host default alone did not change
the resumed session model. In live cancellation controls Ctrl+C closed the observed
provider TCP connection. One Escape did not close the original connection within
eight seconds. Two Escapes closed it. A separately approved `sleep 30` shell was
interrupted with Ctrl+C. After waiting beyond 30 seconds in the running guest, the
marker was absent and saved session data recorded `Command cancelled`. The shell's
individual guest process was not independently observed. A synthetic invalid key
returned 401 through the live provider relay. Synthetic controls cover 429, 5xx,
size limits, timeout, disconnect, malformed responses and capability replay.

On this same lab host, four separate VM session resumes reached their TUI in 5.16,
4.87, 4.74 and 4.37 seconds, measured from launch. Two point-in-time VM-owner samples
were 8,480 and 8,848 KiB RSS and 0.0% CPU. These are owner-process samples, not total
VM memory, CPU peaks, or clean-host measurements. The lab installation occupied
396,464 KiB by `du -sk`. A fresh local development build with warm dependencies took
0.20 seconds and had no VM asset manifest. Its plain TUI selected local host execution.
First installation on a clean machine, first token latency, peak memory, export latency,
and warm-host versus cold-host comparisons were not measured.

The single-Escape control and a 100-second guest deadline remain usability limits.
No external alpha or public release is approved. The exact release gate still fails.

The source commit for the tested export and baseline implementation is `2eef59c`.
The final synthetic installed-VM fixture exited 0 and exercised both the journaled
and stage-created SIGKILL points, repeated recovery, session resume after an applied
batch and review of the remaining changes. The independent boundary fixture exited 0
for forced stop, VM-owner SIGKILL, reopen, launcher SIGKILL, reopen, interrupt and
timeout, while checking the detached guest writer and host controls.

At documentation commit `c126e0d`, `bun test packages` exited 0 with 448 passed
and 0 failed. Typecheck, Oxlint, formatting, lint negative controls, documentation
manifest and task-register checks exited 0. Hosted CI was not run.
