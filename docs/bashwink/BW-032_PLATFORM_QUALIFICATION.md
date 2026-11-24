# BW-032 Docker-free platform qualification

**Status** Acceptance specification. BW-032 is In progress.
[Current results](BW-032_QUALIFICATION_RESULTS.md). Run these controls only on
disposable fixtures with synthetic credentials, a local mock and an explicitly authorized
test provider account. Source review and primitive tests cannot close this task.

The v0.1.0-alpha candidate targets macOS Apple Silicon only. Its release gate
requires all macOS controls for the supported build and keeps macOS and Ubuntu
regression CI mandatory. Platform qualification for Ubuntu remains in the broader
BW-032 gate. [Alpha release decision](releases/v0.1.0-alpha/RELEASE_READINESS.md)

## Apple VM evidence mapping

For the Apple Virtualization.framework backend, record the signed VM owner, guest
kernel and image hashes, guest runtime, virtual-device configuration, relay policy,
and workspace-transfer policy alongside the Bashwink revision. Test file and network
controls from the actual OpenCode guest and independently observe host canaries. A
guest with no network interface uses the host-owned provider relay for authorized
model traffic. Confirm the relay cannot reach unapproved destinations and that its
run capability expires when the workload ends.

Observe workload retirement at the VM and disk boundaries, including launcher and
owner failure, and confirm a guest descendant can no longer write before treating a
stage as retired. Verify host review and receipt recovery separately from guest
execution. The required controls below apply unchanged to this backend. Lab VM
fixtures alone do not qualify a clean installation or an advertised macOS version.

## Qualification environment

- Use a clean machine for each advertised combination. Start with macOS arm64 on the
  maintained releases selected for support and Ubuntu x86-64 on a supported AppArmor-enabled
  release. Qualify Linux arm64, Mac Intel or other distributions before listing them.
  Record OS build, architecture, kernel, filesystem, namespace/AppArmor policy, package
  revision, native helper and runtime hashes, Bashwink commit and compiled policy digest.
- Use a fresh user/home and repository for each run. Confirm Docker and Podman packages,
  executables and sockets are absent from the normal-path fixture. Use the actual installation
  instructions and normal `bashwink` launch in a real PTY. Check that the first prompt is
  held until the backend, private runtime/nonce and policy are attested.
- Have the host harness create separate approved workspace, forbidden sibling, synthetic
  home secret and external network canaries. Generate throwaway label strings per test and
  use controlled sinks for network tests. Include loopback, a disposable non-loopback
  segment and a fixture DNS stub with no Internet forwarding. Confirm every canary
  works from the host control before launching the guest. Test protocol suffixes or
  credential availability using fake values and capture redacted results only.
- Collect exact commands, exit codes, backend capabilities, stage identities, before/after
  hashes, observed network requests and externally observed process exits. A wrapper refusal
  alone earns policy evidence. A direct operation issued by a disposable test program already
  inside the admitted workload, with the host-side observable result, is needed to claim OS
  enforcement. Record skips, provision failures, and runner cancellations individually.

## Required controls

| Scenario | Action and passing observation |
| --- | --- |
| First launch and ordinary coding | Start from a clean project with no Docker-family tooling. In the real TUI, run one approved coding task using the mock and one using a real authorized provider. Observe the tool dispatch, preview the expected edit and apply it. Verify hashes outside the approved change set. Test resize, model switching and fresh risky-operation approval. Confirm clipboard/control output, browser or editor launch, plugin installation and background updates cannot acquire host access. |
| File and link policy | Prove an allowed read and write from the file tool and an approved shell child. Use fixture-owned outside targets to test rejected reads/writes, relative traversal, symlink target changes, links introduced during staging/export, and hardlink/special-file handling. Cover case and Unicode normalization on the actual host filesystem. Exercise linked worktree metadata referring outside the staged checkout. Check outside hashes and destination identity from the host. |
| Child and background lifecycle | Use an inert helper that starts a controlled child and attempts to remain after its parent. Assert scope applies in the child, then test natural exit, interrupt, timeout, startup error and abrupt launcher death independently. The controller verifies workload cleanup including detached children, temporary state and IPC endpoints before export. Treat any survivor as an exclusion or a release failure depending on the advertised mode. |
| Network and provider transport | With networking denied, guest attempts to reach fixture listeners over TCP, UDP, IPv6 and a non-authorized Unix socket must fail while local controls respond. In provider-only mode, prove approved streaming and cancellation. Confirm unrelated destinations, host LAN/loopback, unauthorized DNS and arbitrary forwarding stay denied. Exercise relay origin/path rejection, redirects and changed address resolutions against fixture sinks. Verify that broker requests are restricted to the run’s protocol, account, model, limits and approved destination. |
| Secret isolation | Plant fake secrets separately in host home, environment, provider credential storage and a fixture-owned endpoint. Confirm the approved provider request works. Verify neither the OpenCode tool nor its descendants can read the host canaries, raw provider credentials or agent/keychain/socket interfaces. Check evidence, session data and diagnostics for sentinel leakage. |
| Approval and alternate dispatch | Use committed negative fixtures for missing/malformed readiness, delayed startup, stale proof, crash and a pre-existing managed server. Exercise native denials under auto-approval, untrusted configuration, in-process file tools, direct TUI shell, workflow delegation, plugin activation and MCP paths. Verify each excluded operation is refused or remains inside the admitted workload, with no host canary side effect. |
| Recovery and export | Interrupt a staged edit and restart the pinned client with native `--continue` and `--session` in the same verified workspace/backend. Refuse foreign workspace or profile state. Validate imported sessions and evidence independently of importing the diff. Assert no duplicate write or false verification. Check conflicting base, malformed output and disallowed destination are refused. Confirm signals and native exit status independently of model output. |
| Unavailable or degraded host | Simulate missing helper, invalid profile, missing namespace permission, required limit unavailable, expired readiness and denied provider access. A native-required run must exit without executing tools or transmitting a prompt and record the stage. Confirm an explicit interactive local restart shows host access, records acknowledgment and still requires risky-operation approval. |
| Optional Docker | Run only on dedicated engine-backed qualification hosts after implementation. Apply the same controls and record engine/host configuration, image digest, actual networking and limits. The clean native installation check remains engine-free. |

Test each policy on each shipped platform and backend. An unsupported mode must
fail at admission. A successful compatibility run earns only the capabilities that
were exercised. Scope exclusions and test tier must be visible in the CLI, release
notes and proof package. Keep external alpha closed if any required native boundary,
ordinary provider turn, or cleanup criterion lacks evidence.
