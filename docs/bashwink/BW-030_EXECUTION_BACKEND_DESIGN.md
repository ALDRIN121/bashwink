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

The local backend has direct host access. It reaps the direct client and server during
supervised shutdown. Detached descendants, abrupt wrapper death and host plugins remain
outside the verified lifecycle. Deadline evidence covers elapsed process time.
[BW-018 report](BW-018_IMPLEMENTATION_REPORT.md).

## Backend boundary for BW-031

Keep the existing lifecycle and capability interfaces. Native execution will be preferred
only after qualification. Advertise the verified workspace mode, filesystem reach,
network policy and cleanup scope independently. Backend selection and startup refusal
are visible to the caller and recorded with the evidence.

- Native prepare validates the host and compiles a policy and workspace identity.
  Native execute owns the pinned server and client, then waits for policy readiness
  bound to that workload before admitting a prompt. A PID namespace can change the
  PID observed by the plugin. Preserve process identity through a trusted launcher/lease
  binding across namespace views.
- Native sync validates staged changes and persistence data before a reviewed host import.
  Cancel, timeout and dispose report whether the workload actually exited and cleanup
  completed. Supervise guest terminal I/O through a private PTY.
- A native precondition, readiness or provider failure ends that run. An explicit,
  permission-controlled local restart requires acknowledgment of host access and
  risky-operation approvals. Docker is an optional explicit selection.

[BW-031 feasibility](BW-031-SANDBOX-PROPOSAL.md) · [Implementation sequence](BW-031_IMPLEMENTATION_PLAN.md)
· [Platform qualification](BW-032_PLATFORM_QUALIFICATION.md).
