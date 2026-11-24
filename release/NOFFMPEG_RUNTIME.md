# The no-FFmpeg OpenCode runtime

The upstream OpenCode 2.3.2 binaries (macOS and Linux) embed `libopentui`, which statically links
FFmpeg (LGPL-2.1-or-later). This release does not ship them. It ships OpenCode 2.3.2 **rebuilt from
the pinned source with a libopentui built without FFmpeg** (ADR-009 recipe). Bashwink does not play
video.

This file says exactly what was done and what it does and does not establish.

## What was built

| Part | Source |
| --- | --- |
| OpenCode | `https://github.com/anomalyco/opencode` tag `v2.3.2`, commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1` |
| libopentui | `https://github.com/anomalyco/opentui` tag `v0.8.4`, commit `d4a2af24ba50636da5f222367f91746a1bf89644` |
| Zig | 0.17.0 (`zig-aarch64-macos-0.17.0.tar.xz` from ziglang.org), the version `build.zig` requires |
| Bun | 1.4.4 (the version OpenCode's build script requires) |

## Recipe (run on macOS 27.0.1 arm64, 2026-11-25)

```sh
# 1. libopentui without FFmpeg, three targets (the build warns "building without video")
cd opentui/packages/native && sh scripts/prepare-zig-deps.sh
zig build -Doptimize=ReleaseFast                                   # aarch64-macos      -> libopentui.dylib
zig build -Doptimize=ReleaseFast -Dlibrary-target=aarch64-linux-musl   # guest          -> libopentui.so
zig build -Doptimize=ReleaseFast -Dlibrary-target=aarch64-linux-gnu.2.17  # see note    -> libopentui.so

# 2. A copy-on-write copy of the pinned OpenCode checkout (the original is untouched)
cp -cR opencode opencode-build && cd opencode-build/packages/cli
bun install --os="*" --cpu="*" --libc="*" @opentui/core@0.8.4 @opencode/pty@0.6.0

# 3. Replace the stock native libraries in the three platform packages (delete, then copy: never edit in place)
#    @opentui/core-darwin-arm64, @opentui/core-linux-arm64-musl, @opentui/core-linux-arm64

# 4. Compile, one output directory per target (the script empties its output directory)
export OPENCODE_VERSION=2.3.2
OPENCODE_TARGET=darwin-arm64      bun run script/build.ts --skip-install --skip-web-ui --outdir=dist-darwin-arm64
OPENCODE_TARGET=linux-arm64-musl  bun run script/build.ts --skip-install --skip-web-ui --outdir=dist-linux-arm64-musl
```

The glibc `aarch64-linux` library is built and swapped too because the musl target's build **also
embeds the glibc variant**. Swapping only the musl library left a stock FFmpeg-containing library
inside the binary; this was found by locating the embedded ELF objects and fixed.

## Differences from the upstream release binaries (stated, not hidden)

- `--skip-web-ui`: the browser UI archive is empty. The terminal UI and the private server that
  Bashwink uses are unaffected; `opencode serve` web pages are not available.
- The native libraries are the ReleaseFast builds with debug info (not stripped), so the Linux binary
  is larger than upstream (272.7 MB against 247.7 MB). The macOS binary is smaller (205.9 MB against
  225.8 MB).
- The binaries are built on this machine and are not byte-reproducible; they are pinned by hash in
  `runtime-pins.json`. The release builder refuses any other file.
- They are not the upstream release artifacts and carry no upstream signature or attestation.

## Verification performed

| Check | Result |
| --- | --- |
| FFmpeg markers (`avcodec`, `avformat`, `swscale`, `libav`, `FFmpeg`, `_ff_`) in each binary | 0 in both |
| `nm -gU` on the macOS library: FFmpeg symbols | 0 (the build exports no video code) |
| `opencode --version` | `v2.3.2` for both builds |
| macOS build with the runtime-health, tool-lifecycle, contract and idempotent-resume fixtures | pass |
| macOS build renders the TUI (interactive-entry fixture) | pass |
| Linux build inside the VM | see the release qualification results |
| `scripts/build_release.py` refuses any runtime that contains an FFmpeg marker or differs from the pin | enforced at build time |

## What this does NOT establish

- **It is not a legal conclusion.** Removing FFmpeg removes the FFmpeg obligation, not every obligation.
- **Bun embeds JavaScriptCore (LGPL-2.0)** and is the runtime inside every OpenCode build and the
  separate Bun binaries in this archive. That obligation is unchanged.
- The Alpine guest includes GPL components (kernel, BusyBox, socat, readline, libgcc runtime under
  its exception). Their notices and source pointers are in `THIRD_PARTY_NOTICES.txt`; whether
  that satisfies each licence needs the owner's review.
- A rebuilt libopentui has not been run against OpenTUI's own test suite, only against the Bashwink
  fixtures above.
