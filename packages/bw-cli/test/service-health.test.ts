/**
 * BW-091/beta — diagnosing why a launch produced no evidence.
 *
 * The distinction under test is the one that wasted my time twice: "the agent ran and nothing
 * was recorded" (alarming, and the message must say so) versus "the runtime never started"
 * (an infrastructure problem with a named cause). Reporting the second as the first sends the
 * reader looking in the wrong place, and reporting the first as the second hides real work.
 *
 * Every pattern below is copied from output the pinned 2.3.2 binary actually produced.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { findRuntimeFailure, renderRuntimeFailure } from "../src/service-health.js"

function withLog(body: (file: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "bw-svc-"))
  try {
    writeFileSync(path.join(directory, "opencode.log"), "", "utf8")
    body(path.join(directory, "opencode.log"))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("runtime failure classification", () => {
  test("a held managed port is named with its PID and a way out", () => {
    withLog((file) => {
      writeFileSync(
        file,
        'timestamp=x level=ERROR run=e635 message="cli process failed" cause="Cause([Fail(Error: ' +
          "Managed service port 49374 on 127.0.0.1 is already in use by PID 34369 " +
          '(/path/opencode serve --service).")\n',
      )
      const failure = findRuntimeFailure(file)
      expect(failure?.kind).toBe("service-port-in-use")
      expect(failure?.holderPID).toBe(34369)
      const text = renderRuntimeFailure(failure!)
      expect(text).toContain("49374")
      expect(text).toContain("kill 34369")
    })
  })

  test("an otherwise unexplained server failure is still reported, without inventing a cause", () => {
    withLog((file) => {
      writeFileSync(
        file,
        'message="cli process failed" cause="ServeError: Failed to start server."\n',
      )
      const failure = findRuntimeFailure(file)
      expect(failure?.kind).toBe("server-start-failed")
      // No PID is invented when the runtime did not name one.
      expect(failure?.holderPID).toBeUndefined()
      expect(renderRuntimeFailure(failure!)).toContain("server could not start")
    })
  })

  test("an ordinary model error is not an infrastructure failure", () => {
    withLog((file) => {
      writeFileSync(
        file,
        'message="request failed" cause="ProviderError: rate limited"\n' +
          'message="request failed" cause="ProviderError: Invalid \'Authorization\' header or token."\n',
      )
      // These are the agent's business and the run may well have produced evidence anyway.
      expect(findRuntimeFailure(file)).toBeUndefined()
    })
  })

  test("a healthy log yields no failure", () => {
    withLog((file) => {
      writeFileSync(file, 'level=INFO message="cli starting" version=2.3.2\n')
      expect(findRuntimeFailure(file)).toBeUndefined()
    })
  })

  test("a missing log is not a failure: it is no diagnosis", () => {
    expect(findRuntimeFailure(path.join(tmpdir(), "bw-no-such-log-file"))).toBeUndefined()
  })

  test("only the tail is read, so a huge log does not become a memory problem", () => {
    withLog((file) => {
      writeFileSync(file, "x".repeat(200_000) + "\n" + "irrelevant\n")
      expect(findRuntimeFailure(file)).toBeUndefined()
    })
  })

  test("the most recent failure wins when a log contains several", () => {
    withLog((file) => {
      writeFileSync(
        file,
        "Managed service port 1111 on 127.0.0.1 is already in use by PID 111\n" +
          "Managed service port 2222 on 127.0.0.1 is already in use by PID 222\n",
      )
      // The reader needs the failure that just happened, not the one from earlier.
      expect(findRuntimeFailure(file)?.holderPID).toBe(222)
    })
  })
})
