# Bashwink — Next Steps

**Where we are:** Phase 0, after the final remediation. **8 of 9 tasks Done, 1 In progress.
3 of 4 gate conditions met — the gate still FAILS.**

**Do not begin Phase 1.**

## The single remaining blocker: CI has never run (BW-006)

Everything else in Phase 0 is now evidence-backed. This one is not an engineering problem —
it is an authorisation problem.

**Concretely verified state:**

```
$ git remote -v
(no output — zero remotes configured)
$ gh auth status
You are not logged into any GitHub hosts. To log in, run: gh auth login
```

So CI *cannot* execute until you create a remote and authenticate. Every workflow step has
been run locally instead (47 tests, typecheck, docs, license scope, fixtures, cancellation and
rollback scenarios, secret-scan logic) — but **local success is not evidence that CI passes**.

### Exact actions required from you

1. **Authenticate the GitHub CLI** (or tell me the remote URL to add):
   ```bash
   gh auth login
   ```
2. **Decide the remote target.** No `bashwink` repository exists under the authenticated
   account. Either:
   - create one: `gh repo create <name> --private --source=. --remote=origin`, or
   - give me an existing URL to add as `origin`.
3. **Authorise the push.** Nothing has been pushed and `origin` does not exist. On your word:
   ```bash
   git remote add origin <url>
   git push -u origin main
   ```
4. Watch the run and capture the URL:
   ```bash
   gh run list --workflow=verify.yml
   gh run watch
   ```

I will not create a remote or push without that explicit approval. Once a run exists, BW-006
closes and — if both platform legs pass — the Phase 0 gate becomes passable.

### Risk that the first run will fail

Stated plainly so it is not a surprise: `fixtures/create_fixtures.sh` has **only ever run on
macOS**. Git behaviour, `shasum` vs `sha256sum`, and `sed -i` differ on Ubuntu. Expect the
first Ubuntu fixtures leg to need a fix; that is exactly why the Linux leg exists.

## Secondary gap: single-platform evidence

Everything Bashwink-specific was verified on macOS arm64. The Linux leg exists only as
workflow YAML. Running CI resolves this at the same time.

## Closed across the two remediations

| Item | Resolution |
| --- | --- |
| F-01 retired `macos-14` runner | → `macos-15`; retirement confirmed from GitHub's changelog (2026-11-02) |
| F-02 object/array payload bypass | Bounded on the serialised form, in UTF-8 bytes; 6 regression tests |
| F-03 `note`/raw redaction bypass | One write boundary sanitises every field; 5 regression tests |
| F-04 caret peer, unvalidated packaging | Exact `2.3.2`; clean registry install; plugin shape matches real `Plugin.define` |
| F-05 stale docs/totals | Status block generated from the register; stale claims corrected |
| F-06 zero commits, no ADR owner | Owner assigned; baseline commit; review decisions recorded |
| F-07 LGPL needs a strategy | **ADR-009**: two distribution models; no-FFmpeg build proven; notices generated; release gate exits 0 |
| F-08 silent evidence degradation | Resume verifies the chain; `health` and `verify().limitations` surface it |
| F-09 CI narrower than upstream | Separate `upstream-compat.yml`; a `scope` job states what CI does and does not prove |
| — | **Mock provider defect**: always ran `exit 7` while claiming success. Now `--scenario ok\|fail`, honest in both |
| — | **Fixture scenarios**: cancellation and rollback executed for the first time (8/8) |
| — | **Bun drift**: suite re-run under pinned 1.4.4 (47/47) |

## Not gate blockers, but weak

1. **No-FFmpeg library is not byte-reproducible.** Two clean builds differ in hash because Zig
   embeds 194 absolute paths; size and symbol profile are identical. A release must publish the
   recipe plus a symbol-profile assertion, or wait for path normalisation.
2. **OpenTUI's own native tests** were not run against the no-FFmpeg build — only a TUI smoke
   test.
3. **`@opencode/plugin` runtime** — the registry install typechecked, but the plugin was never
   executed inside a runtime sourced from the registry; the binary still comes from the local
   clone.
4. **Dependency vulnerabilities** — `bun audit` has still never been run.
5. **Inventory regeneration** — `DEPENDENCY_LICENSES.json` is a snapshot and is not regenerated
   by `upstream_sync.py`.
6. **No legal review.** The determination removes known LGPL exposure; it is not legal advice.

## Then, and only then

1. **Phase 1, first task: the wrapper CLI (ADR-003).** Own `--version`/`--help`, forward
   everything else, set `OPENCODE_CONFIG_DIR`, stage the plugin directory contents explicitly
   (config alone does not control loading), exec and propagate exit codes.
2. **Task/run taxonomy on evidence entries** — entries currently carry only call/session IDs.
3. **Concurrency control for the evidence log** (ADR-004) before Phase 4's parallel worktrees.
4. **Publish a per-session head hash** so tail truncation becomes detectable.

## Housekeeping

- The baseline commit exists locally. **Nothing has been pushed.**
- The pinned OpenCode clone lives at `~/Developer/bashwink-upstream/opencode`, outside this
  repository — deliberate, so 2.7 GB of dependencies never enter Git.
- Upstream OpenTUI source for the no-FFmpeg build: clone at `v0.8.4`
  (`d4a2af24ba50636da5f222367f91746a1bf89644`); recipe in `LICENSING_DETERMINATION.md`.
- The 3 upstream bash-3.2 failures stay unpatched by design (BW-002). CI must have bash ≥ 4.
