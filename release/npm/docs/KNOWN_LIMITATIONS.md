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
- A shell command you approve can read anything you can read, including other secrets in your environment (for example a
  cloud or Git token). Bashwink removes **its own provider key variables** from the environment of shell commands and
  masks their values in the evidence log; it cannot protect secrets it does not know about.
- The runtime also offers tools that have no execution policy here (arbitrary code execution, web fetch and search,
  sub-agents). Bashwink refuses them by default and asks for nothing; they are not available in this alpha.
- `bashwink --sandbox` is not included and fails closed. The isolated VM is a separate, macOS-only, optional artifact.

## Platforms

- **What has been run.** With a scripted stand-in for the model (not a real one), the installed package completed an
  automated check of install, a coding task, permissions, cancellation and limits on cloud CI machines: macOS 15 (Apple
  Silicon) and Ubuntu (x64) passed all of it. On Windows Server 2025 (x64) most of it passed; it also found two real
  defects (a shell path check that ignored Windows paths, and a `doctor` that could not find `git.exe`), both fixed since
  but **not re-run on a Windows machine**, and some checks there did not run because of a test-script bug, also fixed and
  not re-run. These are cloud runners, not clean desktops. `SUPPORTED_PLATFORMS.md` in the repository documents lists what
  each result covers.
- **What has not.** No physical Windows 11 desktop, Linux desktop, macOS Intel or Windows ARM64 machine has been used. The
  interactive screen was checked automatically in a pseudo-terminal on macOS only; Windows terminal rendering, Ctrl+C in a real
  console and closing the terminal are in the manual checklist and have not been run.
- Windows on ARM64 is refused. Windows x64 is the intended Windows target and has **not been qualified on a physical Windows 11 machine**.
- Node.js and network access to the public npm registry are needed to install (the pinned runtimes are downloaded). Only Node 22 was tested; 18+ is expected to work.
  Installs with `--ignore-scripts` are untested (Bun's own package finishes its install in a script).

## Product

- **Usage limits exist but are not a spending ceiling.** Per launch Bashwink stops work after 300 model requests, 5
  retries of one failing request, and optionally a token or dollar limit (`BASHWINK_MAX_REQUESTS`, `BASHWINK_MAX_RETRIES`,
  `BASHWINK_MAX_TOKENS`, `BASHWINK_MAX_COST_USD`). The request already in flight when a limit is crossed is not recalled,
  and one request can be large. A dollar limit needs a declared price (`bashwink auth add ... --price model=in:out`);
  without one Bashwink refuses to run under it. If a provider reports no usage, token and cost are shown as unknown.
  In the terminal UI the reason for a stop appears when the session ends. **Set a spending limit at your provider too.**
- The usage figures come from the event stream of the private runtime server; if that stream drops, the summary says the
  figures may be too low. They are an estimate from declared prices, never an invoice.
- A live conversation with a real model, tool calls and edits has **not** been run on the installed package.
- Large repositories, monorepos and non-Git folders are untested. Undo is Git.
- Upgrades: reinstalling the same version over an existing install worked on macOS, Ubuntu and Windows runners; upgrading from an earlier version has not been tested.

## Licensing

The runtimes come from the public `bun` and `@opencode/cli` npm packages. The stock OpenCode binaries embed LGPL FFmpeg
libraries and Bun embeds LGPL JavaScriptCore; this private alpha does not claim legal compliance. Neither upstream
package ships a licence or notice file, so Bashwink cannot point you to one inside them; the texts are in the upstream
projects' repositories. Bashwink's own tarball contains no runtime binaries. See
`share/licenses/THIRD_PARTY_NOTICES.txt` and the repository's licensing documents. Do not redistribute this package.
