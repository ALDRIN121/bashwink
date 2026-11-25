import { describe, test } from "bun:test"

/**
 * Platform markers for tests that exercise something one platform does not have. A marked test is reported as
 * skipped, never silently dropped, and the platform that does have the feature still runs it.
 *
 *   posixTest     uses POSIX file modes, signals, a `#!/bin/sh` fake runtime or a Unix socket. The Windows
 *                 equivalent of each behaviour is exercised by running the installed package on Windows
 *                 (scripts/npm_install_check.py, fixtures/release/npm_qual.py), not by these unit tests.
 *   macosDescribe the optional isolated sandbox, which exists only on macOS.
 */
export const POSIX = process.platform !== "win32"
export const MACOS = process.platform === "darwin"
export const posixTest = POSIX ? test : test.skip
export const macosDescribe = MACOS ? describe : describe.skip
export const macosTest = MACOS ? test : test.skip
