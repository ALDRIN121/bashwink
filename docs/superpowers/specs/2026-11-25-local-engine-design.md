# Bashwink local engine design

The current standard installer uses the pinned OpenCode npm runtime. Local engine
bring-up has progressed on Apple Silicon. The companion
[implementation plan](../plans/2026-11-25-local-engine-implementation.md) records where to
resume and what the replacement must prove before cutover.

## Goal

Ship Bashwink as an independent coding product. Bashwink owns its source inputs, builds,
installer, runtime selection, configuration, and release lifecycle. It builds the coding
engine from the required OpenCode source committed to this repo. A normal clone, build,
install, upgrade, and run work without obtaining an OpenCode package or executable or
contacting an OpenCode service. Users continue to choose and authenticate to supported model
providers. The build continues to use pinned third-party tools and libraries.

## Source boundary

- Start from OpenCode v2.3.2, commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`. Its MIT
  license, copyright, and applicable source notices travel with the imported files.
- Import the source under `vendor/engine/` as tracked files in Bashwink's existing Git
  repository. Record the upstream revision, retained files, and any local patches. Resolve the
  retained upstream workspaces locally. Keep internal module names, the provider protocol,
  private plugin interfaces, and session formats where they preserve compatibility. Restrict
  upstream fetches to deliberate maintainer work to refresh the pinned import. Review and
  commit the result before a normal Bashwink build can consume it.
- The declared production workspace closure contains 17 packages: CLI, client, server, TUI,
  core, AI, plugin, browser plugin, protocol, schema, utility, theme, UI, simulation, codemode,
  LaTeX, and Merman. This is the starting set for the build, with additional build inputs such
  as the upstream script workspace, lockfile entries, patches, model snapshot, and assets the
  compiler actually embeds. Determine the final file set by building and running parity tests.
- Keep the native PTY helper that the runtime actually uses. Its source is in
  `packages/process-daemon` at `03d848f7b8d71d31d3e56f2abd8b337efbc1bc32`, the
  `process-daemon-v0.6.0` release. Build it from that source and use the resulting binary.
  Adapt the CLI build and the core PTY binding to resolve this artifact without first loading
  the `@opencode/pty` registry package. Retain its pinned Ghostty input and notices.
- Exclude the standalone web app, desktop app, and unrelated services from the import. The
  upstream build already offers `--skip-web-ui`; Bashwink admits terminal and client commands
  through its private server and refuses upstream service commands such as `serve`.
  Retain required assets and any code imported from those areas by the supported terminal
  flows, if the build or tests establish that they are needed. Hermes Agent stays a design
  reference.

## Bashwink product ownership

| Surface | Shipped behavior |
| --- | --- |
| Command and release identity | Bashwink owns the command, package and artifact names, version shown to users, help, diagnostics, terminal branding, and support links. Preserve upstream credits and source pins in notices and provenance. Preserve internal identifiers when required by the private protocol or stored state. |
| Settings and storage | Bashwink owns the configuration schema, documented settings, profile and project paths, and private service/socket names. Preserve existing Bashwink state and trust where the storage contract allows. Use an explicit, versioned migration if paths or formats change. |
| Models and authentication | Use a Bashwink-maintained local catalog seeded from the pinned snapshot. Support documented providers through explicit configuration and their own authentication. Remove default OpenCode gateway, hosted authentication, catalog refresh, and model aliases that require that service. Tell users when they must choose a provider or model. |
| Updates and network | The installer and documented update command use Bashwink-built, verified artifacts, or build from the checked-out source. Disable imported upstream updater, downloads, telemetry, and other automatic upstream network paths wherever the shipped binary can reach them. Serve config schemas locally. |
| Engine selection | An installed command and `doctor` use the same validated package manifest. The private engine and PTY helper come from the matched Bashwink artifact. A missing, changed, incompatible, or untrusted artifact stops launch with a repair path. |

Expose the supported plugin and configuration interfaces that Bashwink needs today. Audit
preconfigured plugins and their dependency origins before promising migration. When an old
config requests an OpenCode-only service or plugin, explain the unsupported setting and the
Bashwink settings it can use, where applicable. Give users control over any legacy import.
Preserve originals, retain credential references without copying secret values, and validate
existing workspace trust and evidence chains when upgrading or rolling back.

## Integration

Retain the private engine process and the policy and evidence plugin. The launcher selects the
engine built by Bashwink and fails closed if it is missing or cannot establish policy. The
source build, ordinary install, development checks, and CI must resolve the retained OpenCode
code locally, including the plugin and schema that Bashwink uses today. The packaged launcher
resolves the engine, helper, and private plugins through Bashwink's verified artifacts. It
cannot fall back to a PATH binary, runtime override, or upstream download. Keep the optional
VM flow working by building its engine from this same source for the guest target.

Use the pinned upstream build process as the reference for transforms, plugin loading, and
embedded assets. First prove clean source-to-engine builds with the pinned native toolchains.
Keep the current installer active during this work. The independent alpha path starts with
a fresh checkout and the existing build-and-install entry point. Document its pinned
prerequisites and preserve the Bun consent prompt on Windows and macOS. An approved prebuilt
artifact can later provide a lightweight install. Verify such an artifact against Bashwink
release metadata or an attestation bound to its source commit and target before using it.
Rebuild OpenTUI using the no-FFmpeg recipe and make all
native inputs available from a clean checkout or reproducible pinned source preparation.
Include the native dependency inventory for Bun/JavaScriptCore, OpenTUI, and PTY/Ghostty.

## Approaches

The user chose a selective source import with upstream behavior preserved. Copying the whole
repository would add unrelated product surfaces and maintenance. Rewriting the coding loop
would require reimplementing and qualifying the current provider, plugin, and session behavior.
The existing external packages remain the comparison baseline until the local engine passes.

## Cutover gate

1. Prove the first builds on Windows x64 and macOS Apple Silicon. Before switching the default
   standard package, verify the existing target set (both macOS architectures, both Linux
   architectures with glibc and musl, and Windows x64). Rebuild and verify the current Linux
   guest target before switching its engine. Keep gaps explicit and defer cutover while a
   currently advertised target lacks a verified replacement.
2. Verify clean build, install, first run, provider setup, model selection, a coding session,
   upgrade, and rollback with OpenCode downloads and services denied and observed. Audit the
   build graph, artifact manifests, installed dependencies, and network attempts. Demonstrate
   that local modules supply the required APIs and an explicitly configured provider works.
3. Pass the existing Bashwink terminal, provider, permission and denial, evidence,
   cancellation, and session resume checks against the built engine. Run the same scripted
   coding workflow against both engines and verify the resulting files, test outcomes, and
   evidence independently. Verify session compatibility and a live provider on the claimed
   targets before recording those results.
4. Verify Bashwink-owned settings, public names, and upgrade state. Record provenance,
   third-party notices, artifact checksums, and real results. Supersede the
   external dependency decision in ADR-001 after the local cutover is verified. Keep the prior
   package as a comparison and rollback point until then. Hosted and desktop alpha gates
   still need their own results.
