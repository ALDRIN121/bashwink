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

## 5. Live-model qualification: PASS on macOS arm64 (headless path, both wire protocols); NOT_RUN everywhere else

**How the key became available.** The first attempt found no key file at `~/.config/bashwink-qual/commandcode.key` (metadata only; it never existed on this filesystem). The owner then pointed to the key's
real location, `~/.hermes/.env` (variable `COMMANDCODE_API_KEY`, mode 600, owned by the owner), in a pasted note. The session read **that one variable** from **that one file**, wrote it to a mode-600 file in the session scratchpad,
used it only as `--key-file`, and **deleted the copy afterwards**. The original file was not modified. No other credential file or directory was opened or searched. The value was never printed; only its length (93) and mode were shown.

**Run.** `fixtures/release/npm_live.py` against the installed tarball (SHA-256 `486a1da4…a5b2`) on the developer's Mac (macOS arm64), real endpoint `https://api.commandcode.ai/provider/v1`, models `claude-sonnet-5` (**Anthropic**
messages protocol) and `gpt-6.1-sol` (**OpenAI** chat protocol), fresh install and profile in a path with spaces and non-ASCII characters, limits 40 requests / 300,000 tokens. Result files: `release/standard/0.1.0-alpha.1-npm-rc2/live-macos-arm64/{live.json,live.log}`.

| Check (all against a real model) | Result |
| --- | --- |
| Authentication through `auth check` against the real endpoint | PASS |
| Coding task: run the failing test, fix `sum.js`, run it again (exit 0, 11 s) | PASS |
| The project's test passes when **run independently** afterwards; `git diff` touches only `sum.js`, the test file is unchanged | PASS |
| Output arrived progressively (55 lines, first after 0.2 s, last after 10.6 s; observed, not judged) | PASS |
| Usage summary printed with real figures: `6 model requests of 40 allowed`, `668 input, 370 output`, cached 43,391 read / 3,792 written | PASS |
| With no declared price the cost is shown as `unknown`, never `$0` | PASS |
| Evidence records real tool calls (`edit`, `shell`) attributed to the model; hash chain verifies | PASS |
| Session continuation: a follow-up in the same session knows which file was changed | PASS |
| Model switch inside the session (Anthropic to OpenAI protocol); evidence attributes both models | PASS |
| Cancellation (SIGINT to the process group) ends the run; no runtime or CLI process is left | PASS |
| The key value is in no file under the profile or project and in no output (harness search, then an **independent** scan of 920 files including the repository and `.git`: 0 hits) | PASS |
| Every run record is finalized (5 records) | PASS |

19 passed, 0 failed, 0 not run. An earlier identical run (18/18, before the script was changed to record the usage figures) also passed; both are described here rather than choosing the better one.

**What this does and does not prove.** It proves the installed package completes a real coding task on both wire protocols, switches models, continues sessions, cancels cleanly and keeps the key out of everything it wrote, on one Mac, with one small task.
It does **not** prove: quality on realistic projects; the interactive terminal screen with a live model (the screen was only driven with the scripted provider); live behaviour of the request, token and retry limits (measured with the scripted provider); behaviour under provider rate limits or outages;
the Windows or Linux path with a real model; or how the dollar limit behaves, because no price was declared. Provider billing was not inspected, so the spend is not stated: only the provider's own account shows it, and the request count above is what Bashwink observed.

**A limitation seen in the live figures (F-26).** The token limit counts only uncached input, output and reasoning tokens. In this run that was about 1,000 counted tokens against about 47,000 cache reads and writes. The summary line says so, but the shipped guides do not. A token limit therefore under-states how much the provider processed. It is a design choice (cached reads are usually billed far below normal input), not a bug, but it is not documented in the package and the package was left unchanged here (see section 12).

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
2. ~~Create the key file and run the live script~~ done for macOS arm64 (section 5). Still open: a live run on Windows and Linux, and the interactive screen with a live model, which the owner can do by running `bashwink` in a throwaway project.
3. **A Windows 11 x64 machine** (physical or VM), standard user, no Bun/OpenCode installed: run `release/tester-kit/windows-qualify.ps1` and the checklist; send back the result file.
4. **Licensing decision** (option A, B or C) and counsel's view before anyone outside the invited group receives the package.
5. **A person other than the author** follows the instructions below on a clean machine.
6. Optional: Windows ARM64 hardware (unsupported until then), macOS Intel, Linux desktop.
7. Decide whether the next candidate should carry the one documentation fix from F-26 (the token limit ignores cached tokens). It changes package contents, so it needs a new candidate, a new checksum and a new hosted run; it was not made unprompted.

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
| **PERSONAL USE** (the owner, macOS arm64, supervised, throwaway projects, own spending limit) | **PASS** for the headless `run` path: install, permissions, cancellation, limits and credential handling verified on this Mac, and a real coding task, model switch, continuation and cancellation passed live on both wire protocols (section 5). Limits of that claim: one small task; the interactive screen with a live model was not scripted; Bashwink's limits are not a spending ceiling, so set one at the provider |
| **SUPERVISED INTERNAL ALPHA** | **CONDITIONAL**: the live run is done; still needed: the owner's recorded licensing acceptance, hosted CI on the candidate (billing), and one person other than the author following the instructions on a clean machine |
| **WINDOWS X64 INVITED ALPHA** | **BLOCKED**: needs hosted CI on the candidate (billing), a live run **on Windows** (the live run so far is macOS only), and one physical Windows 11 run. Nothing found contradicts a later PASS; two real Windows defects were found and fixed; the fixes are not re-verified on Windows |
| **WINDOWS ARM64 INVITED ALPHA** | **FAIL**: refused by design; no qualified execution path |
| **GENERAL PRIVATE EXTERNAL ALPHA** | **FAIL**: mandatory gate items unmet (live model beyond one Mac, clean-host evidence, hosted CI on the candidate, other architectures, licensing sign-off) |
| **OPTIONAL SANDBOX DISTRIBUTION** | unchanged and not re-qualified in this stretch: **CONDITIONAL** for the owner's Mac, **FAIL** for external users |
| **PUBLIC NPM RELEASE** | **NOT AUTHORIZED** |

BW-031 and BW-032 remain In progress. No Chat Memory Engine, Rust migration or Bashwink 2.0 was started.
