# Final alpha qualification report: standard npm package, candidate `npm-rc2`

Continues `FINAL_ALPHA_RELEASE_REPORT.md` (candidate `npm-rc1`, unchanged). Nothing was merged to `main`, force-pushed, published to npm or GitHub,
or uploaded publicly. The repository is private. One branch was pushed, as authorized: `release-candidate/v0.1.0-alpha.1-standard`.

## 1. Candidate

| | |
| --- | --- |
| Version | `0.1.0-alpha.1` (private alpha; candidate identity is the tag, directory, manifest and commit, because the file name is fixed by the install command) |
| Tag (local) | `v0.1.0-alpha.1-npm-rc2` at commit **`cf76323`** (the `npm-rc1`, `rc1`, `rc2` tags are untouched) |
| Source commit | `cf76323f3962ce7d30dcd885cc89e8934438acb4`; the pushed branch head is later (evidence documents only) |
| Reproducible | two independent builds from the clean tree are byte-identical |

## 2. Tarball and 3. checksum

`/Users/aldrinjoseph/Developer/bashwink/release/standard/0.1.0-alpha.1-npm-rc2/bashwink-0.1.0-alpha.1.tgz` (git-ignored, local only), 196,505 bytes, 19 files.
SHA-256 **`486a1da4f571494263af99ddf4806c1367ad5273b031e1034de2b0df2a32a5b2`** (`SHA256SUMS` verified with `shasum -c`). Manifest, dependency audit, hosted-run results and local
results are in the same directory. Compared with `npm-rc1` (`e0a3f48f…`, 187,654 bytes) the contents differ materially (usage guard, credential containment, Windows fixes, notices).

## 4. Windows qualification

Hosted runner only: **Windows Server 2025 x64, build 26100, not Windows 11**, run `45537295390` on `6cb1e87`. Details in `SUPPORTED_PLATFORMS.md`.

| Area | Result |
| --- | --- |
| npm global install, PowerShell and cmd, path with spaces and Unicode | PASS |
| Runtime resolution (`bin/bun.exe`, `bin/opencode.exe`), plugin staging by copy | PASS |
| `USERPROFILE` handling | tester kit PASS (sets neither `HOME` nor `USERPROFILE`); fallback unit-tested; harness sets both |
| Drive letters, junction | PASS |
| Tool execution, permissions, explicit denials, restricted contract, plugin failure, evidence | PASS |
| Session persistence, model switch | PASS |
| Cancellation (console break), run record, no leaked process | PASS |
| Limits (retries, requests, tokens, cost) | PASS |
| Reinstall, uninstall | PASS |
| PowerShell 5.1 tester-kit script | PASS 16, NOT_RUN 1 (optional live step), FAIL 0 |
| Shell guard vs a Windows key-file path | **FAIL**, a real defect (F-11), fixed after the run, **not re-run on Windows** |
| Test-script encoding: the install check's `doctor` comparison (a glyph) and two qualification suites that stopped early | FAIL in the test scripts, fixed, not re-run |
| Terminal rendering, real Ctrl+C, closing the terminal, SmartScreen/antivirus, long paths, AVX2-less CPU | **NOT_RUN** (manual checklist) |
| Windows ARM64 | **not supported**; refused by the launcher; hosted ARM64 not attempted |

## 5. Live-model qualification: BLOCKED

`~/.config/bashwink-qual/commandcode.key` does not exist for this session. Facts, from metadata only (the file was never opened or searched for): effective user
`aldrinjoseph`; `HOME=/Users/aldrinjoseph` (matches the directory service); no sandbox markers in the environment; `~/.config` exists (mode 700) and was last modified
**2026-10-18**, so no `bashwink-qual` directory has ever been created inside it; `ls` of the directory and `stat` of the file both return "No such file or directory". This is not
a permission or isolation block: the file is simply not on this filesystem (it may have been created on another machine, account or environment). No other credential directory was searched.

**Exact minimal action for the owner**, typed in a terminal you control (the key is not echoed, not passed as an argument and not shown to this session):

```sh
mkdir -p ~/.config/bashwink-qual && chmod 700 ~/.config/bashwink-qual
( umask 077; printf 'CommandCode key (hidden): '; stty -echo; IFS= read -r K; stty echo; printf '\n'; printf '%s' "$K" > ~/.config/bashwink-qual/commandcode.key; unset K )
ls -l ~/.config/bashwink-qual/commandcode.key      # expect -rw-------  and a non-zero size
```

Then run (spend capped at 40 requests and 300,000 tokens):
`python3 fixtures/release/npm_live.py release/standard/0.1.0-alpha.1-npm-rc2/bashwink-0.1.0-alpha.1.tgz --key-file ~/.config/bashwink-qual/commandcode.key --model claude-sonnet-5:anthropic --switch-model gpt-6.1-sol:openai --out live.json`
The script checks the key file is mode 600, uses it only as `--key-file`, reads the value only to search for it afterwards, and never prints it.

Until then **nothing here is a live-model result**. What ran instead is a scripted stand-in (OpenAI chat protocol only; the Anthropic protocol has never been exercised against the installed package: F-22).

## 6. Permission negative tests

All against the installed standard package, scripted provider, `--auto` where stated; passing on macOS (local), Ubuntu and macOS hosted (`6cb1e87`), and on Windows hosted for the checks that ran.

| Control | Result |
| --- | --- |
| Untrusted workspace: no write, no command, even with `--auto`; refusal names the trust step | PASS |
| Explicit user denial survives `--auto`; the non-denied control ran | PASS |
| Restricted contract: shell tool not offered; in-scope write ok, out-of-scope refused | PASS |
| Forbidden direct file operations: write outside, read outside (content never reaches the model), own config untouched | PASS |
| Tools with no policy (code execution, web fetch/search): unavailable, no fetch made | PASS |
| Policy plugin failure: exit 3, zero model requests, **after** an earlier run left valid evidence | PASS |
| Foreign listener on the runtime's default port gets no connection | PASS on Ubuntu and macOS hosted runners; NOT_RUN on the developer's Mac (a foreign process holds the port) and on Windows (suite stopped early) |
| Malicious repository: obeying `AGENTS.md` still cannot run an unapproved command; a repository's own config cannot redirect the provider in an untrusted workspace | PASS macOS, Ubuntu; NOT_RUN Windows |
| Credential redaction (env key, key file, evidence, session store) | PASS; found and fixed F-8 |
| `--sandbox` fails closed | PASS |

Standard mode is **not** an OS sandbox. Not claimed, and not tested as a guarantee: that native controls stop every shell-level host access.

## 7. Cost and retry safeguards (BW-075/076 minimum; both tasks stay In progress, acceptance unchanged)

Reads the runtime's own events from the private server; interrupts every active session on a limit; refuses new model work afterwards. Per launch: 300 requests, 5 retries (upstream ceiling 10, measured), optional tokens and dollars
(a dollar limit needs `auth add --price`; without a price it **refuses to run** rather than pretend). Exit 4; summary printed and stored in the run record; unknown usage or price shown as unknown. Measured: retries stop exactly (3 requests for 2 retries);
a request limit of 6 let 7 reach the provider (one in flight), so it is **not a hard ceiling**. BW-075 acceptance ("never launch another paid call once the cap is hit") is not met; BW-076 ("no-progress detector") is not built.
Test-result provenance: the evidence records each shell command with its real exit code; **changed test files are now disclosed** after every run (F-20), but shell-made changes are not detected and nothing protects tests in standard mode.

## 8. Dependency vulnerabilities

`npm audit` over the tarball's 27 resolved packages: **0** (`DEPENDENCY_AUDIT.json`). Covers JavaScript only; native code in the two upstream binaries is **not assessed** (unverified risk). Pins are `bun@1.4.4` and `@opencode/cli@2.3.2`.

## 9. Licensing status

`STANDARD_PACKAGE_LICENSING.md`. Bashwink distributes only its own MIT code plus three bundled MIT packages (licence texts now included, build-enforced). The stock runtimes (LGPL code inside) are fetched by npm from their own
publishers and ship no licence files. ADR-009 applies by analogy: PM-0 mechanics, but the runtimes are hard dependencies, so installing Bashwink causes the stock binaries to be installed. **No legal sign-off.** Technical remediation is not required to begin an invited private alpha;
the owner's recorded acceptance (option A) or the peer-dependency model (option B) is.

## 10. Hosted CI

Private repository; links need the owner's login. Branch `release-candidate/v0.1.0-alpha.1-standard`.

| Run | Commit | Outcome |
| --- | --- | --- |
| https://github.com/ALDRIN121/bashwink/actions/runs/45532539488 | `e810aba` | found 3 failing jobs (Ubuntu VM tests, Windows tests) |
| https://github.com/ALDRIN121/bashwink/actions/runs/45535845018 | `e96fd31` | Windows admission bug (F-9) found |
| https://github.com/ALDRIN121/bashwink/actions/runs/45536611906 | `25db28f` | first Windows install run; `doctor` and harness issues found |
| https://github.com/ALDRIN121/bashwink/actions/runs/45537295390 | `6cb1e87` | **last executed**: macOS, Ubuntu npm-package jobs PASS (10/10, 68/68); Windows 61/64; `cli (ubuntu)` and Windows suites failed on a test I had just added |
| https://github.com/ALDRIN121/bashwink/actions/runs/45538173450 | `b6d06d7` | **did not run**: every job refused ("recent account payments have failed or your spending limit needs to be increased") |

**The candidate `cf76323` has not been verified by hosted CI. Local verification is not hosted CI.** No check was removed or weakened to obtain a result; tests that need POSIX shells, file modes, Unix sockets or the macOS-only sandbox are explicitly marked and show as skipped (71 on Windows, 55 on Linux in the last executed run), never as passed.
A skipped or cancelled job is not a pass. A Windows hosted runner is **not** a Windows 11 interactive qualification.

## 11. Independent audit

`FINAL_ALPHA_AUDIT.md`: all 25 questions answered from evidence, and findings F-8 to F-25 with the required record fields (10 proven defects fixed, 5 limitations disclosed, unverified risks listed).

## 12. Remaining external prerequisites (owner)

1. **Fix GitHub Actions billing / spending limit**, then `gh workflow run verify.yml --ref release-candidate/v0.1.0-alpha.1-standard` and confirm all gating jobs and the Windows legs on `cf76323` or its successor.
2. **Create the key file** (commands in section 5) and run the live script; review the JSON.
3. **A Windows 11 x64 machine** (physical or VM), standard user, no Bun/OpenCode installed: run `release/tester-kit/windows-qualify.ps1` and the checklist; send back the result file.
4. **Licensing decision** (option A, B or C) and counsel's view before anyone outside the invited group receives the package.
5. **A person other than the author** follows the instructions below on a clean machine.
6. Optional: Windows ARM64 hardware (unsupported until then), macOS Intel, Linux desktop.

## 13. Exact tester installation instructions

You were sent `bashwink-0.1.0-alpha.1.tgz` and `SHA256SUMS`. You need Node.js 22 (only 22 was tested), Git and a terminal. Use a throwaway Git project.

macOS / Linux:
```sh
shasum -a 256 -c SHA256SUMS            # must print: bashwink-0.1.0-alpha.1.tgz: OK
npm install -g ./bashwink-0.1.0-alpha.1.tgz
bashwink --version && bashwink doctor
cd my-throwaway-project && bashwink    # answer the trust question; read each approval
```
Windows 11 x64 (PowerShell): `Get-FileHash .\bashwink-0.1.0-alpha.1.tgz` (compare with `SHA256SUMS`), `npm install -g .\bashwink-0.1.0-alpha.1.tgz`, then the kit in `release/tester-kit/` (`README.md`).
Your own provider (key never typed on a command line): `bashwink auth add myprov --base-url <url> --key-file <file only you can read> --model <id>:openai --price <id>=<in>:<out>`, `bashwink model use myprov/<id>`, `bashwink auth check myprov`. Set a spending limit at your provider; Bashwink's limits are not a ceiling.
Remove: `npm uninstall -g bashwink` (your settings and run records stay). Do not disable SmartScreen, Gatekeeper, antivirus or a firewall. Do not redistribute the file.

## Verdicts

| | Verdict |
| --- | --- |
| **PERSONAL USE** (the owner, macOS arm64, supervised, throwaway projects, own spending limit) | **CONDITIONAL**: install, permissions, cancellation, limits and the interactive screen are verified on this Mac; no real model has been used; run the live script first |
| **SUPERVISED INTERNAL ALPHA** | **CONDITIONAL**: same, plus the owner's licensing acceptance |
| **WINDOWS X64 INVITED ALPHA** | **BLOCKED**: needs hosted CI on the candidate (billing), a live run, and one physical Windows 11 run. Nothing found contradicts a later PASS; two real Windows defects were found and fixed; the fixes are not re-verified on Windows |
| **WINDOWS ARM64 INVITED ALPHA** | **FAIL**: refused by design; no qualified execution path |
| **GENERAL PRIVATE EXTERNAL ALPHA** | **FAIL**: mandatory gate items unmet (live model, clean-host evidence, hosted CI on the candidate, other architectures, licensing sign-off) |
| **OPTIONAL SANDBOX DISTRIBUTION** | unchanged and not re-qualified in this stretch: **CONDITIONAL** for the owner's Mac, **FAIL** for external users |
| **PUBLIC NPM RELEASE** | **NOT AUTHORIZED** |

BW-031 and BW-032 remain In progress. No Chat Memory Engine, Rust migration or Bashwink 2.0 was started.
