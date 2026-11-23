# Native sandbox known limitations

| Area | Current limitation |
| --- | --- |
| Support | The probe ran on one macOS arm64 build. Apple’s `sandbox-exec` is deprecated and may be refused inside a managed parent sandbox. Linux Bubblewrap qualification is open. |
| Coding | The probe starts only fixed fixture programs and the explicit runtime’s version command. No native TUI, agent turn, persisted session, staged user checkout or import path is admitted. Existing default coding remains direct host execution with policy controls. |
| Filesystem | The executed negative checks cover a synthetic sibling canary and a symlink to it. Hardlinks, concurrent replacement, special files, linked Git exports, case and Unicode aliases remain unqualified. |
| Network and secrets | TCP loopback was denied with a positive listener control. UDP, IPv6, DNS, LAN, Unix socket boundaries and real provider secret separation remain unqualified. |
| Cleanup | The probe waits on its direct diagnostic children and removes its temporary workspace during normal cleanup. It has no verified detached or abrupt termination containment and sets no workload-level CPU or memory ceilings. |
| Release | Neither native target has BW-032 release evidence. Keep native coding admission closed and external alpha/public release on hold. |

[Milestone report](BW-031_IMPLEMENTATION_REPORT.md) · [Required platform controls](BW-032_PLATFORM_QUALIFICATION.md).
