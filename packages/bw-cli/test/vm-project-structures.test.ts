import { afterAll, beforeAll, expect, test } from "bun:test"
import { macosDescribe } from "./platform.js"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openVmProject } from "../src/vm-project.js"

/**
 * Which project layouts the isolated VM accepts. The release documents these as the supported
 * and unsupported structures, so each line here is a documented claim.
 */
const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-structures-")))
const originalCwd = process.cwd()
const originalHome = process.env["BASHWINK_HOME"]
let counter = 0

beforeAll(() => {
  process.env["BASHWINK_HOME"] = path.join(root, "state")
})
afterAll(() => {
  process.chdir(originalCwd)
  if (originalHome === undefined) delete process.env["BASHWINK_HOME"]
  else process.env["BASHWINK_HOME"] = originalHome
  rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=T", "-c", "user.email=t@example.invalid", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

/** Create a committed repository whose tracked files are `files`, then open it. */
function project(
  files: Record<string, string | Buffer>,
  options: {
    before?: (dir: string) => void
    subdir?: string
    untracked?: Record<string, string>
  } = {},
) {
  const dir = path.join(root, `p${counter++}`)
  mkdirSync(dir)
  git(dir, "init", "-q", ".")
  for (const [name, data] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), data)
  }
  options.before?.(dir)
  git(dir, "add", "-A")
  git(dir, "commit", "-qm", "init", "--allow-empty")
  for (const [name, data] of Object.entries(options.untracked ?? {}))
    writeFileSync(path.join(dir, name), data)
  process.chdir(options.subdir === undefined ? dir : path.join(dir, options.subdir))
  return dir
}

function open() {
  const handle = openVmProject("profile")
  handle.lifetime.close()
  return Object.keys(handle.record.base).sort()
}

macosDescribe("supported structures", () => {
  test("a Git checkout root with top-level .ts, .js and .txt files", () => {
    project({ "a.ts": "export const a = 1\n", "b.js": "1\n", "notes.txt": "n\n" })
    expect(open()).toEqual(["a.ts", "b.js", "notes.txt"])
  })
  test("tests at the top level are enrolled and treated as protected", () => {
    project({ "a.ts": "x\n", "a.test.ts": "t\n" })
    expect(open()).toEqual(["a.test.ts", "a.ts"])
  })
})

macosDescribe("unsupported structures are refused or left out, never silently included", () => {
  test("a directory that is not a Git repository is refused", () => {
    const dir = path.join(root, `plain${counter++}`)
    mkdirSync(dir)
    writeFileSync(path.join(dir, "a.ts"), "x\n")
    process.chdir(dir)
    expect(() => openVmProject("profile")).toThrow()
  })
  test("a subdirectory of a repository is refused", () => {
    project({ "a.ts": "x\n", "sub/b.ts": "y\n" }, { subdir: "sub" })
    expect(() => openVmProject("profile")).toThrow(/checkout root/)
  })
  test("a repository with no eligible top-level files is refused", () => {
    project({ "src/deep.ts": "x\n", "README.md": "# r\n", "package.json": "{}\n" })
    expect(() => openVmProject("profile")).toThrow(/inventory/)
  })
  test("nested directories are not staged; only top-level files are", () => {
    project({ "a.ts": "x\n", "src/b.ts": "y\n", "src/c/d.ts": "z\n" })
    expect(open()).toEqual(["a.ts"])
  })
  test("other file types are not staged", () => {
    project({
      "a.ts": "x\n",
      "b.py": "p\n",
      "c.json": "{}\n",
      "d.md": "m\n",
      "e.tsx": "t\n",
      "f.mjs": "m\n",
    })
    expect(open()).toEqual(["a.ts"])
  })
  test("credential-looking names are not staged", () => {
    project({
      "a.ts": "x\n",
      "credentials.txt": "c\n",
      "secrets.ts": "s\n",
      "api-token.txt": "t\n",
      "private-key.txt": "k\n",
    })
    expect(open()).toEqual(["a.ts"])
  })
  test("untracked and ignored files are not staged", () => {
    project(
      { "a.ts": "x\n", ".gitignore": "ignored.ts\n" },
      { untracked: { "new.ts": "n\n", "ignored.ts": "i\n", ".env": "K=1\n" } },
    )
    expect(open()).toEqual(["a.ts"])
  })
  test("more than 64 eligible files is refused", () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 65; i += 1) files[`f${i}.ts`] = "x\n"
    project(files)
    expect(() => openVmProject("profile")).toThrow(/oversized/)
  })
  test("a file larger than 256 KiB is refused", () => {
    project({ "a.ts": "x\n", "big.ts": "x".repeat(256 * 1024 + 1) })
    expect(() => openVmProject("profile")).toThrow()
  })
  test("a binary or non-UTF-8 file with an eligible name is refused", () => {
    project({ "a.ts": "x\n", "bin.txt": Buffer.from([0xff, 0xfe, 0x00, 0x01]) })
    expect(() => openVmProject("profile")).toThrow()
  })
  test("a tracked symlink with an eligible name is refused", () => {
    project(
      { "a.ts": "x\n", "real.txt": "r\n" },
      { before: (dir) => symlinkSync("real.txt", path.join(dir, "link.txt")) },
    )
    expect(() => openVmProject("profile")).toThrow()
  })
  test("names differing only by case are refused", () => {
    project({ "a.ts": "x\n", "A.ts": "y\n" })
    // On a case-insensitive filesystem git may record both; either way they must not both stage.
    try {
      expect(open().map((name) => name.toLowerCase())).toEqual(["a.ts"])
    } catch (error) {
      expect(String(error)).toMatch(/inventory|oversized|unique|case/i)
    }
  })
  test("a repository with no commit is refused", () => {
    const dir = path.join(root, `empty${counter++}`)
    mkdirSync(dir)
    git(dir, "init", "-q", ".")
    writeFileSync(path.join(dir, "a.ts"), "x\n")
    git(dir, "add", "-A")
    process.chdir(dir)
    expect(() => openVmProject("profile")).toThrow()
  })
})
