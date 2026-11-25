# Standard npm package: licensing and dependency audit

**Status: engineering analysis, not legal advice. No legal sign-off exists.** Date of analysis: 2026-11-25.
Candidate: `bashwink-0.1.0-alpha.1.tgz` (private alpha). This document applies ADR-009 to the npm distribution model
of ADR-013 and records what was measured. It does not replace `LICENSING_DETERMINATION.md` (the VM artifact).

## 1. What Bashwink itself distributes

The tarball has 19 files and about 190 KB. No native code and no runtime binary is in it.

| Content | Origin | Licence |
| --- | --- | --- |
| `bin/bashwink.js`, `lib/evidence/**` (plugin source), docs | Bashwink | MIT (`LICENSE`) |
| `lib/bashwink.js` (the compiled CLI) | Bashwink, **plus compiled-in copies of three third-party packages** | see below |
| `effect` 4.1.0 (inside `lib/bashwink.js`) | Effectful Technologies Inc | MIT; licence text shipped in the package and copied into the notices |
| `@opencode/schema` 2.3.2, `@opencode/plugin` 2.3.2 (inside `lib/bashwink.js`) | the OpenCode project | MIT per package metadata; **neither package ships a licence file**, so the notice carries the text of the upstream repository's LICENSE (fetched 2026-11-25) |

**Correction recorded here:** until this commit the shipped notice said the tarball contained only Bashwink's files and
plugin types. That was wrong: the bundle contains the three packages above. The builder now derives the list from the
compiled bundle, includes each licence text in `share/licenses/THIRD_PARTY_NOTICES.txt`, records the list in
`RELEASE_MANIFEST.json` (`bundled_third_party`) and **fails the build** if a bundled package has no recorded notice.

## 2. What npm obtains from other publishers at install time

Resolved from the tarball with `npm install --package-lock-only` (27 packages for all platforms; one platform's worth
is installed per machine).

| Package | Size on macOS arm64 | Publisher's licence metadata | Known embedded third-party code | Ships a licence/notice file? |
| --- | --- | --- | --- | --- |
| `@opencode/cli` + `@opencode/cli-<platform>` 2.3.2 | 215 MB binary | MIT | FFmpeg (LGPL-2.1+, statically linked inside OpenTUI's library, 796 symbols per ADR-009); also libwebp, zlib, stb, Ghostty and others | **No** |
| `bun` + `@oven/bun-<platform>` 1.4.4 | 85 MB binary | MIT | JavaScriptCore (LGPL-2.0), and other components | **No** (the `bun` package has a README only) |

Both are exact-pinned. Bashwink does not modify, patch, repackage or relink either.

## 3. Does ADR-009 apply to this model?

ADR-009 defines PM-0 (publish only a plugin package; `@opencode/*` is a *peer* the user supplies; no native code
redistributed; no FFmpeg exposure) and PM-1 (ship a rebuilt, FFmpeg-free runtime). It states that the stock
LGPL-containing binary "is not a release artifact" without counsel's sign-off.

The standard package **matches PM-0 in what the tarball contains** (no native code) **but not in how it is wired**: the
two runtimes are hard `dependencies`, so installing Bashwink makes npm install the stock binaries. That puts it between
PM-0 and "ship the stock binary". Whether that counts as Bashwink distributing or conveying those binaries, or only
naming a dependency that their own publishers distribute, is a **legal question this analysis does not answer**.

Technical facts that bear on it (verified): the Bashwink process and the OpenCode runtime are separate programs started
by a launcher; Bashwink code is not linked into either binary; one Bashwink plugin is loaded into OpenCode's plugin
host through its published plugin API; the tarball contains no LGPL-licensed code.

## 4. Obligations, as far as engineering can state them

- **MIT components Bashwink copies** (`effect`, the two `@opencode` packages): the copyright and permission notice must
  accompany copies. Done, and enforced by the builder.
- **LGPL components inside the upstream binaries:** source-offer, notice and relinking obligations fall on whoever
  *distributes* those binaries. Today that is their publishers via the npm registry. They would fall on Bashwink's owner
  if Bashwink ever bundled, mirrored or re-hosted the binaries (including a private download page or an installer).
- **Upstream notices:** because neither upstream package ships a licence file, there is nothing inside them for a
  recipient to find. Bashwink's notice says so and names where the texts live.

## 5. Options and recommendation

| Option | Effect | Cost |
| --- | --- | --- |
| A. Keep hard dependencies (current) | One-command install. Relies on the upstream publishers' distribution. Requires the owner's explicit acceptance for an invited private alpha. | none |
| B. Make `@opencode/cli` and `bun` peer prerequisites (ADR-009 PM-0) | Cleanest position; Bashwink never causes the binaries to be installed | breaks the one-command install: testers install two prerequisites first |
| C. Ship a rebuilt FFmpeg-free runtime (ADR-009 PM-1) | Removes the FFmpeg question for the runtime; Bun's JavaScriptCore remains | large artifact per platform, a maintained build; not justified by a concrete need yet |

**Recommendation:** A for an invited, private, unpublished alpha with the owner's recorded acceptance; B if counsel
objects; C only on a concrete finding. **Technical remediation is not required to start the invited alpha; legal
sign-off remains necessary before any wider or public distribution.** Nothing here may be read as compliance.

## 6. Dependency vulnerability audit

| Item | Result |
| --- | --- |
| Command | `npm install --package-lock-only` of the tarball, then `npm audit --json` (npm 10.9.8, registry advisory data, 2026-11-25) |
| Packages audited | 27 dependencies (28 including Bashwink) |
| Findings | **0** (info 0, low 0, moderate 0, high 0, critical 0) |
| Raw result | `release/standard/<candidate>/DEPENDENCY_AUDIT.json` |

**What this does and does not cover.** `npm audit` checks JavaScript packages against the npm advisory database. It does
**not** see native code compiled into the two binaries (JavaScriptCore, FFmpeg, libwebp, zlib, stb and the rest). Those
versions are fixed by the upstream publishers and cannot be audited from here: an **unverified risk**, not a finding.
Pinned versions (`bun` 1.4.4, OpenCode 2.3.2) are chosen for reproducibility; staying on them means taking upstream
security fixes only by a deliberate bump, which is recorded in `NEXT_STEPS.md`.

| Risk | Severity | Applicability | Remediation |
| --- | --- | --- | --- |
| Known CVEs in native code embedded in the pinned runtimes | unknown (not assessable here) | affects every user of those runtimes | watch upstream advisories; bump pins deliberately; re-run the qualification harness after any bump |
| Upstream publishes `-baseline` variants of the x64 runtime packages, which by convention are for CPUs without AVX2 (not verified here) | medium for older hardware | the launcher resolves the non-baseline package only | not implemented; testers should have a CPU from the last several years; recorded in `SUPPORTED_PLATFORMS.md` |
| Install scripts: the `bun` package finishes its install in a script | low | `--ignore-scripts` installs are untested | stated in `KNOWN_LIMITATIONS.md` |
| Supply chain: dependencies are fetched from the public registry at install time | medium | every install | exact pins; `package-lock` is not shipped, so integrity relies on npm's registry integrity checks; a lockfile or shrinkwrap is a possible hardening |
