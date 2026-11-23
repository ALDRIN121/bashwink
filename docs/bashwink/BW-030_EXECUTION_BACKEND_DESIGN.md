# BW-030 execution backend foundation

The local backend is wired through the normal CLI. The requested foundation work leaves the
Phase 2 and Phase 3 release gates open. Hosted qualification is tracked with the executed
checks in [TEST_EVIDENCE.md](TEST_EVIDENCE.md).

`BASHWINK_BACKEND=local` selects direct host execution and is the compatibility default.
`bashwink backend` prints the selected mode, workspace mode, isolation capabilities and
cancellation scope. Asking for `docker` or an unknown backend returns usage failure before
the runtime is started. The CLI chooses and validates the backend, compiles policy, stages
the plugin and writes a run expectation before handing an argv vector to the backend.
[CLI entry](../../packages/bw-cli/src/main.ts) · [Backend implementation](../../packages/bw-cli/src/execution-backend.ts).

| Lifecycle | Current contract |
| --- | --- |
| Prepare | Synchronous local validation, with no tool dispatch or external workload creation. Validate the executable and workspace. |
| Execute | Start an owned leased server, wait for policy readiness, and attach only the admitted CLI/TUI with inherited terminal I/O. Local mode uses Bun subprocesses. A future backend puts engine initialization inside its cancellable execution lifecycle. |
| Cancel | Local mode sends TERM to the client, escalates to KILL after 1.5 seconds if needed, reaps it, then closes and reaps the owned server. Cancellation during readiness prevents client launch. Wrapper INT and TERM request cancellation. |
| Timeout | Optional `BASHWINK_TIMEOUT_MS` applies to execution. Expiry returns 124 after cancellation. Cleanup time follows that deadline and is reported separately from an ordinary exit. |
| Sync and dispose | Local workspace changes are applied in place, so sync is a no-op. Disposal runs after exit, cancellation or startup failure after preparation. A future staged adapter must implement bounded cleanup and controlled artifact import. |
| Report | Ordinary runtime exit status is preserved. The outcome and backend capabilities are persisted in the run record. A successful runtime exit without expected boot evidence still returns the evidence failure. |

Docker is the planned first isolated adapter. The local implementation claims neither
workspace, network nor process isolation. It reaps the direct client and server it starts during supervised shutdown. Detached descendants, an abrupt wrapper kill and host plugins are outside the verified local lifecycle. The deadline is a process deadline, not a spend,
full cleanup or whole-system quota. [BW-018 report](BW-018_IMPLEMENTATION_REPORT.md).

## BW-031 implementation sequence

1. Confirm hosted BW-018 and BW-030 evidence on both supported platforms and use the exact integrated baseline.
2. Implement a Docker adapter with digest-pinned local samples and zero tool egress. Require
   the actual runtime and child services to boot in the guest. Fail closed if the engine,
   prepared policy, runtime identity or required limits cannot be verified.
3. Close run-owned service, descendant, and artifact lifecycles before importing any output.
   Keep host credentials, home, SSH sockets, Docker sockets and host evidence outside the guest.
4. Exercise the adversarial matrix on Linux and a VM-capable Mac before qualifying an isolated
   case. Add narrowly mediated live inference only after that boundary is demonstrated.
   [Reviewed sandbox plan](BW-031_IMPLEMENTATION_PLAN.md).
