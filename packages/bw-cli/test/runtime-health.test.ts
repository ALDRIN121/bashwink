/**
 * Runtime health: plugin resolution and the boot-record handshake.
 *
 * These tests cover the two halves of the silent-failure fix:
 *   1. `resolvePluginEntry` must mirror OpenCode's own resolution, so a directory the runtime
 *      would drop is rejected at staging instead of producing an empty evidence log;
 *   2. the run record must say whether evidence was expected and whether it arrived.
 *
 * The real-binary end-to-end proof lives in `fixtures/runtime-health/run.sh`; these tests
 * are the fast, exhaustive negative controls for the same rules.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EvidenceRecorder } from "@bashwink/evidence"
import { PluginEntryError, resolvePluginEntry, stagePlugins, type Paths } from "../src/paths.js"
import {
  beginRun,
  checkBoot,
  finishRun,
  newRunId,
  readRunRecord,
  recentRuns,
  runRecordFile,
  runsDir,
} from "../src/run-health.js"

interface Temp {
  readonly root: string
  readonly cleanup: () => void
}

function temp(): Temp {
  const root = mkdtempSync(path.join(tmpdir(), "bw-health-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function pluginDirectory(root: string, manifest: unknown, files: Record<string, string>): string {
  const directory = path.join(root, "plugin")
  mkdirSync(directory, { recursive: true })
  if (manifest !== undefined)
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(manifest, null, 2), "utf8")
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(directory, relative)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content, "utf8")
  }
  return directory
}

function resolvedPaths(root: string): Paths {
  const data = path.join(root, "data")
  return {
    config: path.join(root, "config"),
    data,
    cache: path.join(root, "cache"),
    state: path.join(root, "state"),
    database: path.join(data, "bashwink.sqlite"),
    evidence: path.join(data, "evidence"),
  }
}

describe("resolvePluginEntry — mirror the runtime's resolution", () => {
  test("resolves the '.' target of an exports map", () => {
    const t = temp()
    try {
      const directory = pluginDirectory(
        t.root,
        { name: "@bashwink/evidence", type: "module", exports: { ".": "./src/index.ts" } },
        { "src/index.ts": "export default {}\n" },
      )
      expect(resolvePluginEntry(directory)).toBe(path.join(directory, "src/index.ts"))
    } finally {
      t.cleanup()
    }
  })

  test("resolves an exports string and a conditional object", () => {
    const t = temp()
    try {
      const asString = pluginDirectory(
        path.join(t.root, "string"),
        { name: "p", exports: "./dist/index.js" },
        { "dist/index.js": "export default {}\n" },
      )
      expect(resolvePluginEntry(asString)).toBe(path.join(asString, "dist/index.js"))

      const conditional = pluginDirectory(
        path.join(t.root, "conditional"),
        { name: "p", exports: { ".": { import: "./dist/index.mjs", default: "./dist/index.js" } } },
        { "dist/index.mjs": "export default {}\n", "dist/index.js": "export default {}\n" },
      )
      expect(resolvePluginEntry(conditional)).toBe(path.join(conditional, "dist/index.mjs"))
    } finally {
      t.cleanup()
    }
  })

  test("falls back to a root index file when there is no exports map", () => {
    const t = temp()
    try {
      const directory = pluginDirectory(
        t.root,
        { name: "p" },
        { "index.ts": "export default {}\n" },
      )
      expect(resolvePluginEntry(directory)).toBe(path.join(directory, "index.ts"))
    } finally {
      t.cleanup()
    }
  })

  test("refuses src/index.ts without an exports map — the case the runtime drops silently", () => {
    const t = temp()
    try {
      const directory = pluginDirectory(
        t.root,
        { name: "p", type: "module" },
        {
          "src/index.ts": "export default {}\n",
        },
      )
      expect(() => resolvePluginEntry(directory)).toThrow(PluginEntryError)
      // The message must say what to add, not just that something is missing.
      try {
        resolvePluginEntry(directory)
      } catch (error) {
        expect((error as Error).message).toContain("exports")
      }
    } finally {
      t.cleanup()
    }
  })

  test("refuses an exports target that does not exist", () => {
    const t = temp()
    try {
      const directory = pluginDirectory(
        t.root,
        { name: "p", exports: { ".": "./src/missing.ts" } },
        { "src/index.ts": "export default {}\n" },
      )
      expect(() => resolvePluginEntry(directory)).toThrow(/does not exist/)
    } finally {
      t.cleanup()
    }
  })

  test("refuses an exports target that escapes the package", () => {
    const t = temp()
    try {
      writeFileSync(path.join(t.root, "outside.ts"), "export default {}\n", "utf8")
      const directory = pluginDirectory(
        t.root,
        { name: "p", exports: { ".": "../outside.ts" } },
        { "src/index.ts": "export default {}\n" },
      )
      expect(() => resolvePluginEntry(directory)).toThrow(/outside its package/)
    } finally {
      t.cleanup()
    }
  })
})

describe("stagePlugins — refuse a directory the runtime would drop", () => {
  test("stages a resolvable plugin and reports the entry the runtime will import", () => {
    const t = temp()
    try {
      const directory = pluginDirectory(
        t.root,
        { name: "@bashwink/evidence", exports: { ".": "./src/index.ts" } },
        { "src/index.ts": "export default {}\n" },
      )
      const config = path.join(t.root, "config")
      const staged = stagePlugins(config, [{ id: "bashwink-evidence", directory, order: 0 }])
      expect(staged).toHaveLength(1)
      const target = path.join(config, "plugin", "bashwink-evidence")
      // Windows stages a copy (a link would need a privilege), so the entry is inside the staged directory there.
      expect(staged[0]?.entry).toBe(
        process.platform === "win32"
          ? path.join(target, "src", "index.ts")
          : path.join(directory, "src/index.ts"),
      )
      expect(staged[0]?.path).toBe(target)
    } finally {
      t.cleanup()
    }
  })

  test("an unresolvable plugin fails staging instead of producing an empty log later", () => {
    const t = temp()
    try {
      const directory = pluginDirectory(
        t.root,
        { name: "p" },
        {
          "src/index.ts": "export default {}\n",
        },
      )
      expect(() =>
        stagePlugins(path.join(t.root, "config"), [
          { id: "bashwink-evidence", directory, order: 0 },
        ]),
      ).toThrow(PluginEntryError)
    } finally {
      t.cleanup()
    }
  })

  test("staging an empty list removes a previously staged plugin (uninstall)", () => {
    const t = temp()
    try {
      const directory = pluginDirectory(
        t.root,
        { name: "p", exports: { ".": "./src/index.ts" } },
        { "src/index.ts": "export default {}\n" },
      )
      const config = path.join(t.root, "config")
      stagePlugins(config, [{ id: "bashwink-evidence", directory, order: 0 }])
      expect(() =>
        readFileSync(path.join(config, "plugin", "bashwink-evidence", "package.json")),
      ).not.toThrow()
      stagePlugins(config, [])
      expect(() =>
        readFileSync(path.join(config, "plugin", "bashwink-evidence", "package.json")),
      ).toThrow()
    } finally {
      t.cleanup()
    }
  })
})

describe("run records — evidence expected, evidence recorded", () => {
  test("beginRun persists an expectation before anything runs", () => {
    const t = temp()
    try {
      const resolved = resolvedPaths(t.root)
      const runId = "run_test_1"
      const record = beginRun({
        resolved,
        runId,
        plugin: {
          id: "bashwink-evidence",
          entry: "/pkg/src/index.ts",
          stagedPath: "/config/plugin/bashwink-evidence",
        },
      })
      expect(record.evidence).toBe("pending")
      expect(record.expected).toBe(true)
      const onDisk = readRunRecord(runRecordFile(resolved, runId))
      expect(onDisk?.runId).toBe(runId)
      expect(onDisk?.plugin?.entry).toBe("/pkg/src/index.ts")
    } finally {
      t.cleanup()
    }
  })

  test("checkBoot reports a missing file, a foreign run id and a healthy chain distinctly", () => {
    const t = temp()
    try {
      const resolved = resolvedPaths(t.root)
      const file = path.join(resolved.evidence, "evidence.jsonl")

      const absent = checkBoot(file, "run_1")
      expect(absent.ok).toBe(false)
      if (!absent.ok) expect(absent.reason).toContain("no evidence log")

      const recorder = new EvidenceRecorder({ directory: resolved.evidence })
      recorder.recordBoot({
        plugin: "bashwink-evidence",
        pid: process.pid,
        cwd: "/work",
        runID: "run_1",
      })

      const healthy = checkBoot(file, "run_1")
      expect(healthy.ok).toBe(true)
      if (healthy.ok) expect(healthy.entries).toBe(1)

      const foreign = checkBoot(file, "run_2")
      expect(foreign.ok).toBe(false)
      if (!foreign.ok) {
        expect(foreign.reason).toContain("run_2")
        expect(foreign.reason).toContain("1 entries")
      }
    } finally {
      t.cleanup()
    }
  })

  test("checkBoot refuses a tampered chain even when a boot entry is present", () => {
    const t = temp()
    try {
      const resolved = resolvedPaths(t.root)
      const recorder = new EvidenceRecorder({ directory: resolved.evidence })
      recorder.recordBoot({
        plugin: "bashwink-evidence",
        pid: 1,
        cwd: "/work",
        runID: "run_1",
      })
      const file = path.join(resolved.evidence, "evidence.jsonl")
      writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":2,"phase":"boot"}\n`, "utf8")
      const result = checkBoot(file, "run_1")
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain("failed chain verification")
    } finally {
      t.cleanup()
    }
  })

  test("finishRun records recorded / missing / disabled and keeps the boot head", () => {
    const t = temp()
    try {
      const resolved = resolvedPaths(t.root)

      beginRun({ resolved, runId: "run_ok" })
      const recorder = new EvidenceRecorder({ directory: resolved.evidence })
      recorder.recordBoot({ plugin: "bashwink-evidence", pid: 1, cwd: "/", runID: "run_ok" })
      const okBoot = checkBoot(path.join(resolved.evidence, "evidence.jsonl"), "run_ok")
      const recorded = finishRun({
        resolved,
        runId: "run_ok",
        exitCode: 0,
        expected: true,
        boot: okBoot,
      })
      expect(recorded.evidence).toBe("recorded")
      expect(recorded.bootSeq).toBe(1)
      expect(recorded.evidenceEntries).toBe(1)
      expect(recorded.evidenceHead).toBeDefined()

      beginRun({ resolved, runId: "run_bad" })
      const missing = finishRun({
        resolved,
        runId: "run_bad",
        exitCode: 0,
        expected: true,
        boot: { ok: false, reason: "no boot", entries: 0 },
        detail: "no boot",
      })
      expect(missing.evidence).toBe("missing")
      expect(missing.detail).toBe("no boot")

      const disabled = finishRun({ resolved, runId: "run_off", exitCode: 0, expected: false })
      expect(disabled.evidence).toBe("disabled")
    } finally {
      t.cleanup()
    }
  })

  test("recentRuns is newest-first and skips unreadable records", () => {
    const t = temp()
    try {
      const resolved = resolvedPaths(t.root)
      const base = Date.parse("2026-01-01T00:00:00.000Z")
      for (const [index, runId] of ["run_a", "run_b", "run_c"].entries())
        beginRun({
          resolved,
          runId,
          now: () => new Date(base + index * 1_000),
        })
      writeFileSync(path.join(runsDir(resolved), "broken.json"), "{not json", "utf8")
      const runs = recentRuns(resolved, 10)
      expect(runs.map((run) => run.runId)).toEqual(["run_c", "run_b", "run_a"])
    } finally {
      t.cleanup()
    }
  })

  test("newRunId is unique within one millisecond", () => {
    const fixed = () => new Date("2026-01-02T03:04:05.678Z")
    const ids = new Set(Array.from({ length: 50 }, () => newRunId(fixed)))
    expect(ids.size).toBe(50)
  })
})

describe("resolvePluginEntry — exports subpaths", () => {
  test("prefers the './server' subpath the runtime tries first", () => {
    const t = temp()
    try {
      const directory = pluginDirectory(
        t.root,
        {
          name: "p",
          exports: { "./server": "./src/server.ts", ".": "./src/index.ts" },
        },
        { "src/server.ts": "export default {}\n", "src/index.ts": "export default {}\n" },
      )
      expect(resolvePluginEntry(directory)).toBe(path.join(directory, "src/server.ts"))
    } finally {
      t.cleanup()
    }
  })
})
