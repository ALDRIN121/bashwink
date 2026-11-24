# Native sandbox known limitations

| Area | Current limitation |
| --- | --- |
| Support | The probe ran on one macOS arm64 build. Apple’s `sandbox-exec` is deprecated and may be refused inside a managed parent sandbox. Linux Bubblewrap qualification is open. |
| Coding | The offline fixture can start the native TUI and complete a mock turn in its synthetic workspace. It retains its private session database. A separate file-only profile supports supervised reopen and explicitly reviewed application of a single staged text file. General project import and shell-enabled recovery remain unavailable. Existing default coding remains direct host execution with policy controls. |
| Filesystem | The executed negative checks cover a synthetic sibling canary and a symlink to it. Hardlinks, concurrent replacement, special files, linked Git exports, case and Unicode aliases remain unqualified. |
| Network and secrets | TCP loopback denial is verified with a positive unrelated-listener control. The offline server and client have role-specific authorized loopback ports. UDP, IPv6, DNS, LAN, Unix socket boundaries and real provider secret separation remain unqualified. |
| Cleanup | The offline fixture reaps the owned TUI and server on supervised exit. Abrupt launcher termination left a stale readiness lease and the stage remains blocked. A disowned fixture process survived supervised TUI and server shutdown, so detached cleanup fails for the shell-capable profile, and no workload-level CPU or memory ceilings are assigned. |
| Release | Neither native target has BW-032 release evidence. Keep native coding admission closed and external alpha/public release on hold. |

[Milestone report](BW-031_IMPLEMENTATION_REPORT.md) · [Required platform controls](BW-032_PLATFORM_QUALIFICATION.md).
