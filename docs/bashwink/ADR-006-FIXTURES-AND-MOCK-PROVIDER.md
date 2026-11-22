# ADR-006 — Deterministic local fixtures and a mock provider instead of real model calls

**Status:** Accepted and implemented (`fixtures/`)
**Date:** 2026-11-22
**Decision owner:** Bashwink maintainer (unassigned individual)
**Depends on:** ADR-001, ADR-004
**Evidence:** `TEST_EVIDENCE.md` BW-007; 6 fixture runs with observed exit codes

## Context

Bashwink's gate depends on proving the agent gets things *right*: doesn't edit during
exploration, fixes the implementation instead of the test, leaves a clean state when killed,
and reverts exactly. Proving that needs a target repository whose correct answer is known
and whose starting state is exact.

Options: real repositories (unstable, huge, licensing), hand-made tarballs (no history, no
reset semantics), or **Git repositories at a fixed commit**.

Separately, driving an agent normally needs a paid model. That makes CI slow, costly,
non-deterministic and credential-dependent.

## Decision

### Fixtures: five Git repos, fixed commit metadata, baseline recorded outside the repo

| Fixture | Behaviour under test |
| --- | --- |
| `read-only-explore` | Investigate and answer without writing anything |
| `one-file-edit` | Make exactly one intended change (`sub(a,b)` returns `b-a`) |
| `failed-test` | Fix the **implementation**; the test encodes the contract and must not be weakened |
| `cancellation` | Interrupt mid-run; leave a clean, resumable state |
| `rollback` | Revert to baseline byte-for-byte |

Rules, each discovered by breaking them first:

1. **Fixed identity and timestamps** (`Bashwink Fixtures <fixtures@bashwink.invalid>`,
   `2026-01-01T00:00:00+0000`) so commit SHAs are reproducible.
2. **Baseline SHAs live in `fixtures/BASELINES.txt`, outside each fixture.** A file *inside*
   a repo cannot record that repo's own commit hash — writing it changes the hash — and it
   would be deleted by `git clean -fd`. Both failures were hit before this rule existed.
3. **Fixtures are generated, not committed.** `.gitignore` excludes `fixtures/*/`; CI
   recreates them. This avoids nested-repository/submodule breakage.
4. **`reset.sh` proves the reset.** It compares HEAD to the manifest *and* asserts the
   working tree is clean. `--check` originally passed on a dirty tree because it only looked
   at HEAD; that is now a controlled failure in CI.
5. **A fixture's documented failure must reproduce.** CI asserts `failed-test` *fails* at
   baseline — if it ever passes, the fixture stopped reproducing the bug and is worthless.

### Provider: a local deterministic mock, state-machined on the conversation

`fixtures/mock_provider.py` speaks the OpenAI chat-completions streaming protocol:

- Turn 1 (no tool result yet) → emit a tool call for the shell tool the client actually
  advertised (`shell` for OpenCode, `execute` for code-mode).
- Turn 2 (tool result present) → emit a final message.
- **It chooses from the offered tool list** rather than hardcoding a name. The first version
  hardcoded `bash`, which OpenCode does not expose; the run silently did nothing. Selecting
  from the offered set means the mock can only call a tool the agent really has, which is
  what makes the smoke test meaningful.

Observed live: tool call issued → shell executed `printf 'bw-mock-ok\n'` → output captured
→ evidence recorded `before`/`after` with `exit=0`; with the failing variant, `exit=7`.

## Consequences

**Positive:** the whole Phase 0 gate runs offline, in seconds, with no API key; the negative
paths (`exit=7`, denied call) are as easy to exercise as the happy path.

**Negative and accepted:**
- The mock is not a model. It cannot test reasoning quality, only plumbing. Benchmark work
  (Phase 5) still needs real models.
- It pins a protocol shape: if upstream changes its request/response handling, the mock must
  follow. It did already — the tool-selection bug above.
- Fixed commit timestamps mean fixtures cannot test date-sensitive behaviour.

## Reversal conditions

- If fixture behaviour diverges from real-model behaviour in a way that matters, add a
  *recorded* real-model transcript fixture alongside (not instead of) the mock.
- If concurrency testing is needed, fixtures must move to per-run temporary clones; the
  shared in-place reset is single-writer by design.
