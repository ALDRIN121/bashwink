import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { changedTestFiles, isTestPath, renderTestChanges } from "../src/test-changes.js"

const root = mkdtempSync(path.join(tmpdir(), "bw-testchanges-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("which paths are tests", () => {
  test("common conventions across languages", () => {
    for (const yes of [
      "test.js",
      "tests/a.ts",
      "src/__tests__/x.tsx",
      "pkg/foo.test.ts",
      "pkg/foo.spec.js",
      "test_thing.py",
      "app/thing_test.go",
      "spec/models/user_spec.rb",
      "C:\\proj\\tests\\a.ts",
    ])
      expect(isTestPath(yes)).toBe(true)
    for (const no of ["sum.js", "src/contest.ts", "latest.json", "src/attestation.ts", "README.md"])
      expect(isTestPath(no)).toBe(false)
  })
})

describe("changed test files, from the evidence log", () => {
  const entry = (seq: number, tool: string, input: unknown, phase = "before") =>
    JSON.stringify({ seq, phase, call: { tool }, payload: { input } })
  const file = path.join(root, "evidence.jsonl")

  test("only this run's writes and edits of tests are reported, once each, sorted", () => {
    writeFileSync(
      file,
      [
        entry(1, "edit", { path: "old.test.js" }), // an earlier run
        entry(5, "boot", {}, "boot"),
        entry(6, "edit", { path: "test.js" }),
        entry(7, "write", { path: "tests/new.test.js", content: "x" }),
        entry(8, "edit", { path: "sum.js" }),
        entry(9, "edit", { path: "test.js" }),
        entry(10, "edit", { path: "after.spec.ts" }, "after"), // only `before` entries count
        entry(11, "apply_patch", {
          patchText: "*** Update File: a_test.go\n*** Add File: lib.go\n",
        }),
        entry(12, "shell", { command: "sed -i s/a/b/ test.js" }), // shell changes are not detected
        "{ not json",
      ].join("\n"),
    )
    expect(changedTestFiles(file, 5)).toEqual(["a_test.go", "test.js", "tests/new.test.js"])
  })

  test("nothing changed, or no log, reports nothing", () => {
    writeFileSync(
      file,
      [entry(1, "boot", {}, "boot"), entry(2, "edit", { path: "sum.js" })].join("\n"),
    )
    expect(changedTestFiles(file, 1)).toEqual([])
    expect(changedTestFiles(path.join(root, "missing.jsonl"), 0)).toEqual([])
  })

  test("the note names the files and states what it cannot see", () => {
    const text = renderTestChanges(["test.js"])
    expect(text).toContain("test.js")
    expect(text).toContain("not detected")
    expect(text).toContain("does not protect tests")
  })
})
