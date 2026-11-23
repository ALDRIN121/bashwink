# ADR-012 — Private runtime admission

**Status** Implemented for the pinned OpenCode local backend.

The OpenCode v2.3.2 plugin registry settles activation and can retain failed entries while
its runtime continues. A post-exit boot record is useful evidence but cannot authorize
startup. Bashwink starts the same pinned runtime using its stdio-owned server mode and
withholds client launch until the authenticated server inventory and a fresh in-process
acknowledgment agree. The acknowledgment is written after the required policy hooks
register, and it binds run ID, random nonce, workspace and server PID. The registered
setup cleanup kills the leased server if the policy plugin unloads unexpectedly.

The client receives a separate authenticated loopback endpoint. It admits the pinned
session actions in the verified workspace, refuses foreign saved-session actions and
excludes service, raw process, automation and policy mutation routes. The source
runtime database is checked read-only for saved automations and legacy schedules before
the server starts. A short retry handles transient SQLite bootstrap locks. The pinned
server's scheduler begins before endpoint readiness. The workspace
policy pin is reapplied after project configuration, file watching is disabled for this
server and untrusted client TUI plugin discovery is refused when applicable.

This design preserves the OpenCode model and server runtimes and requires no upstream
fork. It changes the local CLI contract where unrestricted passthrough would invalidate
admission. The private runtime owns the two direct children. This protects the admitted
runtime path and depends on trusted host files, same-user processes and the selected
runtime binary. Whole-process-tree containment, network and filesystem isolation require
BW-031. [Implementation](BW-018_IMPLEMENTATION_REPORT.md) · [Lifecycle](BW-030_EXECUTION_BACKEND_DESIGN.md).
