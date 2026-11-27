# Bashwink

An evidence-first coding agent: it records what it actually did — commands, exit codes and
outputs, hash-chained and independently verifiable — instead of reporting what it claims to
have done.

**Status:** Standalone alpha **`v0.2.0-alpha.2`** ([ADR-015](docs/bashwink/ADR-015-STANDALONE-CODING-ALPHA.md)) runs purely on Node.js 22+ and npm without OpenCode, Hermes, Pi, or Bun. Phase 0 and Phase 1 are gate-passed for the historical OpenCode substrate; the Phase 2 gate remains open. See [implementation status](docs/bashwink/IMPLEMENTATION_STATUS.md), [supported platforms](docs/bashwink/SUPPORTED_PLATFORMS.md), and [next steps](docs/bashwink/NEXT_STEPS.md).

## Set up Bashwink with an AI agent

Any assistant that can run commands on your computer can do the whole setup. Paste
this one line:

```text
Read the "Set up Bashwink with an AI agent" section of https://github.com/ALDRIN121/bashwink and follow it to install and verify Bashwink on this computer.
```

Everything the assistant needs is below. You can follow it yourself too; the
[manual quick start](#v020-alpha2-quick-start-standalone-checkout-install) is the
shorter path if Git and Node.js are already installed.

### Instructions for the assistant

You are installing the standalone Bashwink CLI on the machine you are running on.
Work through the steps in order, and do not report a step as done until its output
confirms it.

**Ground rules**

- Confirm your terminal runs on the user's computer, not a remote sandbox. If you
  cannot run commands there, give the user the commands for their OS one step at a
  time and ask for the output before continuing.
- Use only https://github.com/ALDRIN121/bashwink as the Bashwink source.
- Before installing or upgrading anything, show what will change and wait for
  approval. Keep tools that already meet the requirements.
- Do not run anything with elevated privileges except the distro package-manager
  install in step 2, and ask first.
- Do not change security settings, and do not edit PATH permanently as a workaround.

**1. Identify the platform**

Windows → PowerShell. macOS → zsh or bash. Linux → bash. State which one you
detected before continuing.

**2. Check the prerequisites**

Run `git --version`, `node --version`, and `npm --version` (`npm.cmd` in
PowerShell). Bashwink needs Git, Node.js >= 22.13.0, and npm >= 10. Install only
what is missing or too old, after approval:

- **Windows, Git:** `winget install --id Git.Git -e --source winget` if WinGet is
  available, otherwise https://git-scm.com/install/windows.
- **macOS, Git:** `brew install git` if Homebrew is already installed, otherwise
  `xcode-select --install` and let the user finish Apple's dialog.
- **Linux, Git:** the distro package manager — `sudo apt install git`
  (Debian/Ubuntu), `sudo dnf install git` (Fedora/RHEL), or `sudo pacman -S git`
  (Arch). Do not guess a distro you could not detect.
- **Node.js and npm:** use the user's existing version manager (nvm, fnm, Volta) to
  select a compatible LTS. Otherwise point them at the official installer for their
  OS and architecture: https://nodejs.org/en/download. On Linux, prefer nvm or the
  official tarball over a distro package, which is often older than 22.13.0.

Hand off installer dialogs and sudo password prompts. Recheck the three versions in
a fresh terminal.

**3. Clone the repository**

Ask the user which parent folder to use, then run:

```sh
git clone https://github.com/ALDRIN121/bashwink.git bashwink
```

Enter the new `bashwink` folder. If it already exists, check its remote and status,
and ask before reusing it. Do not overwrite, reset, or create a nested clone.

**4. Install**

Show the global npm prefix (`npm prefix -g`, or `npm.cmd prefix -g` in PowerShell)
so the user knows where the command will land, then run this from the repository
root:

```sh
npm run install:local
```

In PowerShell use `npm.cmd run install:local`. Use the checkout installer, not a
package from the registry.

On Linux or macOS, if the global install fails with a permission error, do not fall
back to sudo: set a user-level prefix with `npm config set prefix ~/.npm-global`,
add `~/.npm-global/bin` to PATH, and retry.

**5. Verify**

In a fresh terminal:

```sh
bashwink --version
bashwink doctor
```

If `bashwink` is not on PATH, run the launcher by full path: `<prefix>\bashwink.cmd`
on Windows, `<prefix>/bin/bashwink` on macOS and Linux. An unconfigured provider is
expected at this point.

**6. Hand off first-time setup**

Start `bashwink setup` in the user's terminal, or tell them to run it. They choose
the provider, model, and credential reference themselves. Do not ask for API keys in
chat, and do not grant workspace trust on their behalf.

**Report**

List the OS, checkout path, installed version, and `doctor` result. Mark provider
setup separately as complete, pending, or not verified. If a command fails, stop at
that step and show the command, exit code, and relevant error without exposing
secrets.

## v0.2.0-alpha.2 quick start (standalone checkout install)

### 1. Prerequisites

Install only:

- **Node.js >= 22.13.0** and **npm >= 10** (`https://nodejs.org/`)
- **Git** (recommended for workspace repositories and diff inspection)

No external OpenCode, Hermes, Pi, Bun, Python, Rust, or Zig installation is required.

### 2. Install

From the repository root (same command on macOS, Linux, and Windows PowerShell):

```sh
npm run install:local
```

This transpiles the zero-dependency standalone bundle using Node.js >=22.13.0, audits the tarball (verifying zero third-party or upstream runtime dependencies), builds `build/standalone/bashwink-0.2.0-alpha.2.tgz`, and installs `bashwink` globally via `npm install -g`.

Verify the installation:

```sh
bashwink --version
bashwink doctor
```

### 3. Configure and launch `bashwink`

Open a fresh terminal inside any project directory and type:

```sh
bashwink
```

On a clean profile (`standalone.json` absent), Bashwink starts in first-time setup with no provider or model selected (ignoring `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CMD_API_KEY`, or OpenCode/Hermes/Pi configs). Choose a hosted (`https://`) or local (`127.0.0.1` / `localhost` / `::1`) OpenAI-compatible endpoint, model ID, and credential mode (None, environment variable name, or key file path), then confirm saving.

Zero outbound network requests are sent during install, startup, or setup. Cancelling setup writes no partial profile. Use `bashwink setup` later to update or switch providers.

### 4. Complete your first coding task

After accepting workspace trust (`y` to permit edits/commands; `N` for read-only mode), type a prompt such as `fix the failing test`. Bashwink exposes four built-in tools (`list_files`, `read_file`, `edit_file`, `run_command`), previews diffs before edits, asks before running commands (warning that approved commands run with host access, not an OS sandbox), records a hash-chained evidence log (`bashwink evidence verify`), and reports changed files and actual command exit codes.

### 5. Uninstall

```sh
npm uninstall -g bashwink
```

This removes the `bashwink` command while preserving your configuration, trust decisions, run records, and evidence logs under `~/.config/bashwink` and `~/.local/share/bashwink` (or `%APPDATA%/bashwink` on Windows, unless overridden with `BASHWINK_HOME`).

### Verification commands

```sh
npm run test:standalone               # Unit and task-loop tests (Node >=22.13.0)
npm run test:standalone:install       # Tarball install, space path, upgrade, corrupt-tarball, uninstall
npm run test:standalone:e2e           # Installed PTY onboarding, zero-request check, red->green, decline, Ctrl+C (macOS/Linux)
npm run test:standalone:independence  # Clean clone without vendor/, node_modules/, OpenCode, Hermes, Pi, or Bun
```

The earlier fork-based `0.1.0-alpha.1` build artifacts remain pinned as the rollback baseline in [ADR-015](docs/bashwink/ADR-015-STANDALONE-CODING-ALPHA.md).

## Layout

```text
bashwink/
  packages/bw-cli/src/standalone/  Standalone Node >=22.13.0 CLI, setup, HTTP provider, 4-tool loop, terminal UI
  packages/bw-cli/src/{paths,trust,test-changes}.ts
                                   Reused workspace trust, XDG/`BASHWINK_HOME` path resolution, test-path detection
  packages/bw-evidence/src/        Hash-chained evidence recorder (`recorder.ts`) and physical path boundary (`scope.ts`)
  scripts/standalone/              Pure-Node build, audit, install, PTY/ConPTY E2E, and physical-absence checks
  release/npm/                     Standalone npm package metadata, notices, and tester docs (`0.2.0-alpha.2`)
  docs/bashwink/                   ADRs, dependency inventory, phase plan, status and test registers
  .github/workflows/               CI (`verify.yml`, including `standalone` Node 22.13.0 / 22 matrix)
  vendor/engine/                   Historical v0.1.0-alpha.1 OpenCode fork tree (excluded from standalone builds)
```

## Standalone CLI commands (`v0.2.0-alpha.2`)

| Command | Purpose |
| --- | --- |
| `bashwink` | Open first-time setup (if unconfigured) or start interactive task prompt in current directory |
| `bashwink setup` | Configure or change hosted/local endpoint, model ID, and credential reference (0 requests sent) |
| `bashwink doctor` | Verify Node `>=22.13.0`, saved profile, credential reference, workspace trust, and `evidence.jsonl` |
| `bashwink trust [dir] --by <name>` | Grant interactive edit/command trust for a workspace directory |
| `bashwink evidence verify [file]` | Verify the SHA-256 hash chain of `evidence.jsonl` |
| `bashwink --version` / `--help` | Print version or CLI usage |

Interactive commands inside `bashwink`: `/setup`, `/trust`, `/help`, `/exit` (`Ctrl+C` cancels the active request/command or exits cleanly at prompt).

## Architecture, seams, and evidence

- **Explicit provider setup (`standalone.json`):** No provider or model is selected automatically from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CMD_API_KEY`, or external `~/.opencode` / `~/.hermes` / `~/.pi` files. Zero outbound connections happen during install, launch, setup, or cancellation.
- **Credentials without key storage:** Config stores either no key (`kind: "none"`), an env variable name (`kind: "env"`), or a key file path (`kind: "file"`). Shell commands run via `shell: false` with provider and secret env vars scrubbed, and literal secrets redacted before hashing into `evidence.jsonl`.
- **Budgets & loop protection:** Pre-flight checks before each model request enforce `maxRequests`, `maxOutputTokens` remaining allowance (`maxOutputTokens - totalOutput`), and `maxCostUsd` (requiring declared pricing, accounting for estimated input cost + remaining output allowance), plus stopping after 3 consecutive identical tool failures.
- **Future integrations cleanly decoupled:** [task-loop.ts](packages/bw-cli/src/standalone/task-loop.ts) emits typed `TaskEvent`s and accepts an optional workspace-scoped `ContextProvider` (filtering foreign workspaces and labeling retrieved context untrusted) independently of [terminal.ts](packages/bw-cli/src/standalone/terminal.ts) and [provider.ts](packages/bw-cli/src/standalone/provider.ts).
- **Evidence log:** `EvidenceRecorder` appends hash-chained tool and model records to `evidence.jsonl` under `$BASHWINK_HOME/data/evidence` (or your platform data directory). Hash chaining detects in-place corruption or reordering, not tail truncation or rewriting by the same OS user.

## Development and local verification

```sh
npm run test:standalone               # Unit, provider, scope, and cost-cap regression tests
npm run test:standalone:install       # Tarball build, audit, space prefix, upgrade, corrupt tarball, uninstall
npm run test:standalone:e2e           # PTY/ConPTY onboarding, egress probe, Git red->green, decline, exit 9, Ctrl+C
npm run test:standalone:independence  # Clean clone omitting vendor/, node_modules/, build/, OpenCode, Hermes, Pi, Bun
```

Typecheck and lint (with dev dependencies installed):

```sh
./node_modules/.bin/tsc -p packages/bw-cli/tsconfig.standalone.json
./node_modules/.bin/oxlint --deny-warnings packages/bw-cli/src/standalone packages/bw-cli/test/standalone
python3 scripts/verify_bashwink_docs.py --check-manifest
```

## Known limitations

- **Not an OS sandbox:** Workspace trust, diff previews, command confirmations, symlink/`.git`/protected-root checks reduce accidents, but approved shell commands execute with your OS user permissions. `bashwink --sandbox` is not shipped in standalone `0.2.0-alpha.1` and fails closed with exit `3`.
- **OpenAI-compatible endpoint scope:** Talks HTTPS (hosted) or loopback HTTP/HTTPS (local) Chat Completions; multi-agent workers and MCP servers remain out of scope for this foreground single-task alpha.
- **Platform verification status:** Qualified locally on macOS Apple Silicon (`darwin-arm64`) on both Node `v22.13.0` and `v22.23.2`. Windows x64 (`win32-x64`), macOS Intel (`darwin-x64`), Linux x64/ARM64 (glibc & musl) remain **UNVERIFIED** until run on those hosts/runners; see [supported platforms](docs/bashwink/SUPPORTED_PLATFORMS.md).
- **Historical fork baseline:** Legacy `v0.1.0-alpha.1` scripts and `vendor/engine/` are retained only as the documented rollback baseline ([ADR-015](docs/bashwink/ADR-015-STANDALONE-CODING-ALPHA.md), `e4d675111fc93906803dd638af4d36eaf6ad91f0`). Do not use `scripts/build_npm_package.py` on `main`; use `npm run install:local`.

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.txt](release/npm/THIRD_PARTY_NOTICES.txt) (zero third-party runtime dependencies; attributed MIT ports from OpenCode `c0ad18b` and Pi `b882d08`).
