# Native sandbox security model

The installed macOS probe trusts the Bashwink executable, Seatbelt, the OS read-only
system paths and the explicitly supplied pinned runtime artifact. It creates private
fixture paths and launches trusted diagnostic programs with an empty stdin and an
allowlisted environment. Its Seatbelt policy denies by default, grants writes to
disposable workspace and scratch, and denies networking. The harness independently
checks the protected file hash and device/inode and observes a fixture-owned listener.
Bun’s pinned runtime startup requires read-only hardware/OS queries and ICU system data.

The future native agent must cover OpenCode server, TUI, in-process file tools, shell,
plugins and descendants within one policy boundary. It must use an isolated workspace
and state, prohibit host-server reuse and require pre-dispatch attestation. The host
supervisor owns lifecycle records, approved export and the provider relay. Credentials
remain host-owned. Third-party plugins, MCP, provider connections, automations and raw
host IPC are outside the initial probe entirely. An explicit user-authorized provider
may receive task context through the eventual qualified relay.

A probe report is evidence of observed fixture operations. It does not authorize an
agent run or attest a product-level profile. Administrators, compromised trusted binaries,
OS vulnerabilities and side channels remain outside the proposed workload threat model.
[Architecture review](BW-031-SANDBOX-PROPOSAL.md) · [Limitations](NATIVE_SANDBOX_KNOWN_LIMITATIONS.md).
