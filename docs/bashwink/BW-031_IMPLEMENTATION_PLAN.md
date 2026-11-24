# BW-031 native sandbox implementation plan

**Status** Implementation in progress. The installed offline Seatbelt probe is verified.
Native coding admission awaits integration and qualification. The existing Phase 3 and Phase 4
dependencies and external-alpha hold still apply.
[Architecture and trade-offs](BW-031-SANDBOX-PROPOSAL.md) · [BW-032 platform qualification](BW-032_PLATFORM_QUALIFICATION.md).

The current macOS shell decision keeps Seatbelt file-only. A separate
Virtualization.framework prototype demonstrated whole-guest lifetime in a lab.
The next shell milestone places the pinned OpenCode runtime in that guest and
qualifies the installed PTY, launcher-to-owner lifecycle and stage retirement.
The VM remains an explicit candidate backend with no user-managed runtime requirement.
[Shell containment decision](BW-031_IMPLEMENTATION_REPORT.md#macos-shell-containment-decision).

## Installation and launch contract

| Selection | Startup and failure behavior |
| --- | --- |
| Default `bashwink` | Try the native adapter on a qualified host. Show the effective filesystem, network and lifecycle capabilities. Validate the helper, runtime and policy before a prompt is admitted. No container runtime discovery or installation is necessary. |
| Native required | Refuse missing or unsupported helpers, failed self-probes, unavailable strict limits, mismatched readiness, or unavailable selected provider transport. Print the specific diagnostic. Failed admission exits nonzero before transmitting a user prompt or dispatching a tool. |
| Permission-controlled local | A distinct interactive choice for trusted workspaces. Before the run, show “Local with approvals · unrestricted host access” and require a recorded explicit acknowledgment bound to workspace, mode and run. Require fresh approval for risky operations. Keep hard denials and active contract scope. Refuse unattended runs that require isolation or local approval. Failed native runs terminate before offering a separate restart in this mode. |
| Docker | Explicit opt-in only, with its own preflight, engine identity and qualification. Missing Docker fails that explicit request alone. |

A packaged macOS launch uses the system helper when it qualifies. A Linux package
may express a normal OS package dependency on a supported unprivileged Bubblewrap
build. A standalone Linux distribution can discover a qualified helper and show an
actionable dependency or AppArmor diagnostic. Neither install path prompts for a
container daemon. Do not fetch helpers, runtimes or plugins from writable workspace
paths or during policy activation. Existing local-mode behavior is described in the
[BW-030 design](BW-030_EXECUTION_BACKEND_DESIGN.md). This section specifies future behavior.

## Build order

1. **Close or resolve dependencies.** Diagnose the remaining Ubuntu readiness failure
   with the pinned binaries in a disposable Linux environment. Qualify the existing
   BW-018/BW-030 ownership, cancellation and readiness boundary. Keep hosted Actions
   paused unless the maintainer authorizes their use.
2. **Prototype native primitives independently.** Obtain passing file and child
   canaries under default-deny Seatbelt and under the distro’s non-setuid Bubblewrap.
   Verify process/terminal isolation on each supported runtime and host. Make namespace,
   syscall, network and cleanup failures actionable. Include rollback and supervisor
   death. Measure startup with a cold and a warm run. No latency promise is set yet.
3. **Attach the pinned runtime offline.** Compile a host-owned policy snapshot and
   stage approved inputs. Start both real OpenCode processes under identical native
   policy, including the private readiness channel. Make staged editing and the separate host preview/apply step visible in the TUI. Use fixture-only synthetic
   credentials and a loopback mock. Exercise a real TUI turn, in-process edit,
   approved shell child, permissions, safe preview, cancellation and recovery. Treat
   detached cleanup and provider relay as independent release blockers.
4. **Enforce host boundaries.** Give the workload only minimal mounts or Seatbelt
   paths, a synthetic home, tested terminal descriptors, per-run state and a private
   staging area. Scope inputs with a reviewed inventory and reject special objects,
   links crossing authorized boundaries and ambiguous aliases. Preserve readable
   dependencies only as approved. Stop workload writers before collecting bounded
   output. Verify identities and base hashes at import, detect conflicts, and apply
   only approved paths after a preview. Treat guest sessions and evidence as untrusted
   input. Record trusted host lifecycle observations separately.
5. **Qualify network and identity.** First deny all guest external traffic. Then add an
   explicit provider-only mode via a private channel, with host-side auth and quotas,
   protocol and destination validation and no arbitrary forwarding. Scope credentials
   to an authorized account/model. Test streaming, cancellation, OAuth or key flow as
   applicable, and session resume. Qualify each promised provider separately. Keep
   custom endpoints, remote MCP and direct internet unavailable until their boundary
   is designed and verified.
6. **Release qualification.** Execute BW-032 on clean supported systems with no
   Docker/Podman or daemon, using the actual packaged entry point and binary hashes.
   Demonstrate filesystem and network restrictions, session persistence, exit
   propagation and cleanup. Measure and verify required resource limits or explicitly
   block workloads that request unavailable limits. Record the supported combinations
   and refuse all others. Qualify optional Docker independently before advertising it.

## Adapter seams

Keep the existing BW-030 prepare, execute, sync, cancel and dispose lifecycle. Native
prepare returns a policy identity, verified platform and required capabilities. Native
execute owns the real server/client lifetime and readiness; the host wrapper must never
dispatch tool work itself. Sync is a staged collection and validation boundary.
Cancellation terminates and reaps the workload where demonstrated. Failures record the
stage and active mode and propagate nonzero exit before partial output can be interpreted
as success. Browser login, relay and host preview remain limited host services. Keep
OpenCode inference and tool orchestration upstream.

Run the first two steps before adding a native mode to routine use. External alpha stays
blocked until the installed Docker-free workflow and each advertised security capability
have supporting evidence. [Alpha checklist](ALPHA_RELEASE_CHECKLIST.md).
