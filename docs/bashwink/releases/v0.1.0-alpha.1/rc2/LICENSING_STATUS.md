# v0.1.0-alpha.1 RC2 — licensing and artifact status

**Not a legal conclusion.** This records what the artifact contains and what changed. Counsel or the
project owner decides whether it is sufficient.

## FFmpeg: removed from the shipped binaries

RC1 shipped the stock OpenCode binaries, which embed a statically linked LGPL-2.1-or-later FFmpeg
(inside `libopentui`). ADR-009 said not to ship them without sign-off. RC2 ships OpenCode 2.3.2 rebuilt
from the pinned source with a `libopentui` built from OpenTUI v0.8.4 without FFmpeg. Details, recipe
and limits: `release/NOFFMPEG_RUNTIME.md`.

| Evidence | Result |
| --- | --- |
| FFmpeg markers (`avcodec`, `avformat`, `swscale`, `libav`, `FFmpeg`) in the stock Linux guest binary | 76 / 32 / 52 / 96 / 6 |
| Same markers in the rebuilt Linux guest binary and the rebuilt macOS binary | 0 in both |
| First rebuild still contained FFmpeg | Yes: the musl target also embeds the glibc `libopentui`. Found by locating embedded ELF objects; fixed by rebuilding that library too |
| `nm -gU` FFmpeg symbols in the rebuilt macOS library | 0 |
| Builder guard | `scripts/build_release.py` refuses any runtime whose SHA-256 differs from `release/runtime-pins.json` **or** that contains an FFmpeg marker; the stock-binary pins were removed from `inputs.lock.json` |
| Archive scan (exact candidate) | the host runtime and the guest `initramfs` contain no FFmpeg marker (runner step) |
| Notices | regenerated with `generate_notices.py --model PM-1 --no-ffmpeg` (7 components) |

## Functional validation of the rebuilt runtime

macOS binary: runtime-health, tool-lifecycle (19), contract (14) and idempotent-resume (10) fixtures
and the TUI render fixture pass. Linux binary inside the VM: release-image project acceptance, egress
probe, lifecycle and the guest-TUI boundary fixture run on it (see the RC2 results). It reports
`v2.3.2`.

## What is still open

| Item | Status |
| --- | --- |
| Bun embeds JavaScriptCore (LGPL-2.0) | In every binary here (host Bun, guest Bun, and the runtime inside each OpenCode build). Unchanged and **not** addressed |
| GPL components in the Alpine guest (kernel, BusyBox, socat, readline, libgcc runtime exception) | Notices and source pointers are shipped; whether that satisfies each licence is the owner's call |
| Rebuilt runtime differences from upstream | Web UI omitted (`--skip-web-ui`); unstripped native libraries; built on one machine, pinned by hash; no upstream signature |
| OpenTUI's own test suite against the rebuilt library | Not run |
| Dependency vulnerability audit | Not run |
| Legal sign-off | **Not obtained.** RC2 is not approved for distribution on licensing grounds either |

## Artifact

RC2 archive `bashwink-0.1.0-alpha.1-macos-arm64.tar.gz`, SHA-256
`8acedf7f7ed1461cb9f6a065c06c096ce890e478879b5bc5950b1d40680c68be`, 291,241,824 bytes. Two independent
builds of the candidate commit are **byte-identical** (same machine, same pinned inputs and
toolchain). The previous RC1 archive was not reproducible (inode numbers in the initramfs cpio and a
wall-clock timestamp); both causes are fixed.
