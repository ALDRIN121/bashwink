# ADR-007 — Evidence recorder: bound bytes, sanitise at one boundary, report degradation

**Status:** Accepted
**Date:** 2026-11-23
**Owner:** Aldrin Joseph
**Supersedes:** the recorder behaviour described in ADR-004 (the record *format* is unchanged)
**Evidence:** `TEST_EVIDENCE.md`; 15 regression tests reproducing independent-review findings
F-02, F-03 and F-08; `packages/bw-evidence/src/recorder.ts`

## Context

An independent review of the Phase 0 package reproduced three real defects in the recorder.
All three were re-reproduced here against the delivered code before any fix, with these
observed values:

| Defect | Reproduced behaviour |
| --- | --- |
| **F-02** object payloads bypassed the size cap | `normalise({nested:{message:'x'.repeat(10000)}}, 100)` → **10,025 bytes stored**, `truncated: true` |
| **F-02** arrays likewise | a 2,000-element array → **134,891 bytes stored** |
| **F-02** multibyte counted wrong | 5,000 `€` under a 100 cap → **15,008 bytes stored** |
| **F-03** `note` bypassed redaction | a Bearer token in `note` **was present on disk** |
| **F-03** raw `record()` bypassed redaction | a token passed as `output` reached disk verbatim |

The cause of F-02 was a single expression: `value: typeof safe === "string" ? … : safe`. The
cap applied only when the payload *was* a string; anything structured was returned whole while
the entry still advertised `truncated: true` — the worst combination, since it looked
protected.

The cause of F-03 was that sanitisation lived in `recordTool()`, a convenience wrapper, while
the real writer `record()` accepted an arbitrary payload. Two entrypoints meant two chances to
forget.

## Decision

**1. Bound the serialised form, in bytes.**
`normalise()` measures `Buffer.byteLength` of the serialised payload. A truncated string stays
a string; a truncated object becomes a bounded JSON *string* rather than a truncated object,
because a partially-serialised object is not parseable and must not masquerade as one.

**2. Truncate on code points, not code units.**
`truncateBytes()` walks `for (const char of text)`, so a surrogate pair is never split. Slicing
by UTF-16 index at a byte budget is wrong twice: it can exceed the byte budget and it can emit
a lone surrogate that is not valid UTF-8.

**3. Hash the full redacted value, always.**
`fullDigest` is computed over the *untruncated, redacted* serialisation, so truncation is
provable rather than lossy, and a digest can never be used to confirm a guessed secret.

**4. One write boundary.**
`record()` is the only path to disk. It calls `sanitisePayload()`, which redacts and bounds
**every** field — `input`, `output`, `note` — and redacts `call` metadata. `recordTool()` is
now a thin alias, so it cannot drift from the raw path. No caller can route around
sanitisation by choosing a different field or a different function.

**5. Degradation is visible, never silent.**
`resume()` verifies the whole chain before trusting its head; a log that fails verification is
not extended and `health` reports `ok: false` with the reason. `verify()` returns a
`limitations` array on every success, naming tail truncation and the absence of signing, so no
caller can present a valid prefix as a complete, immutable record.

## Consequences

**Positive:** all five reproduced defects are fixed and pinned by tests; a future change that
reintroduces an unbounded field or an unredacted path fails CI.

**Negative and accepted:**
- A truncated structured payload is stored as a JSON string, so a reader must check `truncated`
  before `JSON.parse`ing `input`/`output`. This is a deliberate trade: boundedness is a security
  property, parseability of a *truncated* value is not.
- `maxText` now means bytes, not characters. A value of 2,000 holds at most 2,000 bytes, which
  is fewer than 2,000 characters for any non-ASCII text. This is the correct behaviour for a
  size limit but is a semantic change from the documented "characters".
- Redaction remains pattern-based. An unrecognised credential shape under an innocuous key can
  still be stored. Claiming otherwise would be the same overreach the review objected to.

**Not fixed, by design:** a hash chain cannot detect a wholly deleted tail, and an unkeyed
chain can be recomputed by anyone with write access. Both are stated in `verify().limitations`
and remain accepted limitations (ADR-004), not bugs to paper over.

## Reversal conditions

- If signing is added (Phase 6), `verify()` gains a real authenticity claim and the
  corresponding limitation entry is removed.
- If per-session head-hash publication is implemented, the tail-truncation limitation narrows
  to "truncation before the published head".
