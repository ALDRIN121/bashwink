# ADR-004 — Evidence format: append-only JSONL with a SHA-256 hash chain

**Status:** Accepted and implemented (`packages/bw-evidence`)
**Date:** 2026-11-22
**Decision owner:** Bashwink maintainer (unassigned individual)
**Depends on:** ADR-001, ADR-002
**Evidence:** 32 passing tests incl. tamper detection; live captures in `TEST_EVIDENCE.md`

## Context

Bashwink's product claim is "exact evidence, not model claims". That requires a record that
(a) a reviewer can verify without trusting our code, (b) survives a crash, and (c) cannot be
quietly edited. Candidates:

| Option | Verifiable by third party | Crash-safe | Tamper-evident | Cost |
| --- | --- | --- | --- | --- |
| **JSONL + SHA-256 chain** | Yes (`sha256sum`, any language) | Yes (append-only) | Yes (any edit breaks a hash) | Minimal |
| SQLite + triggers | With our schema | Yes (WAL) | Only if we hash rows | Higher |
| Signed/COSE envelopes | Yes | Yes | Yes, plus key management | Key infra |
| Plain JSON array file | Yes | **No** (rewrite on every append) | No | Low |
| Transparency log (Rekor-style) | Yes, strong | Yes | Yes | External service |

## Decision

Append-only **JSONL**, one self-contained entry per line, each carrying the hash of the
previous entry.

```json
{"v":1,"seq":2,"at":"…","phase":"after","call":{…},
 "payload":{…},"prevHash":"<sha256 of entry 1>","hash":"<sha256 of this entry minus hash>"}
```

Rules, each enforced by a test:

1. **Canonical serialisation.** Object keys sorted before hashing, so the same payload
   always produces the same digest on any platform.
2. **Genesis.** `seq` starts at 1 with `prevHash` = 64 zeros.
3. **Resume, don't fork.** Reopening an existing log continues from its last `seq`/`hash`;
   it never restarts the chain.
4. **Verify from disk only.** `verify()` re-reads the file and recomputes; it trusts no
   in-memory state.
5. **Detect, don't repair.** An edited, deleted, reordered or truncated entry returns
   `{ ok: false, reason, seq }`. Bashwink never silently rewrites a broken chain.
6. **Hash what was redacted, not the secret.** The digest covers the redacted payload, so a
   digest can never be used to confirm a guessed credential.
7. **Truncation is explicit.** `truncated: true` plus `fullDigest` of the untruncated value,
   so a reader knows the text shown is a prefix of something longer.
8. **Collections are not proofs of non-occurrence.** A valid chain proves nothing was
   edited; it cannot prove nothing was omitted from the end. Noted so the product never
   over-claims. (Mitigation for later: publish the head hash per session.)

## Why not sign entries now

Signing adds key management, and a key in the same directory as the log adds little. The
hash chain already makes edits detectable to a reader who holds **any** later hash — which
is the realistic threat (an agent or user editing its own history). Signing is deferred to
Phase 6, recorded in `NEXT_STEPS.md`.

## Consequences

**Positive:** auditable with `sha256sum` and a shell one-liner; trivially streamable; no
database; 32 tests cover tamper, deletion, reordering, truncation and version drift.

**Negative and accepted:**
- Unbounded growth: one entry per hook firing. Mitigation deferred — rotation must preserve
  the chain across files, which needs its own ADR.
- No concurrency control. Two processes appending to one file would interleave. Single-agent
  Phase 0 usage is fine; parallel agents (Phase 4) need per-worktree logs. **This is a known
  gap, not an oversight.**

## Reversal conditions

- Parallel writers become normal → per-worktree logs, or a lock, or SQLite.
- A regulator/auditor requires signatures → add signing without changing the record shape
  (sign `hash`).
