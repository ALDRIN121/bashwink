# Task 5 — package the local engine, preserve the installer

**Branch:** `local-engine/task-0`. Continues from `7bc35ac` (Task 4 complete).
**Commits:** `b28e6a7`.
**Installer: unchanged.** `scripts/build_alpha.sh` and the existing npm route are untouched.

## 1. What the tarball now is

```
tarball  /tmp/t5-npm/bashwink-0.1.0-alpha.1.tgz
sha256   b6bccd7ae734c7c68394f647ba21f0f106334663ea7bb1f566ee0db15e854c63
size     84,910,518 bytes, 21 files
commit   7bc35ac2a68f80fe1f39915fe11c2e1c59e94a1b
```

Contents include `package/libexec/opencode`, `package/engine-manifest.json` and
`package/share/licenses/THIRD_PARTY_NOTICES.txt`.

`release/npm/package.json` no longer declares `@opencode/cli`. `dependencies` is `{"bun": "1.4.4"}`
alone — the engine ships in the tarball, and a registry OpenCode package would be a second,
unverified engine. `grep -c "@opencode" release/npm/package.json` → **0**.

## 2. Installed and started in a clean prefix

```
$ npm install -g ./bashwink-0.1.0-alpha.1.tgz --prefix /tmp/t5-clean-prefix --ignore-scripts
added 3 packages in 4s

$ find /tmp/t5-clean-prefix -path '*@opencode*'
                                    # nothing

$ shasum -a 256 <prefix>/lib/node_modules/bashwink/libexec/opencode
069cb0df31c53985d9d10609c43fea3d699501b9afcde4a4da47779c59d8a20e

$ env -u BASHWINK_OPENCODE_BIN <prefix>/bin/bashwink --version
bashwink 0.1.0-alpha.1

$ env -u BASHWINK_OPENCODE_BIN <prefix>/bin/bashwink doctor
✓ OpenCode runtime: verified local engine …/libexec/opencode (pinned 2.3.2, sha256 069cb0df31c53985…, via manifest)
✓ Bun runtime: bun 1.4.4 on darwin/arm64
```

Lifecycle scripts disabled, no `@opencode` package anywhere in the install, engine digest matching
the shipped manifest, and it starts with `BASHWINK_OPENCODE_BIN` unset.

**A correction to how this was first attempted:** the first install used
`--registry http://127.0.0.1:9/` to prove no registry OpenCode was reachable. It failed — because
`bun` is still a legitimate registry dependency. That was the right failure for the wrong test:
the claim is "no OpenCode from the registry", not "no registry at all". The test above states it
precisely.

## 3. The packager's engine input

`--engine-dir` and `--engine-target` give CI and contributors an explicit artifact directory
instead of a hidden default. `validate_engine_input()` refuses, by name:

- no `engine-manifest.json` → names `scripts/build_local_engine.py --target …`
- unsupported `schemaVersion`
- a manifest whose `target` differs from the requested one (a tarball may only carry an engine for
  the platform it targets)
- an absent digest ("an unverifiable artifact cannot be packaged")
- a missing artifact
- a digest mismatch, naming both digests
- non-empty `ffmpegMarkers`

## 4. Three defects found by building, not by reading

### 4a. The audit applied text-file rules to a compiled binary

The first real tarball failed with:

```
package/libexec/opencode: development-machine path '/Users/aldrinjoseph/'
package/libexec/opencode: development-machine path 'C:\Users\silvi\'
package/libexec/opencode: development-machine path '/home/user/'
package/libexec/opencode: credential-shaped string
```

Every Bun `--compile` binary embeds the build machine's `__dirname` literals and Rust crate paths.
I checked the **published** `v0.1.0-alpha.1` engine rather than assuming:

| String | Published engine |
| --- | --- |
| `/Users/runner/` | 257 |
| `/Users/aldrinjoseph/` | 18 |
| `/Users/kit/` | 6 |
| `C:\Users\silvi\` | present |
| `/home/user/` | 2 |
| `sk-ico...tcut` | present |

So the path rule **could never have passed on a shipped engine** — it had simply never been applied
to `libexec/` before this task. Path rules now apply to text files, where a stray home path is a
real leak, and not to the engine artifact, where they would fail every correct build.

### 4b. The credential pattern matched HTML link relations

The `credential-shaped string` hit was `mask-icon` + `shortcut icon` concatenated in the binary —
the identical false positive exists in the published release. `\b` does not help: `-` is itself a
non-word character, so `\bsk-` matches inside `mask-icon`. The pattern now requires a **non-word
character before** the prefix.

Verified against seven cases rather than asserted:

| Case | Caught |
| --- | --- |
| `sk-ant-api03-…` (real shape) | yes |
| bare `sk-…` at position 0 | yes |
| `ghp_…` | yes |
| `AKIAIOSFODNN7EXAMPLE` | yes |
| PEM header **with** base64 body | yes |
| `…mask-icon…` | no |
| `-----BEGIN PRIVATE KEY-----` header alone | no |

The `\b` version **missed** `sk-ant-api03-…` entirely — my first tightening was weaker than the
pattern it replaced, which the control caught.

### 4c. A PEM header alone is a format literal

Upstream *constructs* PEM blocks, so `-----BEGIN PRIVATE KEY-----` appears four times in the engine
with no key material after it. The pattern now requires an actual base64 body.

## 5. A stale-manifest hazard, closed in the packager

One home path survived a builder fix and was caught only at packaging:

```
package/engine-manifest.json: development-machine path '/Users/aldrinjoseph/'
```

— the `--outdir=…` recorded by a manifest written *before* the builder sanitised it. The packager
now strips `buildResult`, `buildCommand` and `toolchains` itself rather than trusting the builder,
because an older artifact may predate that hygiene. A manifest that ships inside a package should
describe an artifact, not the machine that made it.

## 6. `doctor` reported a working install as broken

Against the clean install, `doctor` said:

```
✗ OpenCode runtime: no OpenCode runtime found (looked for opencode/opencode2 in node_modules/.bin and on PATH).
    fix: bun add @opencode/cli@2.3.2
```

That is wrong twice: the install launches, and the advice installs a registry engine the package
deliberately no longer depends on. `doctor.ts` now verifies the manifest first under
`RELEASE_BUILD || STANDARD_BUILD` and reports the verified digest. Its failure `fix:` line is
build-appropriate too.

## 7. Results by platform

### Apple Silicon (darwin-arm64) — PASSED

Tarball built and audited; installed with scripts disabled into a clean prefix; no `@opencode`
package present; engine digest matches; launches and `doctor` verifies via manifest.

### Windows — NOT ATTEMPTED

No Windows host. Specifically **not** verified: `release/tester-kit/windows-qualify.ps1`, Windows
temporary-path handling (spaces, `%TEMP%`), the native Bun bootstrap with lifecycle scripts
disabled, and `python scripts/build_npm_package.py --install`. The Python `platform_arch()` mapping
returns `win32-<arch>` and is unit-reachable but has never run on Windows. Nothing is claimed.

### Other platforms — NOT ATTEMPTED

darwin-x64 and the four Linux targets: no build, no install, no run.

### Licensing — NOT CONCLUDED

`THIRD_PARTY_NOTICES.txt` ships and the FFmpeg-marker gate is enforced in both the resolver and the
packager. But the manifest's `notices` block remains `null`, and the full native-libraries-vs-notice
inventory comparison has not run. A marker scan is evidence, not clearance.

## 8. Plan bullets not yet done

Task 5 has six bullets; this commit satisfies the engine-input, packaging, and installed-package
portions. Still open:

- **Attestation** binding artifact digest to repo/commit/target/workflow (`scripts/npm_install_check.py`
  on the exact tarball per platform is available but not yet run for each).
- **The prebuilt-route decision** — private artifact store, access, retention, digest trust,
  recovery. Not started, and deliberately not documented as if it existed.
- **Shadow CI staging** before removing the comparison mode.
- **The `--install` wiring** to invoke `scripts/build_local_engine.py` when no current local
  artifact exists.
- **Bun installer consent tests** — unchanged and still passing, but not extended.

## Blockers and next eligible task

- **Banner regression** (`937c496`) still open from Tasks 0 and 4 — blocks a clean Gate E.
- **`notices` unpopulated** in the manifest.
- **npm/node are not on this host's default PATH**; they live at
  `~/.nvm/versions/node/v24.19.0/bin`. The packager's `resolve_bun`/`build_runtime_plan` shell out to
  `npm`/`node`, so a packaging run needs that directory on `PATH`. Worth documenting as a
  prerequisite rather than rediscovering it.

**Next eligible: Task 6**, with the remaining Task 5 bullets (attestation, prebuilt-route decision,
shadow CI) tracked as open rather than assumed complete.
