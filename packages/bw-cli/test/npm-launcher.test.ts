import { afterAll, describe, expect, test } from "bun:test"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const REPO = realpathSync(path.resolve(import.meta.dir, "../../.."))
const LAUNCHER_SRC = path.join(REPO, "release/npm/bin/bashwink.js")
const NPM_PKG_JSON = path.join(REPO, "release/npm/package.json")

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-standalone-launcher-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("standalone npm launcher contract (v0.2.0-alpha.2)", () => {
  test("release/npm/package.json declares zero third-party or legacy platform dependencies", () => {
    const pkg = JSON.parse(readFileSync(NPM_PKG_JSON, "utf8")) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
      engines?: { node?: string }
      bin?: Record<string, string>
    }
    expect(pkg.dependencies ?? {}).toEqual({})
    expect(pkg.optionalDependencies ?? {}).toEqual({})
    expect(pkg.engines?.node).toContain("22")
    expect(pkg.bin?.["bashwink"]).toBe("bin/bashwink.js")
  })

  test("unbuilt checkout fails cleanly without raw ERR_MODULE_NOT_FOUND stack traces", () => {
    const pkg = mkdtempSync(path.join(root, "unbuilt-"))
    mkdirSync(path.join(pkg, "bin"), { recursive: true })
    const launcher = path.join(pkg, "bin/bashwink.js")
    cpSync(LAUNCHER_SRC, launcher)

    const res = Bun.spawnSync({
      cmd: ["node", launcher, "--version"],
      env: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(res.exitCode).toBe(1)
    expect(res.stderr.toString()).toContain("standalone runtime bundle was not found")
    expect(res.stderr.toString()).not.toContain("ERR_MODULE_NOT_FOUND")
  })

  test("staged package boots ../lib/packages/bw-cli/src/standalone/bin.js cleanly", () => {
    const pkg = mkdtempSync(path.join(root, "staged-"))
    mkdirSync(path.join(pkg, "bin"), { recursive: true })
    const stagedBin = path.join(pkg, "lib/packages/bw-cli/src/standalone/bin.js")
    mkdirSync(path.dirname(stagedBin), { recursive: true })
    cpSync(LAUNCHER_SRC, path.join(pkg, "bin/bashwink.js"))
    writeFileSync(stagedBin, 'console.log("OK:" + process.argv.slice(2).join(","));\n')

    const res = Bun.spawnSync({
      cmd: ["node", path.join(pkg, "bin/bashwink.js"), "--help", "check"],
      env: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(res.exitCode).toBe(0)
    expect(res.stdout.toString().trim()).toBe("OK:--help,check")
  })
})
