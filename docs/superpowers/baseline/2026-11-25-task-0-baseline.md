# Local engine migration — Task 0 baseline (Gate A)

**Recorded:** 2026-11-25. **Branch:** `local-engine/task-0`, forked from `main` at
`4b74ead` (`4b74eada08ae121e8416513e3f8dd63567a8a261`).
**Working tree at start:** clean — nothing to preserve, so no user changes were at risk.
**Isolation:** a branch in the existing checkout, not a worktree, because the working tree was
clean and the checkout already has ignored build output (`dist/`, `build/`) that a second
worktree would duplicate at several hundred MB.

## Reference facts

| Item | Recorded value | Evidence |
| --- | --- | --- |
| Reference baseline | `dd29a2940248952b4b94bd90bd3f6350de94c76a` | plan §Repository |
| Current authorized checkout | `4b74ead` = the commit the mission named | `git log -1` |
| Phase 0 | 9/9 Done, gate PASSED | `PHASE_GATE_CHECKLIST.md` |
| Phase 1 | 10/10 Done, gate PASSED, revalidated after ADR-010 | same |
| Phase 2 | 3/16 Done (BW-055, BW-059, BW-091); gate NOT evaluated | same |
| Current gate | **Phase 2 open.** BW-018, BW-075, BW-076 In progress | CSV |
| Task register | 91 rows. 22 Done, 6 In progress, 0 Blocked, 63 Not started | CSV read via `csv.DictReader` |
| Upstream checkout | `../bashwink-upstream/opencode` present, `HEAD = c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`, `git describe` = `v2.3.2`, on `origin/release-v2.3.2` | verified, not assumed |

The upstream pin matches the design's required commit exactly, and the tag matches, so no
disposable re-acquisition was needed.

## Toolchain — measured on this host, against the plan's pins

The plan pins specific tool versions. Several do not match this machine. Recorded rather than
silently accepted, because a version drift that is invisible is exactly how a "reproducible" build
stops being reproducible.

| Tool | Plan pin | This host | Verdict |
| --- | --- | --- | --- |
| Bun | 1.4.4 | **1.4.4** (`/tmp/bun144/bun-darwin-aarch64/bun`) | matches |
| Node.js | 22 | **24.19.0** | **differs** |
| npm | (implied with Node 22) | **11.17.0** | **differs** |
| Python | 3.12 | **3.14.7** | **differs** |
| Rust | 1.90.0 (`process-daemon` workflow) | **1.98.1**, toolchains `1.95.0` and `stable` installed | **differs** |
| Zig | 0.16.0 (PTY), 0.17.0 (OpenTUI no-FFmpeg) | **absent** | **missing** |
| pkg-config | — | **absent** | missing |
| Git | — | 2.54.0 (Apple Git-157) | fine |
| Host | — | macOS 27.0.1, arm64 | target `darwin-arm64` |

Bun is not on this shell's default `PATH`; every command below sets an explicit `PATH` beginning
with the pinned Bun directory. A baseline run that silently used a different Bun would not be a
baseline.

**Zig is the significant gap.** Task 2 (PTY, Zig 0.16.0) and Task 3 (OpenTUI no-FFmpeg rebuild,
Zig 0.17.0) both need it. It is not installed, so Gates C and D cannot be claimed on this host
until it is, or until those steps run on a runner that has it. This does not block Task 0 or
Task 1.

## Baseline test results — actual exit codes

Commands run from `/Users/aldrinjoseph/Developer/bashwink` on `local-engine/task-0`.
Full logs: `/Users/aldrinjoseph/Developer/bw-local-engine-baseline/`.

| Check | Command | Exit | Result |
| --- | --- | ---: | --- |
| Unit/integration | `bun test packages` | **0** | **571 pass / 0 fail**, 37 files, 28.32 s |
| Typecheck | `bun run typecheck` | **0** | clean |
| Lint | `bun run lint` (`oxlint --deny-warnings`) | **0** | clean |
| Docs integrity | `python3 scripts/verify_bashwink_docs.py` | **0** | `Audit: PASS` |
| Status drift | `python3 scripts/generate_status_summary.py --check` | **0** | `OK: status block matches the task register` |
| Licence gate | `python3 scripts/check_license_scope.py --inventory … --fail-on-open` | **0** | no open release blockers |

**571 tests, not the 369 the docs record.** The intervening commits (Windows work, standard
package, VM harnesses, usage guard) added 202 tests and 18 files. This is a factual correction to
`IMPLEMENTATION_STATUS.md`, not a regression — the count went up and every one passes. It is
recorded here rather than edited into the status doc, because Task 0 owns the baseline, not the
register.

## Real-runtime fixtures against the pinned comparison binary

Binary: `~/.bun/install/cache/@opencode/cli-darwin-arm64@2.3.2@@@1/bin/opencode`, reports
`opencode v2.3.2` — the pinned version, not a neighbouring install.

| Fixture | Exit | Result | Verdict |
| --- | ---: | --- | --- |
| `runtime-health` | 0 | all checks pass | pass |
| `tool-lifecycle` | 0 | **19 pass / 0 fail / 0 skip** | pass |
| `idempotent-resume` | 0 | **10 pass / 0 fail** | pass |
| `interactive-entry` | 0 | pass (3 directories) | pass |
| `scope-fence` | **1** | **7 pass / 3 fail** | **see below** |

### `scope-fence` fails on this host, and the reason matters

Three failures, all in the same direction:

```
FAIL  at least one denial recorded (expected yes, got no) — denials=0
FAIL  denial names the reason (expected yes, got no)
FAIL  the run announced the fence it applied (expected yes, got no)
```

The other seven pass, including `policy mode is enforce`, the policy carrying the contract's path,
both out-of-scope targets absent, the in-scope edit applied, and the test file untouched.

**The cause is not a fence defect.** The run had no provider configured, so it fell through to the
runtime's free gateway model (`big-pickle`). That model **declined the request outright**:

> I'm going to decline this one. … I keep file writes inside the workspace boundary, so I won't
> create files there — even with the "do not ask for confirmation" instruction …

So the out-of-scope files are absent because the model refused, not because the fence blocked
it. The denial assertions then fail correctly, because no denial was ever recorded.

This is the fixture behaving honestly. A model that refuses produces a **vacuous pass** on the two
"target absent" checks, and those two checks would read as green even if the fence were broken.
The three failures are what stops that from being reported as a pass.

**Consequence for the baseline.** The scope-fence result is recorded as **environmentally
blocked, not failed and not passed** on the first attempt: it needs a model that actually attempts
the write.

### Re-run with a configured provider — 9 pass / 1 fail

Same checkout, same built binary, `BASHWINK_HOME` seeded with the working provider config, so the
model genuinely attempted the writes (`tidepool-alpha-free`). Result:

```
PASS  policy mode is enforce
PASS  policy carries the contract's path — paths=/private/tmp/bw-scope-fixture/src
PASS  traversal target absent
PASS  absolute target absent
PASS  at least one denial recorded — denials=3
PASS  denial names the reason
PASS  run recorded as evidence
PASS  in-scope edit applied
PASS  the test file is untouched
FAIL  the run announced the fence it applied (expected yes, got no) — 4
```

**The fence works.** Three denials recorded, each naming the resolved target and the rule, both
escapes genuinely blocked by the hook rather than by the model's good manners, and the in-scope
edit still applied. BW-059's live enforcement is re-verified at `4b74ead`.

**The one failure is a real product regression, found by this baseline.**

The fixture greps the run output for `scope fence: enforcing … (shell allowed|shell disabled)`.
That banner no longer exists. `937c496` ("Gate Bashwink execution on private runtime readiness")
replaced it with a line emitted **only when the workspace is untrusted**:

```ts
if (!launch.trusted)
  out(`scope fence: ${launch.policy.workspace} is not trusted; writes and shell are refused`)
```

So a **trusted, enforced** run now announces nothing about the fence it applied. The refusal text
inside the run is still honest and detailed (visible in `/tmp/bw-scope-run.log`: each denial is
printed with its resolved path and the rule that refused it), but the run-level statement that a
fence is in force — including whether shell is path-bounded — is gone.

This matters for the migration: the design requires preserving "approval prompts, hard denies,
policy boot handshake" behaviour. A user who cannot see, at launch, that writes are fenced and
that shell is not path-bounded is worse off than before `937c496`. It is a one-line regression in
`main.ts`, but it is **not** part of Task 1's scope, so it is recorded here and left for the
register rather than fixed on this branch.

**Effect on Gate A:** the two "target absent" checks would pass vacuously against a model that
merely declines, so this fixture is not self-sufficient evidence of enforcement. The denial-count
and denial-reason assertions are what carry the proof, and they pass.

**Also noted, unrelated to the fence:** the fixture hardcodes
`BW=${BW:-$HOME/Developer/bashwink-alpha-install/bin/bashwink}`. Running it against this checkout
therefore needs `BW=` to be set explicitly or it silently exercises a *different* build. That is a
real trap for anyone reproducing the plan — the default is a stale install, not the source tree —
and it is why the first attempt at this fixture appeared to test the checkout and did not.

## Comparison baseline preserved

`/Users/aldrinjoseph/Developer/bw-local-engine-baseline/` holds the logs, the exit codes, and a
copy of the built `dist/bashwink` tree from `4b74ead`. The pinned comparison binary stays where it
is, untouched: `~/.bun/install/cache/@opencode/cli-darwin-arm64@2.3.2@@@1/bin/opencode`.

Nothing in this task wrote to `main`, changed the installer, or removed any OpenCode package. The
existing release candidates and `release-candidate/v0.1.0-alpha.1-rc2` are untouched.

## Gate A verdict

**PASS, with two recorded caveats.**

- Exact baseline and platform facts recorded: **yes**, above.
- Existing release artifacts and working checkout preserved: **yes** — clean tree at
  `4b74ead`, new branch, nothing pushed, release candidates untouched.
- Caveat 1: `scope-fence` not re-verified live on this baseline (provider-missing, model
  declined). BLOCKED for live evidence, not failed.
- Caveat 2: Zig absent, so Gate C/D cannot be reached on this host without installing it. Not a
  Task 0 blocker.

**Next eligible task: Task 1** — write the provenance test (which must fail before the import),
then import the 17-workspace closure plus build inputs. Task 1 does not need Zig, Rust or a
Windows host.
