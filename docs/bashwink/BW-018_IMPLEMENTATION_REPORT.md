# BW-018 permission and execution controls

Local acceptance is evidenced against pinned OpenCode v2.3.2
(`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`). Updated hosted coverage is tracked in
[TEST_EVIDENCE.md](TEST_EVIDENCE.md).

OpenCode settles plugin activation even if a plugin fails. Bashwink originally let the
prompt run and reconciled its boot marker only after exit. A verified boot entry on disk
could describe a different run or server and could never retract a tool side effect.

The backend now starts its own loopback server with an authenticated stdin lease. It
requires active plugin inventory for the staged source in the launched workspace and an
exclusive acknowledgment with a new nonce, run ID, workspace and the spawned server PID.
The plugin publishes that acknowledgment after registration of the policy, shell,
permission and evidence hooks. The CLI or TUI first starts after both proofs. Unexpected
unload terminates the leased server, and loss of that server terminates the owned client.
[ADR-012](ADR-012-PRIVATE-RUNTIME-READINESS.md).

| Execution path | Current behavior |
| --- | --- |
| Direct file tools | Check known read, edit, write, search and patch shapes before dispatch. Resolve physical paths, including home-relative paths and patch move destinations. Refuse unreadable paths, malformed calls, unknown tools and modeled writes to excluded paths. |
| Model shell | Ask on risky native shell and edit evaluations. Preserve native denies. An explicit headless `--auto` can approve a request that policy permits. Interactive approvals are requested again for later risky calls, including after a native remembered allowance. |
| Restricted contract | Draft and unapproved scopes are read-only. A narrowed path scope, explicit forbidden paths, a file count limit or command constraints disable the general shell. Run checks requiring shell access separately under operator control. Shells allowed in trusted, unrestricted local runs inherit host access. |
| Direct TUI shell | Use OpenCode's lower shell hook to clear the command and replace the executable with a non-executable path when policy refuses the invocation. This covers the direct TUI route once the policy plugin is loaded. Typed tool denial is unavailable at this hook. |
| Tool plugins and background work | Refuse unknown model tool dispatch, including exposed automation, delegation and executable tool aliases outside the allowlist. Prevent untrusted project configuration discovery in the normal runner. Trusted global plugins, trusted project startup and host processes remain part of the local trust boundary. |
| Managed OpenCode services | Bashwink owns the server and gives the client only a separate, authenticated local admission endpoint. The endpoint checks workspace and saved-session location. Direct server and service routes, workspace mutation, plugin reload, raw terminal creation and session-permission changes are refused. |
| Startup and evidence | Refuse scope setup failures and an unresolvable plugin. Missing, invalid, late or failed readiness blocks client launch. A saved-automation database is refused before server startup. The former evidence-off switch is refused. |

Code paths are [execution-policy.ts](../../packages/bw-cli/src/execution-policy.ts),
[scope.ts](../../packages/bw-evidence/src/scope.ts), and
[index.ts](../../packages/bw-evidence/src/index.ts). See [test evidence](TEST_EVIDENCE.md)
for the positive controls and refusals actually observed.

## Boundaries and remaining work

This local mode treats same-user host processes and installed host or trusted project
plugins as part of its trust boundary. A separate application mutating the same OpenCode
database concurrently is outside the admitted workload. The untrusted TUI refuses project
TUI configuration or discoverable TUI plugin directories. Workspace-changing requests,
plugin reload, raw terminal APIs and stored automations are outside the accepted surface
for this pinned integration. Native headless forms that require an unscoped local session
are unavailable through the private connection. Readiness applies to tool dispatch in the
admitted run.
Host filesystem and network containment, secret isolation, and complete descendant cleanup
remain BW-031 work. [Sandbox plan](BW-031_IMPLEMENTATION_PLAN.md).
