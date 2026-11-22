# Bashwink — Third-Party Notices and License Audit

**Audit date:** 2026-11-22
**Scope:** the pinned OpenCode foundation (`v2.3.2`, `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`)
plus Bashwink's own packages.
**Method:** enumerated every `package.json` under `node_modules` (1,641 unique name/version
pairs) and read the `license` field, then inspected the notable cases by hand.
**Task:** BW-005.

---

## 1. Summary

| License | Packages |
| --- | ---: |
| MIT | 1,218 |
| Apache-2.0 | 142 |
| ISC | 118 |
| BSD-2-Clause | 29 |
| BSD-3-Clause | 26 |
| BlueOak-1.0.0 | 20 |
| MPL-2.0 | 9 |
| `MIT OR Apache-2.0` | 8 |
| `apache-2.0` (lowercase spelling) | 6 |
| `(MIT OR CC0-1.0)` | 3 |
| **LGPL-3.0-or-later** | **3** |
| **LGPL-2.1-or-later (conjunction)** | **1** |
| `SEE-LICENSE-FILE` | 1 |
| No `license` field | 37 |

**Verdict: no GPL, AGPL, SSPL or BUSL package is present.** The only copyleft is LGPL, in
four packages, analysed in §3. The 37 packages without a `license` field are analysed in §4
and are all resolvable.

## 2. Bashwink's own license

Bashwink is MIT, matching upstream. `packages/bw-evidence` declares `"license": "MIT"`.
**`LICENSE` file: not yet written** — see §6 open items.

## 3. Copyleft analysis (the only items needing a decision)

### 3.1 `@img/sharp-libvips-*` — LGPL-3.0-or-later (3 copies)

`@img/sharp-libvips-darwin-arm64` at 1.2.4, 1.3.3, 1.3.4.

- Used by `sharp`, which is referenced **only** by `services/site/package.json` (the
  documentation website), not by the CLI, core, or any Bashwink package.
- **Decision: out of the Bashwink distribution.** The site is not shipped in the product
  artifact. If Bashwink ever ships `services/site` inside a product image, LGPL-3 §4
  obligations (notice, source availability, relinking) apply — recorded here so that is not
  discovered later.
- Action: none required for the CLI. The distribution must exclude `services/`.

### 3.2 `@opentui/core-darwin-arm64` — `MIT AND LGPL-2.1-or-later` (1 package)

This is the only copyleft in the **shipped** dependency path. `@opentui/core` itself is
pure MIT; the platform binary package is a conjunction of MIT and LGPL-2.1-or-later.

Why: the binary statically links a minimal **decode-only FFmpeg 9.0.2** build. Its own
`FFMPEG-SOURCE.md` states:

> "Native video statically links a minimal decode-only FFmpeg 9.0.2 build: MOV/MP4 demuxing,
> H.264 video decoding, AAC audio decoding, file I/O, libswscale, and libswresample. […] GPL
> and nonfree components are disabled."

The package also ships `LICENSE-FFMPEG` (the full LGPL-2.1 text) alongside
`LICENSE-WUFFS` (Apache-2.0), `LICENSE-ZLIB`, `LICENSE-LIBWEBP` (BSD-3), `LICENSE-STB`
(MIT/BSD), `LICENSE-GHOSTTY` (MIT), `LICENSE-LCMS2` (MIT) and `AUTHORS-LIBWEBP`.

**Assessment: distributable, with obligations.**

1. LGPL-2.1 §6 permits static linking **provided** the recipient can relink against a
   modified version. The practical route is to pass through the upstream license files and
   offer the FFmpeg source. Upstream already disables GPL components and publishes the
   source reference, which is why the conjunction — not plain GPL — is what appears.
2. The built `opencode` binary **does contain FFmpeg**: `strings` on the 198 MB artifact
   matched `ffmpeg`/`libavcodec` 41 times. So this is not hypothetical; every distributed
   `bashwink` binary carries these obligations.
3. **Required action before any release:** ship the opentui license bundle (all nine files)
   verbatim in the distribution, state the FFmpeg version and source URL, and include the
   LGPL-2.1 text. **Not yet done** — see §6.

This is a *compliance* task, not a blocker: LGPL-2.1 static linking is permitted, and
upstream has already done the hard part by removing GPL components.

### 3.3 `@solidjs/start` — `SEE-LICENSE-FILE`

App-framework package for the web UI (`packages/app`), which is not part of the CLI build
(`--skip-web-ui` was used for the verified artifact). Its license file is present in the
package. Not in the shipped CLI path; no action.

## 4. Packages with no `license` field (37)

All 37 were traced to one of two benign causes:

| Cause | Example | Resolution |
| --- | --- | --- |
| **Test fixtures inside a dependency**, not real packages — fake `package.json` files created by `resolve`'s own test suite to exercise module resolution | `browser_field`, `invalid_main`, `false_main`, `baz` | Not distributable packages. Ignore. |
| **Subpath entries** appearing as packages during a naive walk | `solid-js/web`, `solid-js/store`, `solid-js/h` | Part of `solid-js` (MIT). Ignore. |

Residual genuine cases with no field but a license file present, so attribution is still
possible: `@mapbox/node-pre-gyp`, `@vercel/nft`, `abbrev`, `acorn`, `acorn-import-attributes`,
`async-sema`, `bindings`, `blake3-js`, `consola`, `estree-walker`, `file-uri-to-path`,
`node-gyp-build`, `nopt`, `picomatch`, `resolve-from`, `web-streams-polyfill*`.
These are all MIT/ISC/Apache-2.0 per their `LICENSE` files and per npm metadata; the missing
field is a packaging sloppiness upstream, not a licensing unknown.

**Action:** the *generated notices bundle* must copy their `LICENSE` file text rather than
relying on the metadata field. This document is the findings record, not that bundle.

## 5. Non-license third-party obligations

- **Trademarks.** "OpenCode" and its logo belong to Anomaly. Bashwink must not use the
  OpenCode name or logo as its own product identity, and must not imply endorsement.
  Accepted in ADR-003: Bashwink ships under its own name via a wrapper CLI.
  **No upstream logo is copied into this repository.**
- **Hermes Agent** (Nous Research, MIT) is a *conceptual* reference only; no code is copied
  (ADR-001). If any is later adopted, its MIT notice must accompany it.
- **Hosted services.** Nothing in this repository calls an OpenCode-hosted service. The mock
  provider is local-only.

## 6. Open items (NOT satisfied — BW-005 is not complete)

| Item | State |
| --- | --- |
| `THIRD_PARTY_NOTICES.md` (findings record, with inventory and per-package analysis) | **Written** |
| Generated notices bundle — copied `LICENSE`/`NOTICE` text for every shipped dependency | **Not generated** |
| `LICENSE` file at repo root | **Written** (MIT) |
| opentui/FFmpeg license bundle copied into the distribution | **Not done** |
| FFmpeg source URL + LGPL-2.1 text included in release artifacts | **Not done** |
| Automated license gate in CI (fail on GPL/AGPL/SSPL) | **Not implemented** |
| Legal review by a human | **Not performed** |

BW-005's acceptance criterion — "`THIRD_PARTY_NOTICES.md`, attribution and flagged
unresolved legal/brand items" — is **partially met**: the findings document, the flags and the
root license exist, but the *generated notices bundle* that actually ships attribution text,
and the distribution work, are outstanding. Status: **In progress**, not Done.
