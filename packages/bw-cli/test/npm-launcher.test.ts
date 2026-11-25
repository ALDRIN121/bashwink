import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// The launcher is CommonJS and ships in the package; load it exactly as npm would.
const launcher = require("../../../release/npm/bin/bashwink.js") as {
  resolvePlatform: (platform: string, arch: string, musl: boolean) => Record<string, string>
  findBinary: (pkg: string, name: string, executable: string, start?: string) => string | undefined
  SUPPORTED: Set<string>
}

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-launcher-")))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("platform plan", () => {
  test("Windows x64 maps to the Windows packages with .exe", () => {
    expect(launcher.resolvePlatform("win32", "x64", false)).toEqual({
      bun: "@oven/bun-windows-x64",
      opencode: "@opencode/cli-windows-x64",
      executable: ".exe",
    })
  })
  test("macOS and Linux (glibc and musl) map to their own packages", () => {
    expect(launcher.resolvePlatform("darwin", "arm64", false).bun).toBe("@oven/bun-darwin-aarch64")
    expect(launcher.resolvePlatform("linux", "x64", false).opencode).toBe("@opencode/cli-linux-x64")
    expect(launcher.resolvePlatform("linux", "x64", true).opencode).toBe(
      "@opencode/cli-linux-x64-musl",
    )
  })
  test("Windows ARM64 is refused explicitly, never mapped to an x64 binary", () => {
    const plan = launcher.resolvePlatform("win32", "arm64", false)
    expect(plan["unsupported"]).toContain("has not been qualified")
    expect(plan["bun"]).toBeUndefined()
    expect(plan["opencode"]).toBeUndefined()
  })
  test("other platforms are refused", () => {
    for (const [platform, arch] of [
      ["freebsd", "x64"],
      ["win32", "ia32"],
      ["linux", "ppc64"],
    ])
      expect(launcher.resolvePlatform(platform!, arch!, false)["unsupported"]).toBeDefined()
  })
})

describe("binary lookup", () => {
  function fakeInstall() {
    const base = realpathSync(mkdtempSync(path.join(root, "pkg-")))
    const packageRoot = path.join(base, "node_modules", "bashwink")
    mkdirSync(packageRoot, { recursive: true })
    return { base, packageRoot }
  }
  const put = (file: string) => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "#!/bin/sh\n")
    chmodSync(file, 0o755)
  }

  test("finds a dependency installed beside or under the package, in either name", () => {
    const { packageRoot } = fakeInstall()
    put(path.join(packageRoot, "node_modules/@opencode/cli-linux-x64/bin/opencode"))
    expect(launcher.findBinary("@opencode/cli-linux-x64", "opencode", "", packageRoot)).toContain(
      "opencode",
    )
    put(path.join(packageRoot, "node_modules/@opencode/cli-windows-x64/bin/opencode.exe"))
    expect(
      launcher.findBinary("@opencode/cli-windows-x64", "opencode", ".exe", packageRoot),
    ).toEndWith("opencode.exe")
  })
  test("finds Bun where npm's bun package moves it (bun/bin/bun.exe), and never searches PATH", () => {
    const { base, packageRoot } = fakeInstall()
    // The platform package is empty after install; the binary lives in the `bun` package.
    mkdirSync(path.join(packageRoot, "node_modules/@oven/bun-darwin-aarch64/bin"), {
      recursive: true,
    })
    put(path.join(packageRoot, "node_modules/bun/bin/bun.exe"))
    expect(launcher.findBinary("@oven/bun-darwin-aarch64", "bun", "", packageRoot)).toBeUndefined()
    expect(launcher.findBinary("bun", "bun", ".exe", packageRoot)).toEndWith(
      path.join("bun", "bin", "bun.exe"),
    )
    // A hoisted install (dependency next to the package) is found too.
    put(path.join(base, "node_modules/bun/bin/bun.exe"))
    expect(launcher.findBinary("bun", "bun", ".exe", packageRoot)).toBeDefined()
  })
  test("a missing dependency is reported as missing, not replaced by something else", () => {
    const { packageRoot } = fakeInstall()
    expect(
      launcher.findBinary("@opencode/cli-linux-x64", "opencode", "", packageRoot),
    ).toBeUndefined()
  })
})
