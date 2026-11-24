# Security limitations

- The native Seatbelt fixture is file-only. Its prior shell mode stays disabled
  because a detached writer survived process-group cleanup.
- The Hypervisor-backed VM work is a lab fixture. The installed CLI has no qualified
  shell-capable VM backend. Ordinary local mode has host access for approved commands
  and is outside the external alpha boundary.
- Single-file Seatbelt export has tested interruption recovery. Production stage
  transfer, multi-file review, and project/test integrity remain release work.
- The guest lab uses an offline mock. Real credential isolation and request limiting
  require a host-owned provider relay and real-provider validation.
- Power loss, clean-install qualification, and the minimum macOS version remain
  unverified.

[Bashwink native qualification](../../BW-032_QUALIFICATION_RESULTS.md)
