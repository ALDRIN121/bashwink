# BW-032 qualification results

**Status** PARTIAL. Release qualification is blocked. The installed macOS probe is a
pre-qualification result. Every release-required row has an explicit non-PASS state
in the [machine-readable matrix](NATIVE_SANDBOX_QUALIFICATION.json).

| Evidence tier | Result |
| --- | --- |
| Bun 1.4.4 unit/integration suite | PASS, 404 tests, zero failures, exit 0 |
| Typecheck, Oxlint, formatting and lint controls | PASS, exit 0 each |
| Native release validator tests | PASS, four tests, exit 0 |
| Real OpenCode runtime regressions in existing local mode | PASS, readiness 11 checks, tool lifecycle 19, contract 14, recovery 10. Each fixture exited 0 |
| Installed local TUI regression in a real PTY | PASS. The startup prompt rendered. SIGTERM returned 130, removed the readiness lease and reaped the owned server. No coding turn was submitted. |
| Installed macOS arm64 native diagnostic | PASS, six controls, exit 0 on macOS 27.0.1 build 26A434 with the system helper. Docker-family tooling was unused. Docker was present on the machine, so the clean-host criterion remains blocked |
| Real native PTY coding | PASS at file-only fixture tier. The installed client submitted keyboard input, completed an in-process file write against the local mock, and recorded a durable session. Shell-capable startup is disabled. |
| Native recovery and reviewed export | PASS at file-only fixture tier. Both reopen flags preserved the session and evidence after supervised interruption. The single-file preview and apply passed with host hash checks. General workspace recovery and export remain unqualified. |
| Native OS denial | PASS at fixture tier. The current file-only profile denied fork and spawn with EPERM. The historical shell profile denied a protected sibling write and unrelated TCP loopback access. ScopeFence separately refused a forbidden file-tool write. |
| Native lifecycle | PASS at file-only fixture tier. Normal exit and Ctrl+C returned 0, owned server failure returned 3, and timeout returned 124. Both direct children were gone and the lease was removed after each supervised exit. Wrong executable startup returned 3 with no model request. |
| File-only abrupt stage retirement | PASS at fixture tier. After launcher SIGKILL an actual stopped OpenCode writer held the inherited lock and blocked reopen, recovery and export. An independent lock acquisition after server exit allowed retirement and intact reopen. Concurrent retirement and retry were safe. Interrupted export remained closed with its host file unchanged. |
| Detached descendants | FAIL under the historical shell-capable profile. A disowned process with its own process group and session survived both owned processes and could still write into staging. The harness ended the synthetic writer using its fixture pipe. The current implementation refuses that profile at startup. |
| File-only interrupted export reconciliation | PASS at fixture tier. Verified pre-exchange abort and three post-exchange fault points. Original directory and exact file identities were required. Receipt, target inode and evidence chain stayed unchanged on retry. |
| Detached guest writer | PASS at Virtualization.framework lab tier. A new-session guest worker closed its inherited descriptor and wrote to the private stage disk. Whole-VM stop and VM-owner SIGKILL stopped disk writes. The fixture refused concurrent open and reopened the disk after owner death. Packaged shell-capable OpenCode remains unqualified. |
| OpenCode guest PTY and stage handoff | PASS at Virtualization.framework lab tier. The sandboxed real runtime streamed an offline prompt, edited a file, paused for shell approval and ran the approved command. The host independently inspected two expected files after teardown. Project export, VM session recovery and a live provider remain unqualified. |
| Separate launcher death, interrupt, and timeout | PASS at Virtualization.framework lab tier. A host-only pipe caused VM stop on launcher SIGKILL. SIGINT and the owner timer returned 130 and 124. The independent disk observer saw no surviving writes and reopened the marker after launcher death. |
| Real provider relay and live turn | BLOCKED. Provider relay and general native admission are absent |
| Detached-workload cancellation and resource enforcement | NOT_RUN. The probe supervises direct diagnostic invocations |
| Ubuntu x86-64 with distro AppArmor and Bubblewrap | BLOCKED. No disposable Ubuntu host was available for execution in this cycle |
| Optional Docker | NOT_RUN. Outside this milestone |
| Hosted CI on this revision | NOT_RUN. Held to preserve Actions quota |

The earlier Ubuntu job failed after the SQLite bootstrap issue was addressed and before
runtime readiness completed. That run had no native backend, so it cannot identify
Bubblewrap, seccomp or AppArmor as its cause. The historical job lacks the more detailed
substep diagnostic available in the current tree. It is an executed failure. Its downstream
tool lifecycle step was skipped.
[Existing Ubuntu job](https://github.com/ALDRIN121/bashwink/actions/runs/45266792026/job/138015719611).

Run the current release gate with `./scripts/verify_native_release.py`. It requires each
mandatory control on macOS arm64 and Ubuntu x86-64, with evidence tied to the candidate
Git commit and a consistent release-policy bundle digest per target. Probe observations
cannot replace release rows. Missing or duplicate results, unsupported advertised targets,
stale revisions, absent evidence and any non-PASS release row cause exit 1. The validator
checks the completeness and references of reviewed evidence, which still requires trusted
collection and review.

**Release decision** Personal or supervised internal use is limited to the existing
permission-controlled local baseline and its documented host-access exposure. External
developer alpha and public release are blocked.

[Executed evidence](TEST_EVIDENCE.md) · [Full qualification plan](BW-032_PLATFORM_QUALIFICATION.md).


## Live CommandCode observation

A disposable macOS Apple Silicon VM fixture completed live model-driven edits, guest
tests, session resume, reviewed host apply and independent protected tests. Inspected
saved guest state did not contain the provider key. This is a single lab-host result,
not complete platform qualification. Model switching, clean installation, remaining
negative controls and the exact-release CI run remain open. See [test evidence](TEST_EVIDENCE.md).
