# Supported platforms: 0.1.0-alpha.1 standard package (candidate `npm-rc1`)

Verdicts are PASS, FAIL, BLOCKED (cannot be run without something the owner must provide) or NOT_RUN. Nothing is
inferred from a different platform. The only host used so far is the developer's own Mac, which is **not** a clean
machine (Docker, Xcode tools, years of state).

| Platform | Install | Launch and TUI | Live model session | Evidence |
| --- | --- | --- | --- | --- |
| macOS 27 on Apple Silicon (arm64) | **PASS** (10/10 portable check; reinstall over an existing install PASS) | **PASS** (17/17 PTY smoke: trust question, STANDARD label on screen, evidence recorded, SIGTERM exit 130, second launch, uninstall) | **BLOCKED** (no provider key reachable) | `release/standard/0.1.0-alpha.1-npm-rc1/*-macos-arm64.json` |
| macOS Intel (x64) | NOT_RUN | NOT_RUN | NOT_RUN | the launcher maps it to `@oven/bun-darwin-x64` / `@opencode/cli-darwin-x64` (unit-tested lookup only) |
| Linux x64 / arm64 (glibc, musl) | NOT_RUN | NOT_RUN | NOT_RUN | lookup unit-tested; CI leg written (`npm-package (ubuntu-latest)`), **never run** (pushing is not authorized) |
| **Windows 11 x64** | NOT_RUN (BLOCKED: no Windows hardware or runner) | NOT_RUN | NOT_RUN | CI leg `npm-package (windows-latest)` written, **never run** |
| Windows 11 ARM64 | refused by design | refused by design | n/a | the launcher exits 1 with a message; unit-tested. Not qualified, so not supported |

## What was done for Windows without a Windows machine

Static work only, and none of it proves Windows works:

- Found and fixed a real defect: with `HOME` unset (the normal Windows case) configuration and data paths fell back to the
  current directory and would have been written into the user's project. They now use `USERPROFILE`, then the OS home.
- Plugins are staged as a **copy** on Windows (symlinks need a privilege ordinary users lack). Tested with a platform override.
- The builder and the install check resolve `npm.cmd`; the install check expects Windows' prefix layout.
- Windows ARM64 is refused explicitly.

## Not verified for Windows (the to-do list for the first Windows run)

ConPTY rendering of the TUI; that the `bun` and `@opencode/cli-windows-x64` packages contain `bin/bun.exe` and
`bin/opencode.exe` as the launcher assumes; signal forwarding (`child.kill` is a forced terminate on Windows, so the
run record may stay `pending` after Ctrl+C); path case-insensitivity in workspace trust; atomic rename over an existing
file in the trust store, evidence and database writes; `bun:sqlite` file locking; how OpenCode's shell tool behaves under
PowerShell or cmd; SmartScreen and antivirus reactions to the downloaded runtimes; long paths.

## Qualification procedure for a Windows 11 x64 host (needs a human with the machine)

1. Use a clean, current Windows 11 x64 install, a standard user account, Node.js 22 LTS, no Bun/OpenCode already installed.
2. `npm install -g .\bashwink-0.1.0-alpha.1.tgz` (do not disable SmartScreen or antivirus; record any prompt).
3. `python scripts\npm_install_check.py <tgz> --out windows-install-check.json` (needs Python 3.12), or run its steps by hand.
4. In a new Git repository: `bashwink`, answer the trust question, confirm `[STANDARD - native, not a sandbox]` is on screen,
   press Ctrl+C, run `bashwink evidence status`, and attach whether the run record says `recorded` or `pending`.
5. Add a provider with a spending-limited key; run one small edit; approve a shell command; confirm it is shown first.
6. `npm uninstall -g bashwink`; confirm config and data stay.
7. Return the JSON, `bashwink doctor` output and any prompts or errors. Record PASS/FAIL per step; do not paraphrase.
