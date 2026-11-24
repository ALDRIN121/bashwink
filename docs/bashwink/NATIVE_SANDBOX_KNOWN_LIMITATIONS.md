# Native sandbox known limitations

| Area | Current limitation |
| --- | --- |
| Support | The probe ran on one macOS arm64 build. Apple’s `sandbox-exec` is deprecated and may be refused inside a managed parent sandbox. Linux Bubblewrap qualification is open. |
| Coding | The admitted file-only offline profile can start the native TUI and complete a mock turn in its synthetic workspace. It retains its private session database and supports reopen and explicitly reviewed application of a single staged text file. General project import and shell-enabled native startup remain unavailable. Existing default coding remains direct host execution with policy controls. |
| Filesystem | The executed negative checks cover a synthetic sibling canary and a symlink to it. Hardlinks, concurrent replacement, special files, linked Git exports, case and Unicode aliases remain unqualified. |
| Network and secrets | TCP loopback denial is verified with a positive unrelated-listener control. The offline server and client have role-specific authorized loopback ports. UDP, IPv6, DNS, LAN, Unix socket boundaries and real provider secret separation remain unqualified. |
| Cleanup | The file-only fixture reaps both owned processes on supervised exit. After launcher death, recovery requires an exclusive kernel lock and a prior descriptor proof for the pinned no-fork workload. An unknown writer or incomplete proof keeps the stage closed. A journaled interrupted export can be reconciled only from the original destination when host identities and content agree. Shell-capable Seatbelt cleanup failed. Workload-level CPU and memory ceilings remain unqualified. |
| Release | Neither native target has BW-032 release evidence. Keep native coding admission closed and external alpha/public release on hold. |

[Milestone report](BW-031_IMPLEMENTATION_REPORT.md) · [Required platform controls](BW-032_PLATFORM_QUALIFICATION.md).
