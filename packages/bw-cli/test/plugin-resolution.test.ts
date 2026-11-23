/**
 * BW-091 — locating the evidence plugin in every supported layout.
 *
 * This is a regression test for a defect that made real runs unrecoverable-by-design: the
 * launcher derived the plugin directory as `<module>/../../../packages/bw-evidence`, which is
 * correct in the source checkout and resolves to `node_modules/packages/...` once the CLI is
 * installed. The result was not an error — it was a run with **no recorder at all**, which
 * looks exactly like a session that called no tools.
 *
 * So the properties under test are: each real layout resolves, an ambiguous layout is a loud
 * failure rather than a silent empty one, and the failure text names every path tried.
 */

import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { PluginEntryError, resolvePluginDirectory } from "../src/paths.js"

function temp(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "bw-plugin-locate-"))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function makePlugin(directory: string): string {
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    path.join(directory, "package.json"),
    '{"name":"x","exports":{".":"./src/index.ts"}}',
  )
  return directory
}

describe("plugin directory resolution", () => {
  test("the built-install layout resolves (lib/evidence beside the bundle)", () => {
    const { root, cleanup } = temp()
    try {
      const evidence = makePlugin(path.join(root, "lib", "evidence"))
      // Only the built layout exists; resolution must find it without falling through.
      expect(resolvePluginDirectory([evidence, path.join(root, "lib", "nope")], {})).toBe(evidence)
    } finally {
      cleanup()
    }
  })

  test("the source layout resolves (packages/bw-evidence)", () => {
    const { root, cleanup } = temp()
    try {
      const evidence = makePlugin(path.join(root, "packages", "bw-evidence"))
      expect(resolvePluginDirectory([path.join(root, "lib", "evidence"), evidence], {})).toBe(
        evidence,
      )
    } finally {
      cleanup()
    }
  })

  test("a directory without a package.json is not a plugin, even if it exists", () => {
    const { root, cleanup } = temp()
    try {
      const empty = path.join(root, "lib", "evidence")
      mkdirSync(empty, { recursive: true })
      const real = makePlugin(path.join(root, "lib", "real"))
      // The bare directory must be skipped, not accepted: the runtime would fail to load it.
      expect(resolvePluginDirectory([empty, real], {})).toBe(real)
    } finally {
      cleanup()
    }
  })

  test("nothing found is a loud error naming every path tried", () => {
    const { root, cleanup } = temp()
    try {
      const tried = [path.join(root, "a"), path.join(root, "b")]
      let message = ""
      try {
        resolvePluginDirectory(tried, {})
      } catch (error) {
        expect(error).toBeInstanceOf(PluginEntryError)
        message = (error as Error).message
      }
      // The whole point: a reader can see where it looked without reading the source.
      expect(message).toContain("looked in")
      for (const candidate of tried) expect(message).toContain(candidate)
      expect(message).toContain("BASHWINK_PLUGIN_DIR")
    } finally {
      cleanup()
    }
  })

  test("BASHWINK_PLUGIN_DIR wins over the candidate list", () => {
    const { root, cleanup } = temp()
    try {
      const override = makePlugin(path.join(root, "custom"))
      const decoy = makePlugin(path.join(root, "decoy"))
      expect(resolvePluginDirectory([decoy], { BASHWINK_PLUGIN_DIR: override })).toBe(override)
    } finally {
      cleanup()
    }
  })

  test("a bad BASHWINK_PLUGIN_DIR is an error, not a silent fallback to a default", () => {
    const { root, cleanup } = temp()
    try {
      const decoy = makePlugin(path.join(root, "decoy"))
      expect(() =>
        resolvePluginDirectory([decoy], { BASHWINK_PLUGIN_DIR: path.join(root, "absent") }),
      ).toThrow(PluginEntryError)
    } finally {
      cleanup()
    }
  })
})
