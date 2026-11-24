# Bashwink v0.1.0-alpha release readiness

**External release FAIL.** Feature freeze is active. macOS Apple Silicon is the sole
target for this candidate. Support requires complete qualification on a named macOS
build and successful CI at the exact candidate revision.

## Freeze baseline

Preparation is on `codex/v0.1.0-alpha-preparation`, based on
`f69266bd32c63e7820fd58585fb36cb981588d74`. The two reported implementation and
evidence commits, `35a59ec` and `6f7b55f`, are ancestors. The initial tree was clean.
A live remote query showed the original review branch at `d402900a5dc0` and main
at `ce74b4ef98aa`. Preparation preserves both branch histories.

Bun 1.4.4 and OpenCode 2.3.2 remain pinned. On macOS arm64 27.0.1 (26A434),
403 baseline tests passed. Typecheck, Oxlint, formatting, lint negative controls,
documentation, register verification, and native gate tests exited zero.

## Execution order

1. **M1 complete.** Freeze the feature set at release-blocking fixes and record the
   reproducible baseline.
2. **M2 partial.** The VM lab passed a pinned OpenCode TUI coding turn with shell
   approval and verified launcher death. Integrate and qualify the VM backend through
   the installed entry point. Keep product shell admission disabled pending evidence.
3. **M3 partial.** The fixture read two exact files after VM stop. Implement persistent
   guest sessions and stage ownership, bounded project transfer, reviewed host apply,
   and crash reconciliation. The Seatbelt single-file journal and refusal tests passed.
4. **M4–M6.** Integrate one typed provider relay, then stabilize installation and the TUI.
   Bound the actual execution and provider request paths.
5. **M7–M8.** Run the full BW-032 controls on a clean Apple Silicon host without Docker,
   and collect required CI from the candidate SHA.
6. **M9–M11.** Package the qualified code, inspect the archive and notices, install it
   on the clean host, and complete external-user acceptance on those exact bytes.
   Request owner approval only after the executable gate passes.

## Gate invocation

Run `python3 scripts/verify_alpha_release.py --revision <candidate-sha>`. The gate
requires every release check, the macOS-only overlay of the BW-032 matrix, and the
archive SHA-256 tied to the acceptance evidence. Save GitHub's verify workflow run
and job reports for the same SHA beside the release manifest. The gate requires all
existing macOS and Ubuntu verification jobs to conclude successfully. Evidence
collection and publication approval remain owner responsibilities.

The current gate exits 1. No release candidate archive, checksum, or hosted run exists
for this scope. The macOS lab host ran the fixtures without using Docker, which was
present on that host. A clean Docker-free installation remains unverified.

[Acceptance evidence](ACCEPTANCE_RESULTS.md) · [BW-032 acceptance specification](../../BW-032_PLATFORM_QUALIFICATION.md)
