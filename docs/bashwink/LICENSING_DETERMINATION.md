# FFmpeg / OpenTUI licensing — determination and PM-1 packaging decision

**Date:** 2026-11-23
**Owner:** Aldrin Joseph
**Status:** assessment complete, one decision required, not legal advice
**Supersedes:** the "OPEN" position recorded in `DEPENDENCY_LICENSES.json` for
`@opentui/core-darwin-arm64`

---

## 1. The intended distribution model (was previously unstated)

Bashwink has two potential artifacts. They have **different** licensing exposure, and
conflating them is what made the earlier analysis unresolvable.

### PM-0 — `@bashwink/evidence` as a published npm plugin (recommended primary)

| Property | Value |
| --- | --- |
| Artifact | JavaScript/TypeScript source in an npm tarball |
| Native code shipped | **none** |
| Third-party code redistributed | **none** — `@opencode/*` is a *peer* dependency |
| FFmpeg exposure | **zero** |
| Obligations | MIT attribution only |

This is the distribution model ADR-001 describes ("pinned dependency + plugin"). In it,
Bashwink redistributes no OpenTUI and no FFmpeg, because the consumer installs OpenCode
themselves and npm resolves the platform binary on their machine.

### PM-1 — a standalone `bashwink` binary (ADR-003 wrapper / bundled host)

| Property | Value |
| --- | --- |
| Artifact | a single executable containing the JS bundle **and** `libopentui.dylib` embedded at `/$bunfs/root/` |
| Native code shipped | **yes** — the OpenTUI native library |
| FFmpeg exposure | **yes, in the stock build** |
| Obligations | all bundled notices + (stock build) LGPL-2.1 §6 |

### Verified facts that decide this

1. **`@opencode/cli@2.3.2` has zero runtime dependencies.** Its `package.json` declares
   `dependencies: {}` and only per-platform optional binary packages
   (`@opencode/cli-darwin-arm64` etc.). The stock `opencode` binary therefore already
   contains everything, including the native OpenTUI library.
2. **The FFmpeg is compiled into `libopentui.dylib`, not into `opencode` directly.**
   `libopentui.dylib` is a 6.3 MB Mach-O dylib with **796 FFmpeg symbols**
   (`_ff_aarch64_sme_length`, `_ff_abgr32ToUV_neon`, …) and **no** external
   `libavcodec`/`libavformat` dylib dependency — i.e. FFmpeg is statically linked inside it.
3. **The dylib is embedded byte-identically in the binary.** Extracting the dylib's bytes
   from `opencode` found them at offset **167,016,147**, and a full-length comparison
   returned `True`. So distributing the binary distributes the dylib.
4. **`OPENTUI_LIB_PATH` is a real library-replacement mechanism.**
   Verified with a negative control (see §4). This is the LGPL §6 "relinking" route.

---

## 2. Investigation result: a no-FFmpeg build is viable

The pinned OpenTUI source builds without FFmpeg. Evidence:

```
$ cd packages/native && zig build -Doptimize=ReleaseFast
warning: FFmpeg for aarch64-macos is missing or built by another Zig version;
         building without video.
         Run `bun scripts/build-ffmpeg.ts --target=aarch64-macos` in packages/native.
$ echo $?
0
```

`-Drequire-video` defaults to **false** (`build.zig:633`), so the absence of an FFmpeg prefix
does not fail the build — it produces a no-video library. Release builds pass
`-Drequire-video`; Bashwink deliberately does not.

### Reproducible build recipe

```bash
# 1. Pinned corresponding source (OpenTUI v0.8.4)
git clone --filter=blob:none --no-checkout https://github.com/anomalyco/opentui.git
cd opentui && git checkout v0.8.4
git rev-parse HEAD        # d4a2af24ba50636da5f222367f91746a1bf89644

# 2. Zig 0.17.0 exactly (build.zig SUPPORTED_ZIG_VERSIONS = 0.17.0)
curl -sLO https://ziglang.org/download/0.17.0/zig-aarch64-macos-0.17.0.tar.xz
tar xf zig-aarch64-macos-0.17.0.tar.xz
export PATH="$PWD/zig-aarch64-macos-0.17.0:$PATH"

# 3. Vendor deps (no FFmpeg step)
cd packages/native && sh scripts/prepare-zig-deps.sh

# 4. Build WITHOUT the FFmpeg prefix
zig build -Doptimize=ReleaseFast
# -> packages/native/lib/aarch64-macos/libopentui.dylib
```

### What changed in the artifact

| Evidence | Stock | No-FFmpeg | Method |
| --- | ---: | ---: | --- |
| FFmpeg-prefixed symbols | **796** | **1**¹ | `nm -gU` |
| Real FFmpeg-library symbols | 796 | **0** | `nm -gU \| grep avcodec\|avformat\|avutil\|swscale\|swresample` |
| Exported symbols total | 2,702 | 1,888 | `nm -gU` |
| Symbols removed | — | **814** | `comm -23` |
| Removed symbols that are FFmpeg internals | — | 795 | `_ff_*` NEON colour-conversion helpers |
| FFmpeg dylib dependencies | 0 (statically linked) | 0 | `otool -L` |
| Size | 6,608,464 B | 5,359,968 B | `stat` |

¹ the single match is `_ot_video_set_av_sync_offset` — an **OpenTUI API name** containing the
token `av_`, not FFmpeg code. Zero genuine FFmpeg symbols remain.

**The public video API is preserved.** All 11 `ot_video_*` entry points still exist and are
exported; video playback reports unavailable rather than being compiled out. Nothing Bashwink
uses is affected: Bashwink is a terminal coding agent and does not play video.

### Runtime proof

| Test | Result |
| --- | --- |
| Library loads via `OPENTUI_LIB_PATH` | **yes** |
| ABI check (`ot_context_abi_version`) passes | **yes** — version 1 matches |
| TUI renders (not just `--version`) | **yes** — prompt rendered, 10,792 bytes of TUI output |
| Init errors | **none** |

**Conclusion: the no-FFmpeg build is functionally adequate for Bashwink.**

### Reproducibility caveat (stated honestly)

Two clean builds produced **different SHA-256 digests** (`b8e9fd3c…` vs `9b5c94c1…`) with
identical size and identical symbol profile. The difference is 194 embedded absolute build
paths in the Mach-O symbol table. **The build is functionally reproducible but not
byte-reproducible.** Shipping it would require either `-fdebug-prefix-map`-style path
normalisation in the Zig build (not available at 0.8.4) or publishing the recipe plus a
symbol-profile assertion instead of a digest. Recorded rather than glossed over.

---

## 3. Remaining obligations under PM-1 (no-FFmpeg)

Removing FFmpeg removes the **LGPL-2.1 §6** obligation for FFmpeg. It does not remove
everything:

| Component | License | In no-FFmpeg artifact | Obligation |
| --- | --- | --- | --- |
| OpenTUI `libopentui.dylib` | MIT | yes | MIT notice |
| WUFFS | Apache-2.0 | yes | notice + NOTICE file |
| zlib | Zlib | yes | notice |
| libwebp | BSD-3-Clause | yes | notice + PATENTS file |
| stb | MIT / public domain | yes | notice |
| Ghostty (terminal code) | MIT | yes | notice |
| lcms2 | MIT | **removed in our build** (0 refs) | none |
| **FFmpeg** | **LGPL-2.1-or-later** | **NO** | **none under PM-1** |

So PM-1-without-FFmpeg still requires a notices bundle for six permissive components. That
is ordinary MIT/Apache/BSD attribution — a solved problem, not a legal question.

**PM-0 requires no bundle at all**, because no native code is redistributed.

---

## 4. The LGPL replacement mechanism (proven, kept for PM-1-stock fallback)

If Bashwink ever ships the **stock** binary, LGPL-2.1 §6 applies and the following is the
demonstrated route. It was executed, not theorised:

**Step 1 — build a modified library.** A copy of `libopentui.dylib` was altered
(`install_name_tool -id`, re-signed) producing different bytes:
`4275032b…` (original) vs `29381b2d…` (modified), still a valid Mach-O with the expected
symbols.

**Step 2 — substitute it at runtime.** `OPENTUI_LIB_PATH` was documented in the bundled JS as
"Load the native library from this file instead of the platform package."

**Step 3 — negative control.** Pointing the variable at a nonexistent path produced:

```
Error: Failed to initialize OpenTUI render library (set by OPENTUI_LIB_PATH):
       OpenTUI native library does not exist at "/nonexistent/libopentui.dylib"
```

**Step 4 — positive control.** Pointing it at the modified library rendered the full TUI
successfully (10,792 bytes, zero errors).

This proves a recipient can replace the bundled native library with their own build — the
practical form of the LGPL §6 relinking right. **Not proven and not claimed:** that this
satisfies LGPL §6 *legally*. That is a question for counsel, and it is why PM-1-stock remains
blocked.

**Corresponding source for the fallback:** OpenTUI `v0.8.4`
(`d4a2af24ba50636da5f222367f91746a1bf89644`) plus FFmpeg 9.0.2
(`https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz`, SHA-256
`8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e`) and zlib 1.3.2
(`bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16`), with the exact
configure line in `packages/native/scripts/build-ffmpeg.ts`.

---

## 5. Decision required

| Option | FFmpeg | Legal risk | Cost |
| --- | --- | --- | --- |
| **PM-0** — publish the plugin only | absent by construction | **lowest** | none; already the ADR-001 model |
| **PM-1-no-FFmpeg** — ship a binary with the rebuilt library | **absent** | low; permissive notices only | Zig build in the release pipeline; no video playback |
| PM-1-stock — ship the upstream binary | present, LGPL-2.1 | needs counsel sign-off | none |

**Recommendation: ship PM-0 first, and PM-1-no-FFmpeg if a branded binary is required.
Do not ship PM-1-stock without legal sign-off.**

This is a recommendation, not a compliance determination. The evidence above establishes what
is *in* each artifact; it does not establish that any position is legally sufficient.

---

## 6. What this document does and does not establish

**Establishes (reproducible):**
- FFmpeg is statically linked inside `libopentui.dylib` and that dylib is embedded
  byte-identically in the stock binary.
- The pinned OpenTUI source builds without FFmpeg, and the result loads, passes the ABI check
  and renders a working TUI.
- 796 FFmpeg symbols become 0 genuine ones; the public video API survives.
- `OPENTUI_LIB_PATH` really replaces the native library at runtime.

**Does not establish:**
- That any of these options is legally sufficient. **Not legal advice.**
- Byte-level reproducibility of the no-FFmpeg library.
- That a no-FFmpeg build passes OpenTUI's own test suite (only a TUI smoke test was run).
- Behaviour on Linux or Windows; everything above is macOS arm64 only.
