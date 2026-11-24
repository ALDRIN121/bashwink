# Known limitations: 0.1.0-alpha.1 (standard mode)

## Security model

- **Standard mode is not an operating-system sandbox.** Approved commands run with your full user access to files,
  network and credentials on this computer. Bashwink's controls are: workspace trust, a scope fence on edits, an approval
  for each shell command, and a recorded trail. They reduce mistakes; they do not contain a hostile or confused
  command.
- Prompt-injection in files or web content the model reads can lead it to propose harmful commands. You are the
  control: read approvals.
- The evidence log is hash-chained but **not tamper-proof** and not externally witnessed. Protected tests are
  disclosed to the model like any file in the project unless you keep them out of the working folder; Bashwink does not
  hide them.
- `bashwink --sandbox` is not included and fails closed. The isolated VM is a separate, macOS-only, optional artifact.

## Platforms

- Qualified so far: macOS on Apple Silicon, **install and TUI smoke only**, on the developer's own machine (not a clean
  machine). Linux and Windows: **not yet run**. See `SUPPORTED_PLATFORMS.md` in the repository documents.
- Windows on ARM64 is refused. Windows x64 is the intended Windows target and has **not been qualified**.
- Node.js 18+ and network access to the public npm registry are needed to install (the pinned runtimes are downloaded).
  `--omit=optional` and `--ignore-scripts` installs are not supported targets.

## Product

- No running cost display, per-session spending limit, or retry budget yet; set a limit at your provider.
- A live conversation with a real model, tool calls and edits has **not** been run on the installed package.
- Large repositories, monorepos and non-Git folders are untested. Undo is Git.
- Upgrades: reinstalling over an existing install is untested.

## Licensing

The runtimes come from the public `bun` and `@opencode/cli` npm packages. The stock OpenCode binaries embed LGPL FFmpeg
libraries and Bun embeds LGPL JavaScriptCore; this private alpha does not claim legal compliance. See
`share/licenses/THIRD_PARTY_NOTICES.txt` and the repository's licensing documents. Do not redistribute this package.
