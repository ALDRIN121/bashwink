<!--
Read CONTRIBUTING.md before filling this in. Two sections are not optional:
  - "Verification" needs real commands and real exit codes, not a summary.
  - "Not verified" is expected. An empty one usually means nothing was actually run.

Do not flip tasks to Done in docs/bashwink/BASHWINK_TASKS_90.csv — state the evidence here.
-->

## What and why

<!-- One or two sentences. What changes, and what problem it removes. Link the issue. -->

Closes #

## How

<!-- The approach, and anything a reviewer would otherwise have to reverse-engineer.
     Call out surprising decisions explicitly rather than hoping they read well. -->

## New or changed tests

<!-- Which test, and confirm you watched it fail without the fix. If the change is docs-only, say so. -->

- [ ] A test covers this, and it fails on `origin/main` without the fix
- [ ] No test was deleted, skipped, or had its assertions reduced
- [ ] Docs/task register touched → `python3 scripts/verify_bashwink_docs.py` prints `Audit: PASS`

## Verification

<!-- Paste the command and its tail output with the exit code. Repeat for each gate you ran. -->

```
$ npm run test:standalone
ℹ pass 58
ℹ fail 0
exit 0
```

## Not verified

<!-- Plain list. "no Windows machine", "no live provider key", "pty unavailable", "did not run e2e".
     Leaving this empty without a reason is treated as an untested change. -->

- 
- 

## Risk and rollback

<!-- What could this break, who would notice, and how is it undone? "None" is an acceptable answer
     for a docs change — say why it is none rather than leaving it blank. -->

## Checklist

- [ ] Claimed in the linked issue and assigned before starting
- [ ] Branch is `<type>/<short-slug>`, commits are `type(scope): subject`
- [ ] Diff is limited to the issue; unrelated cleanups were split out
- [ ] No credentials, keys, or customer data anywhere in the diff or the test fixtures
- [ ] Claims in this description are backed by a command above, not by an adjective
