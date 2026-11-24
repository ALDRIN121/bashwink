# External-alpha gate checklist: standard npm package, candidate `npm-rc1`

An external (invited, other people's machines) alpha needs every row PASS. Today it does not have that.

| # | Gate | Status | Note |
| --- | --- | --- | --- |
| 1 | Tarball builds from a clean commit, byte-reproducibly | **PASS** | `e0a3f48f…d458`, two independent builds identical |
| 2 | Tarball audited: no workspace deps, dev paths, credentials, tests, VM assets | **PASS** | 19 files, audit in the builder |
| 3 | Installs from the tarball with no source checkout (macOS arm64) | **PASS** | |
| 4 | Installed command: version, doctor, refused `--sandbox`, trust question, label, evidence, signal exit, uninstall | **PASS** on macOS arm64 | 27 checks |
| 5 | Same on a clean machine, Windows 11 x64, Linux, macOS Intel | **BLOCKED / NOT_RUN** | no hardware; CI legs written, not run |
| 6 | Live model session with tool calls, edit, approval, resume on the installed package | **BLOCKED** | no key reachable |
| 7 | Standard-mode permission negative tests end to end (denials survive `--auto`, contract denies shell, stale boot evidence rejected) | **NOT_RUN** on the installed package | policy plugin tested in earlier phases only |
| 8 | Minimum quality controls: bounded retries, cancellation, usage/cost visibility | **NOT DONE** | |
| 9 | Hosted CI green on the candidate SHA, all legs, none skipped or cancelled | **NOT_RUN** | push not authorized |
| 10 | Licensing decision for npm-downloaded upstream runtimes (LGPL FFmpeg in stock OpenCode, JSC in Bun) | **OPEN** | notices written; no sign-off |
| 11 | Dependency audit (`npm audit`, transitive licences) of the installed tree | **NOT_RUN** | |
| 12 | Independent review of the security model and the claims in the docs | **NOT_RUN** | |
| 13 | Tester kit: README, guide, limitations, security notes, checksum procedure | **PASS** (written; not yet used by a person other than the author) | |
| 14 | Public npm release | **NOT AUTHORIZED** | `prepublishOnly` blocks `npm publish` |
