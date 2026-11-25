# Supported platforms: 0.1.0-alpha.1 standard package (candidate `npm-rc2`)

Verdicts: PASS, FAIL, BLOCKED (needs something the owner must provide), NOT_RUN. Nothing is inferred from a different
platform. **No physical Windows 11 desktop, Linux desktop, macOS Intel or Windows ARM64 machine has been used.** Results come
from the developer's Mac (not a clean machine) and from GitHub-hosted cloud runners (clean images, but not desktops).

Candidate: tag `v0.1.0-alpha.1-npm-rc2`, source commit `cf76323`, SHA-256 `486a1da4f571494263af99ddf4806c1367ad5273b031e1034de2b0df2a32a5b2`.
**Hosted CI has NOT been run on that commit**: GitHub refused to start any job after the earlier runs ("recent account payments
have failed or your spending limit needs to be increased"). The hosted results below are from run `45537295390` on commit
`6cb1e87`; the fixes made after it are verified on the developer's Mac only.

## Results by platform

| Platform | Install | Coding, permissions, cancellation, limits (scripted stand-in for the model) | Interactive screen | Live model |
| --- | --- | --- | --- | --- |
| macOS 15 arm64, hosted runner | **PASS** 10/10 (`6cb1e87`) | **PASS** 68/68 (`6cb1e87`) | NOT_RUN on the runner | BLOCKED (no key file) |
| Ubuntu x64, hosted runner | **PASS** 10/10 (`6cb1e87`) | **PASS** 68/68 incl. the foreign-listener test (`6cb1e87`) | NOT_RUN | BLOCKED |
| **Windows Server 2025 x64** (build 26100), hosted runner; **not Windows 11** | install 9/10: the one failure was the check script decoding a glyph (fixed, not re-run) | **61/64**: 1 real defect found (shell path check missed Windows paths; fixed, not re-run) and 2 suites stopped early on a test-script encoding error (fixed, not re-run) | NOT_RUN: no Windows pseudo-terminal harness; manual checklist only | BLOCKED |
| Windows 11 x64, physical or VM desktop | NOT_RUN | NOT_RUN | NOT_RUN (manual checklist) | BLOCKED |
| macOS arm64, developer's Mac (candidate `cf76323`) | **PASS** 10/10 | **PASS** 71 passed, 0 failed, 1 NOT_RUN (foreign-listener test: the port is held by a foreign process on this Mac) | **PASS** 17/17 PTY smoke (trust question, STANDARD label on screen, evidence, SIGTERM exit 130, second launch, uninstall) | BLOCKED |
| macOS Intel (x64) | NOT_RUN | NOT_RUN | NOT_RUN | BLOCKED |
| Linux arm64, musl, baseline-CPU variants | NOT_RUN | NOT_RUN | NOT_RUN | BLOCKED |
| Windows 11 ARM64 | refused by design (launcher exits 1; unit-tested) | n/a | n/a | n/a |

Windows ARM64 is **not supported and not advertised**. Hosted ARM64 Windows runners were not attempted; the refusal is covered
by unit tests only.

## What the Windows hosted run proved, and what it did not

Proved (run `45537295390`, `6cb1e87`, Windows PowerShell 5.1 and Python 3.12, Node 22.23, standard user = runneradmin):

- `npm install -g <tarball>` works (22 s), from PowerShell and from `cmd.exe`, into a path containing spaces and non-ASCII
  characters; the `bun` and `@opencode/cli-windows-x64` packages contain `bin/bun.exe` and `bin/opencode.exe` as the launcher
  assumes; plugin staging by copy works (the evidence plugin booted and recorded every tool call).
- First-run state is under the user profile and nothing is written to the project. The qualification harness sets both `HOME` and `USERPROFILE`, so it does not by itself prove the `USERPROFILE` fallback; the tester-kit run, which sets neither, reported state under `C:\Users\runneradmin`, and the fallback is unit-tested.
- A scripted coding task completes, with the diff and test result verified independently; session continuation and a model switch
  work; a junction to a project works.
- Cancellation through a console break (`CTRL_BREAK_EVENT`) ends the run in 0.1 s, closes the in-flight model request, finalizes
  the run record as `cancelled`, and leaves no `bun.exe` or `opencode.exe` behind, both when the signal goes to the whole group and
  when it goes to the launcher alone.
- The usage limits, the retry bound, an invalid-limit refusal and a price-less cost-limit refusal behave as on POSIX.
- The environment-variable key is not readable by an approved shell command and is in no recorded file.
- `--sandbox` fails closed (exit 3); reinstall over an existing install and uninstall work.
- The PowerShell tester-kit script ran to completion: 16 PASS, 1 NOT_RUN (the optional live step), 0 FAIL.

Not proved on Windows: the decoy-listener, malicious-repository and sandbox-selection checks and the last two key-file checks
of the qualification harness (the suites stopped early on an encoding error in the harness); the corrected shell path check;
terminal rendering (ConPTY, Windows Terminal, `cmd.exe`, VS Code); real Ctrl+C in a console; closing the terminal window;
SmartScreen and antivirus reactions; long paths (>260 characters); a CPU without AVX2 (upstream publishes `-baseline` runtime
packages that the launcher does not select); case-insensitive path handling in workspace trust beyond what the runs touched.

## Defects found by running on Windows (all fixed in the source; none re-verified on Windows)

1. The admission proxy tested `startsWith("/")` for "directory is inside the workspace", so **every session action was refused on
   Windows**. Found by a unit test on the hosted runner; fixed with `path.isAbsolute`.
2. `doctor` looked for a file named `git` and reported an installed Git as missing (no `PATHEXT`).
3. The shell path guard only treated tokens containing `/` as paths, so Windows paths (`C:\...`, `..\..`) went unseen.
4. The key-file check printed "mode 600" where file modes mean nothing.
5. Contract and plan validation accepted `C:/x` as relative.
6. The launcher called `child.kill()` on Windows, which terminates abruptly and skips cleanup.
7. `Store` left its SQLite handle open when a schema was refused, which blocks deleting the file on Windows.

## Qualification procedure for a physical Windows 11 x64 machine

Use `release/tester-kit/` (README, `windows-qualify.ps1`, `WINDOWS_TESTER_CHECKLIST.md`): Node 22 and Git only, no Python, WSL or
Docker; the script writes a result file with no key in it; the checklist covers the screen, permissions, Ctrl+C, closing the
terminal, sessions, paths and uninstall. Do not disable SmartScreen or antivirus; report any prompt verbatim.
