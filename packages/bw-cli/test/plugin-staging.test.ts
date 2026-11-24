import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { mustCopyPlugin, stagePlugins } from "../src/paths.js"

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-staging-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

/** A minimal plugin package: a name, an exports map and an entry file. */
function makePlugin(parent: string, marker = "v1"): string {
  const directory = path.join(parent, "bashwink-evidence")
  mkdirSync(path.join(directory, "src"), { recursive: true })
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: "@bashwink/evidence",
      exports: { ".": "./src/index.ts", "./tui": "./src/tui.tsx" },
    }),
  )
  writeFileSync(path.join(directory, "src/index.ts"), `export default { marker: "${marker}" }\n`)
  writeFileSync(path.join(directory, "src/tui.tsx"), "export default {}\n")
  return directory
}

const fresh = (name: string) => {
  const directory = path.join(root, name)
  mkdirSync(directory, { recursive: true })
  return directory
}

describe("link or copy", () => {
  test("a package under node_modules or any package on Windows must be copied; a source checkout is linked", () => {
    const installed = makePlugin(fresh("a/node_modules/bashwink/lib"))
    const checkout = makePlugin(fresh("b/packages"))
    expect(mustCopyPlugin(installed, "linux")).toBe(true)
    expect(mustCopyPlugin(checkout, "linux")).toBe(false)
    expect(mustCopyPlugin(checkout, "win32")).toBe(true)
    expect(mustCopyPlugin(checkout, "darwin")).toBe(false)
  })
  test("a symlink into node_modules counts as node_modules (the runtime follows links to the real path)", () => {
    const installed = makePlugin(fresh("c/node_modules/bashwink/lib"))
    const link = path.join(fresh("c/elsewhere"), "linked")
    symlinkSync(installed, link, "dir")
    expect(mustCopyPlugin(link, "linux")).toBe(true)
  })
})

describe("staging", () => {
  test("a source checkout is staged as a symlink, as before", () => {
    const source = makePlugin(fresh("d/packages"))
    const config = fresh("d/config")
    const [staged] = stagePlugins(config, [
      { id: "bashwink-evidence", directory: source, order: 0 },
    ])
    expect(lstatSync(staged!.path).isSymbolicLink()).toBe(true)
    expect(staged!.entry.startsWith(source)).toBe(true)
  })

  test("a package under node_modules is staged as a real directory with no node_modules segment in its path", () => {
    const source = makePlugin(fresh("e/node_modules/bashwink/lib"))
    mkdirSync(path.join(source, "node_modules/@opencode/plugin"), { recursive: true })
    writeFileSync(path.join(source, "node_modules/@opencode/plugin/package.json"), "{}")
    const config = fresh("e/config")
    const [staged] = stagePlugins(config, [
      { id: "bashwink-evidence", directory: source, order: 0 },
    ])
    expect(lstatSync(staged!.path).isSymbolicLink()).toBe(false)
    expect(lstatSync(staged!.path).isDirectory()).toBe(true)
    expect(staged!.path.split(path.sep)).not.toContain("node_modules")
    expect(staged!.entry.startsWith(staged!.path)).toBe(true)
    expect(existsSync(staged!.entry)).toBe(true)
    // The host refuses a second copy of its own SDK found in a plugin's node_modules, so none is copied.
    expect(existsSync(path.join(staged!.path, "node_modules"))).toBe(false)
  })

  test("Windows stages by copy even from a plain directory", () => {
    const source = makePlugin(fresh("f/packages"))
    const [staged] = stagePlugins(
      fresh("f/config"),
      [{ id: "bashwink-evidence", directory: source, order: 0 }],
      { platform: "win32" },
    )
    expect(lstatSync(staged!.path).isSymbolicLink()).toBe(false)
    expect(readFileSync(path.join(staged!.path, "src/index.ts"), "utf8")).toContain("v1")
  })

  test("every run re-stages, so a copy is never stale after an upgrade", () => {
    const parent = fresh("g/node_modules/bashwink/lib")
    const source = makePlugin(parent, "v1")
    const config = fresh("g/config")
    stagePlugins(config, [{ id: "bashwink-evidence", directory: source, order: 0 }])
    writeFileSync(path.join(source, "src/index.ts"), 'export default { marker: "v2" }\n')
    const [staged] = stagePlugins(config, [
      { id: "bashwink-evidence", directory: source, order: 0 },
    ])
    expect(readFileSync(path.join(staged!.path, "src/index.ts"), "utf8")).toContain("v2")
  })

  test("preserveExisting replaces just one slot and leaves the others alone", () => {
    const source = makePlugin(fresh("h/node_modules/bashwink/lib"), "v1")
    const config = fresh("h/config")
    stagePlugins(config, [{ id: "bashwink-evidence", directory: source, order: 0 }])
    mkdirSync(path.join(config, "plugin/other"))
    writeFileSync(path.join(config, "plugin/other/keep.txt"), "kept")
    writeFileSync(path.join(source, "src/index.ts"), 'export default { marker: "v2" }\n')
    const [staged] = stagePlugins(
      config,
      [{ id: "bashwink-evidence", directory: source, order: 0 }],
      {
        preserveExisting: true,
      },
    )
    expect(readFileSync(path.join(staged!.path, "src/index.ts"), "utf8")).toContain("v2")
    expect(readFileSync(path.join(config, "plugin/other/keep.txt"), "utf8")).toBe("kept")
    expect(existsSync(`${staged!.path}.old-${process.pid}`)).toBe(false)
  })

  test("a package with no resolvable entry still fails instead of being silently staged", () => {
    const broken = fresh("i/node_modules/bashwink/lib/broken")
    writeFileSync(path.join(broken, "readme.txt"), "x")
    expect(() =>
      stagePlugins(fresh("i/config"), [{ id: "bashwink-evidence", directory: broken, order: 0 }]),
    ).toThrow(/no resolvable server entry/)
  })
})
