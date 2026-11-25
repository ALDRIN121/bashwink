# Bashwink local engine design

**Status:** Design for implementation planning. Current builds still use the pinned OpenCode npm packages.
The companion [implementation plan](../plans/2026-11-25-local-engine-implementation.md) defines
the first executable milestone and the cutover gates.

## Goal

Build Bashwink's coding engine from the required upstream source kept in this Git repository.
The build and installed CLI must need no OpenCode registry packages or separately installed
OpenCode executable. Keep the current Bashwink terminal experience and workflows.

## Source boundary

- Start from OpenCode v2.3.2, commit `c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`. Its MIT
  license, copyright, and applicable source notices travel with the imported files.
- Import the source under `vendor/engine/` as tracked files in Bashwink's existing Git
  repository. Record the upstream revision, retained files, and any local patches. Resolve the
  retained upstream workspaces locally. Keep existing module names, provider protocol, plugin
  interfaces, and session formats where they are needed for compatibility.
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

## Integration

Retain the private engine process and the policy and evidence plugin. The launcher selects the
engine built by Bashwink and fails closed if it is missing or cannot establish policy. The
source build, ordinary install, development checks, and CI must resolve the retained OpenCode
code locally, including the plugin and schema that Bashwink uses today. The packaged checkout
and launcher cannot fall back to an OpenCode binary on PATH or download an upstream update.
Keep the optional VM flow working by building its engine artifact from this same source for the
guest target.

Use the pinned upstream build process as the reference for transforms, plugin loading, and
embedded assets. First prove clean source-to-engine builds with the pinned native toolchains.
Keep the current installer active during this work. A contributor must be able to build the
engine from the checkout. For the lightweight tester install, prefer a checksum-verified,
Bashwink-built artifact from an approved source in the same private repo. Artifact transport
is a separate decision before cutover. A missing approved artifact blocks the lightweight
installer switch. Apply the existing no-FFmpeg recipe where evidenced, and verify the Windows
build and artifact notices before proposing distribution. Include the native dependency
inventory, including Bun/JavaScriptCore, OpenTUI, and PTY/Ghostty.

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
2. Verify install and launch with OpenCode package downloads blocked and no OpenCode executable
   on PATH. Inspect the lockfile, package graph, and installed artifacts for registry copies of
   OpenCode CLI, plugin, schema, PTY, and platform packages. Verify that locally resolved
   vendored modules still supply the required APIs.
3. Pass the existing Bashwink terminal, provider, permission and denial, evidence,
   cancellation, and session resume checks against the built engine. Run the same scripted
   coding workflow against both engines and verify the resulting files, test outcomes, and
   evidence independently. Verify session compatibility and a live provider on the claimed
   targets before recording those results.
4. Record provenance, third-party notices, artifact checksums, and real results. Supersede the
   external dependency decision in ADR-001 after the local cutover is verified. Keep the prior
   package as a comparison and rollback point until then. Hosted and desktop alpha gates
   still need their own results.
