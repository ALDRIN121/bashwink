# ADR-009 — Distribution model and the FFmpeg licensing determination

**Status:** Accepted
**Date:** 2026-11-23
**Owner:** Aldrin Joseph
**Depends on:** ADR-001, ADR-003, ADR-008
**Evidence:** `LICENSING_DETERMINATION.md`; reproducible build and runtime probes recorded there

## Context

The Phase 0 gate was blocked on one question: the built binary contains a statically linked
LGPL-2.1-or-later FFmpeg, which arrives inside `libopentui.dylib`. Prior analysis said
"copy the license files and get legal review", which is a prerequisite, not a strategy.

The independent review was correct that a strategy was missing. This ADR supplies one.

## What was established by execution

1. **FFmpeg lives in `libopentui.dylib`, not in `opencode` directly.** The dylib carries 796
   FFmpeg symbols and links no external `libav*` dylib — it is statically linked *inside* the
   dylib.
2. **That dylib is embedded byte-identically in the binary** at offset 167,016,147 (full-length
   comparison returned `True`). So shipping the binary ships the dylib.
3. **`@opencode/cli@2.3.2` has zero runtime dependencies** — only per-platform optional binary
   packages. Bundling OpenCode means bundling its native library.
4. **A no-FFmpeg build of the pinned source is viable.** `zig build -Doptimize=ReleaseFast`
   without an FFmpeg prefix emits `warning: … building without video` and succeeds
   (`-Drequire-video` defaults to false, `build.zig:633`).
5. **The no-FFmpeg library works.** 796 FFmpeg symbols → **0 genuine ones** (the single
   regex hit is `_ot_video_set_av_sync_offset`, an OpenTUI API name). All 11 public
   `ot_video_*` entry points survive. The library loads via `OPENTUI_LIB_PATH`, passes the
   `ot_context_abi_version` check, and renders the full TUI with no init errors.
6. **`OPENTUI_LIB_PATH` is a genuine library-replacement mechanism**, proven with a negative
   control (`Error: Failed to initialize OpenTUI render library (set by OPENTUI_LIB_PATH)`)
   and a positive control (a re-signed, modified dylib rendered the TUI normally). This is the
   concrete form of the LGPL §6 relinking right.

## Decision

**1. Bashwink adopts two explicit distribution models with different obligations.**

- **PM-0 (default): publish `@bashwink/evidence` as an npm package.** No native code is
  redistributed; `@opencode/*` is a peer. **Zero FFmpeg exposure.**
- **PM-1 (only if a branded binary is required): ship the no-FFmpeg library.** Build
  `libopentui` from pinned OpenTUI `v0.8.4` without the FFmpeg prefix and substitute it. Video
  playback is unavailable; Bashwink does not use video.

**2. The stock LGPL binary is not a release artifact** unless counsel signs off. Its §6
relinking route is proven and documented, so that option remains open without being taken.

**3. Notices are generated, not hand-written.** `scripts/generate_notices.py --model PM-0|PM-1
[--no-ffmpeg]` emits a distributable bundle by copying the actual license texts, and exits
non-zero if any expected file is missing. PM-1-no-FFmpeg bundles seven permissive components
and **excludes FFmpeg entirely**.

**4. Removing FFmpeg removes the FFmpeg obligation, not all obligations.** PM-1 still requires
MIT/Apache-2.0/BSD/Zlib notices for OpenTUI, WUFFS, zlib, libwebp, stb and Ghostty. This is
ordinary attribution, not a legal question.

## Consequences

**Positive:** the gate's licensing condition is satisfiable without legal risk, and by building
rather than by argument. The release blocker is cleared by changing what ships, not by
reinterpreting a license.

**Negative and accepted:**
- **The no-FFmpeg library is not byte-reproducible.** Two clean builds differ in hash
  (`b8e9fd3c…` vs `9b5c94c1…`) because Zig embeds 194 absolute build paths; size and symbol
  profile are identical. A release would need path normalisation (unavailable at 0.8.4) or
  must publish the recipe plus a symbol-profile assertion instead of a digest.
- **No video playback** in PM-1. Accepted: Bashwink is a terminal coding agent.
- **OpenTUI's own test suite was not run** against the no-FFmpeg build — only a TUI smoke
  test. Full native tests are not part of Phase 0.
- **macOS arm64 only.** No Linux or Windows build was attempted.
- **This is not legal advice.** The determination says what is in each artifact and removes the
  known LGPL exposure; it does not warrant legal sufficiency, and counsel review is still
  advisable before public release.

## Reversal conditions

- If counsel confirms a compliant route for the stock binary, PM-1-stock becomes available
  using the proven `OPENTUI_LIB_PATH` mechanism.
- If Zig gains deterministic path mapping at a future OpenTUI pin, byte-reproducibility can be
  asserted and the recipe tightened.
- If Bashwink ever needs video, PM-1-no-FFmpeg is unavailable and this ADR must be revisited.
