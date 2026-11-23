# BW-031 Docker-free execution feasibility

**Decision date** 2026-11-24. **Status** Approved direction with a tested offline macOS probe milestone. BW-031
and BW-032 remain In progress. The previously reviewed Docker design is retained in Git history at `989cc82`.
The integration target is OpenCode v2.3.2 at
`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`, with the existing BW-018/BW-030 foundation.

## Decision

Make native isolation the preferred path for `cd /path/to/project && bashwink`. Use
a fresh workload containing the **OpenCode server, CLI/TUI, and descendants**. Keep
policy compilation, the physical terminal boundary, credentials, evidence receipts
and export on the host. Start with offline runtime qualification, then qualify a
narrow provider transport. Keep Docker behind explicit selection as an optional
adapter. Require separate approval before entering permission-controlled local mode.

| Option | Filesystem and process boundary | Trade-offs and fit |
| --- | --- | --- |
| Native macOS | Seatbelt policy over both OpenCode processes and their children. Dedicated scratch and staged workspace. | No helper install for the first spike. Apple’s launcher/API is deprecated. Mach services, dynamic libraries, TTY behavior, link handling, network confinement and descendant cleanup need qualification on each supported OS. There is no Linux-style PID namespace. |
| Native Linux | Bubblewrap constructs a minimal mount view and private user, mount, PID, IPC, UTS and network namespaces. A tested seccomp layer reduces syscall exposure. | No daemon or VM. Availability depends on the kernel, distro/AppArmor policy, architecture, filesystem and helper path. Private PID namespace gives a candidate workload-wide cleanup boundary. A namespace is no guarantee of CPU/memory quotas. |
| Optional Docker | The same workload and export contract implemented by a configured engine, with independently verified mount, network and process policies. | Adds engine/image supply-chain, daemon or VM, startup and cleanup costs. Rootless operation and resource limits are configuration-dependent. Useful for explicit engine-backed workflows after independent qualification. |
| Permission-controlled local | Direct host execution using BW-018 and BW-059. | Existing compatibility path. Requires explicit acknowledgment and risky-operation approval. Host filesystem, processes, network and credentials remain reachable by permitted programs. |

## What upstream products demonstrate

| Product and source availability | Observed pattern and maturity | Transfer to Bashwink |
| --- | --- | --- |
| OpenAI Codex CLI, Apache-2.0 source | Codex uses Seatbelt on macOS and Bubblewrap plus seccomp on Linux. Its source distinguishes command execution, sandbox configuration, network policy and host tool/integration surfaces. It documents user namespace failures, including Ubuntu configurations. | Reuse the separation of policy and approval and the Linux startup/cleanup approach. Qualify Bashwink’s whole-runtime boundary separately. [Security architecture](https://openai.com/index/inside-the-codex-sandbox/) · [Linux source](https://github.com/openai/codex/tree/598083ae586954aa11edc8e8224a33ea878445ed/codex-rs/linux-sandbox) · [License](https://github.com/openai/codex/blob/main/LICENSE) |
| Claude Code and Anthropic Sandbox Runtime | Claude documents OS-level shell confinement and configurable startup refusal. Its separate Apache-2.0 Sandbox Runtime uses Seatbelt or Bubblewrap and contains platform-specific network proxy/bridge code. The published runtime is inspectable independently of the complete Claude Code product. | Evaluate policy and proxy designs. Treat defaults, dependencies and release support of any adopted revision as separate decisions. Wrapping the shell alone leaves OpenCode’s in-process file and plugin operations outside that boundary. [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing) · [Runtime source and license](https://github.com/anthropics/sandbox-runtime/tree/0bbebed0aa9a8e628dc4df8bc30293550a1988eb) · [Claude product terms](https://github.com/anthropics/claude-code/blob/main/LICENSE.md) |
| GitHub Copilot CLI and Microsoft MXC | GitHub announced general availability of local sandboxing on 2026-10-07. Microsoft documents Seatbelt on macOS and Bubblewrap on Linux. Copilot’s built-in file tools are evaluated by its harness outside the child-process OS sandbox. MXC is MIT; Copilot CLI has separate proprietary terms. | Evaluate MXC as an optional implementation dependency after compatibility and lifecycle trials. Its adoption by Copilot is useful production evidence for the primitives. Bashwink requires a separate boundary test for every OpenCode execution path. [GA announcement](https://github.blog/changelog/2026-10-07-local-sandboxing-for-github-copilot-now-generally-available/) · [Copilot architecture](https://commandline.microsoft.com/local-models-sandboxed-tools-github-windows/) · [Pinned MXC implementation](https://github.com/microsoft/mxc/blob/5c331f2f6c3b09fee8cb9f2e5c68df4596455957/src/mxc-sdk/src/backends/bubblewrap/common/bwrap_runner.rs) · [MXC license](https://github.com/microsoft/mxc/blob/main/LICENSE.md) · [Copilot CLI license](https://github.com/github/copilot-cli/blob/main/LICENSE.md) |
| Gemini CLI, Apache-2.0 source | Gemini offers whole-process Seatbelt/container launch and a separate opt-in native tool sandbox. Its v0.70.0 tool factory selects Linux Bubblewrap/seccomp or macOS Seatbelt managers. Whole-CLI profiles vary in read and network access. | Whole-CLI wrapping is a relevant compatibility precedent. A permissive profile or a host workspace mount does not meet Bashwink’s credential and import requirements. [Sandbox methods](https://geminicli.com/docs/cli/sandbox/) · [Launcher source](https://github.com/google-gemini/gemini-cli/blob/v0.70.0/packages/cli/src/utils/sandbox.ts) · [Tagged tool factory](https://raw.githubusercontent.com/google-gemini/gemini-cli/v0.70.0/packages/core/src/services/sandboxManagerFactory.ts) · [License](https://github.com/google-gemini/gemini-cli/blob/main/LICENSE) |
| OpenCode, MIT source | OpenCode documents permissions, hard-deny policies, plugins and local/remote MCP. The pinned implementation has in-process file tools, a shell hook, a managed-service connection path and a leased standalone server path. | Retain the pinned runtime and native policy hooks for defense in depth. Keep tool dispatch and model orchestration upstream. Host service discovery, unapproved integrations and host-backed invocation paths remain excluded from native admission. [Policies](https://opencode.ai/docs/policies/) · [Security scope](https://github.com/anomalyco/opencode/security) · [MCP](https://opencode.ai/docs/mcp-servers) · [Pinned source and license](https://github.com/anomalyco/opencode/tree/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1) |

This review uses public source and documentation as design evidence. A license on a
helper does not cover the consuming product. Any shared code must be selected at an
exact revision and audited with its patches, transitive dependencies and distribution
terms. Product maturity and kernel enforcement in a different application do not
qualify Bashwink’s security or compatibility.

## macOS recommendation

Use the OS-provided `/usr/bin/sandbox-exec` for an initial Seatbelt spike with a
default-deny, generated policy. Grant explicit read access to the pinned executable,
loader, tested system/toolchain paths and staged inputs. Limit writes to private
scratch and the authorized workspace staging area. Deny general network access,
Apple Events, LaunchServices, unneeded Mach/XPC services, sensitive home paths, host sockets and privileged launch
paths. Admit only required TTY and private transport capabilities. Keep shell and
children in the same profile. Resolve capabilities with positive and negative
functional probes, including child coverage and cleanup. Treat TCC and App Sandbox
entitlements as separate mechanisms.

Seatbelt enforcement is a kernel mechanism. The command-line launcher is deprecated
in the shipped manual, and programmatic `sandbox_init` is also deprecated. A helper
that invokes it directly still carries that compatibility risk. Apple’s presence of
a binary or API does not establish future availability or the stability of profile
rules. Test on every advertised macOS release and architecture with signed packaged
binaries. Mark a host unsupported if the profile, provider transport or lifecycle
cannot be qualified. In particular, a process group proves only group cleanup.
Cancellation, timeout and launcher death must cover detached descendants separately
before claiming workload cleanup on macOS.
[MXC Seatbelt implementation notes](https://github.com/microsoft/mxc/blob/main/docs/backends/seatbelt/seatbelt-backend.md)
· [Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)
· [Apple helper entitlements](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app).

## Linux recommendation and packaging

Select an unprivileged, security-patched Bubblewrap build at a trusted absolute path.
Prefer a distribution-managed dependency and its approved AppArmor profile for the
first packages. Never resolve helpers through the project PATH. Start with an
explicit minimal filesystem and fresh privately mounted scratch, a private PID
namespace with a reaper, no elevated caps, no-new-privileges and a private network
namespace. Add a narrowly scoped seccomp policy for each supported ABI after
testing normal runtime behavior. Seccomp reduces syscall surface; filesystem access
is enforced by the mount view and its writable paths. Avoid setuid helpers and
system-wide changes to namespace restrictions. Check both the running kernel policy
and the selected helper by launching a disposable workload. Set and verify wall time
and any advertised cgroup limits independently.

Bubblewrap v0.12 dropped setuid support and switched the project license to
LGPL-2.1-or-later. The v0.13.1 upstream release at `362936aea0d5c6e70f7af75d2d44b5a914cb4ba2` is a review candidate, subject to
distro security patches and pinned package provenance. A generic bundled executable
may still fail AppArmor policy even when the distro package works. If bundling is
needed, ship separate signed builds for tested architectures and ABIs, with exact
source and patches, build instructions, notices, SBOM and tested runtime dependencies.
Review the applicable redistribution obligations for each artifact and helper.
Bubblewrap needs libcap and can link libselinux. Review platform libc and dependency packaging. Build-time seccomp filter generation can avoid a runtime libseccomp dependency. Review it independently if linked or shipped. The initial design
requires no `socat`, `slirp4netns`, Docker socket or privileged daemon. A later network
bridge changes the required dependency and threat review.
[Bubblewrap v0.12](https://github.com/containers/bubblewrap/releases/tag/v0.12.0)
· [Bubblewrap v0.13.1](https://github.com/containers/bubblewrap/releases/tag/v0.13.1) · [Native build dependencies](https://github.com/containers/bubblewrap/blob/v0.13.1/meson.build)
· [Ubuntu AppArmor restrictions](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/)
· [Linux seccomp documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html).

## Integration and security boundary

| Surface | Required disposition |
| --- | --- |
| Built-in file tools, tool hooks and shell | Contain the whole runtime. Preserve BW-018 approvals and ScopeFence. A recognized file write also hits the operating system boundary. Path authorization must survive actual filesystem access and descendants. |
| TUI and client plugins | Launch the TUI in the same policy boundary, with host-owned terminal mediation. An explicit server connection can still load client plugins from local paths or server inventory. Use generated config and an explicit first-party plugin set. Disable project/global plugin discovery and automatic installation in native mode. Validate terminal control sequences, resize and interactive approval. |
| Local MCP, subagents and processes | Disable MCP initially. Future local MCP children must start within the same or stricter boundary. A host or remote MCP service performs effects outside it and needs separate admission, policy and user disclosure. |
| Managed OpenCode and background work | Refuse external attach, service discovery, raw terminal APIs, unscoped worktrees, automation and host-side delegation. Start the pinned leased server inside the workload. Stdio advertises an HTTP endpoint and carries the lifetime lease. The client and admission endpoint can use private workload loopback; any host-facing route needs an explicit mediated channel. Bind the verified workspace and boot identity to actual contained runtime and policy. Gate the first prompt and monitor loss of readiness. |
| Provider inference and OAuth | Resolve authentication on the host. Expose a protocol-specific quota-limited relay via a private channel, with narrowly allowed provider operations, fixed destination/TLS and no general forwarding. Handle login or browser callbacks on the host. An admitted tool that can reach the relay may consume its run quota until caller separation is proven. Provider endpoint incompatibility stops the selected mode. |
| Credentials, Git, sessions and evidence | Give the workload a synthetic home and clean XDG roots, generated config and its own state. Never copy an existing OpenCode SQLite database wholesale: it can hold credentials and scheduled work. Keep raw provider credentials, SSH/cloud material, agent/keychain sockets, ambient environment and host evidence outside. Keep session state per workspace and backend. Validate and quarantine any persisted/exported state. Treat guest evidence as telemetry. The host records policy identity, exit and cleanup separately. |
| Host outputs | Review staged changes, restrict export by approved paths and base identity, and check for conflicts before applying. Keep the normal coding loop inside the staged project. Test Git, preview/application and resume before claiming existing checkout semantics. |

The supported hybrid is **whole-runtime confinement plus narrowly mediated host
services**. Tool-only sandboxing leaves in-process file operations and plugins
dependent on harness checks. Sandboxing just the client can allow a managed host
server to execute prompts and tools. Host provider and export services are outside
the OS sandbox and form part of the trusted computing base. No kernel-exploit,
administrator-resistance, side-channel, provider-data-confidentiality or arbitrary
third-party integration guarantee is proposed. Native builds must demonstrate actual
filesystem denial, network restrictions and cleanup before those capabilities are
displayed. See [implementation plan](BW-031_IMPLEMENTATION_PLAN.md) and
[qualification requirements](BW-032_PLATFORM_QUALIFICATION.md).
