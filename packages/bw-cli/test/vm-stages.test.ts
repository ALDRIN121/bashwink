import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  MARKER,
  STAGE_PREFIX,
  STAGE_ROOT,
  forgetStage,
  listStages,
  purgeStages,
  registerStage,
  renderStageReports,
} from "../src/vm-stages.js"

/** A PID that belonged to a process that has exited. */
function deadPid() {
  const child = Bun.spawnSync({ cmd: ["/usr/bin/true"] })
  return child.pid ?? 99999999
}
const DEAD = deadPid()
const base = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-stages-")))
afterAll(() => rmSync(base, { recursive: true, force: true }))
let n = 0
/** A private stage root, so these tests never look at the real /private/tmp. */
function world() {
  const root = path.join(base, `root${n++}`)
  const data = path.join(base, `data${n++}`)
  mkdirSync(root)
  mkdirSync(data)
  const idle = { stageRoot: root, isAlive: () => false, inUse: () => false }
  let counter = 0
  const stage = (suffix?: string) => {
    const dir = path.join(
      root,
      `${STAGE_PREFIX}${suffix ?? `A${String(counter++).padStart(5, "0")}`}`,
    )
    mkdirSync(dir, { mode: 0o700 })
    return dir
  }
  return { root, data, idle, stage }
}

describe("registration", () => {
  test("records the directory and writes a private ownership marker", () => {
    const w = world()
    const stage = w.stage()
    const record = registerStage(w.data, stage, { stageRoot: w.root })
    expect(record.path).toBe(stage)
    const entry = path.join(w.data, "vm-stages", `${path.basename(stage)}.json`)
    expect(JSON.parse(readFileSync(entry, "utf8")).nonce).toBe(record.nonce)
    expect(JSON.parse(readFileSync(path.join(stage, MARKER), "utf8")).nonce).toBe(record.nonce)
    expect(lstatSync(entry).mode & 0o077).toBe(0)
    expect(lstatSync(path.join(stage, MARKER)).mode & 0o077).toBe(0)
  })
  test("refuses a path outside the stage root, a wrong name shape and a symlink", () => {
    const w = world()
    const outside = path.join(base, `${STAGE_PREFIX}ABCDEF`)
    mkdirSync(outside)
    expect(() => registerStage(w.data, outside, { stageRoot: w.root })).toThrow()
    const odd = path.join(w.root, `${STAGE_PREFIX}x`)
    mkdirSync(odd)
    expect(() => registerStage(w.data, odd, { stageRoot: w.root })).toThrow()
    const real = w.stage()
    const link = path.join(w.root, `${STAGE_PREFIX}LINK01`)
    symlinkSync(real, link)
    expect(() => registerStage(w.data, link, { stageRoot: w.root })).toThrow()
  })
})

describe("purge removes only what this installation recorded and can prove is its own", () => {
  test("an idle recorded stage is removed, and its registry entry with it", () => {
    const w = world()
    const stage = w.stage()
    writeFileSync(path.join(stage, "stage.raw"), "x")
    registerStage(w.data, stage, { stageRoot: w.root })
    const reports = purgeStages(w.data, w.idle)
    expect(reports.map((r) => r.disposition.action)).toEqual(["removed"])
    expect(existsSync(stage)).toBe(false)
    expect(readdirSync(path.join(w.data, "vm-stages"))).toEqual([])
    // Repeating is safe and reports nothing to do.
    expect(purgeStages(w.data, w.idle)).toEqual([])
  })

  test("an unrelated directory with a matching name survives", () => {
    const w = world()
    const mine = w.stage()
    registerStage(w.data, mine, { stageRoot: w.root })
    const unrelated = w.stage("UNREL1")
    writeFileSync(path.join(unrelated, "keep.txt"), "someone else's")
    purgeStages(w.data, w.idle)
    expect(existsSync(mine)).toBe(false)
    expect(readFileSync(path.join(unrelated, "keep.txt"), "utf8")).toBe("someone else's")
  })

  test("another installation's stages and registry survive", () => {
    const w = world()
    const otherData = path.join(base, `other${n++}`)
    mkdirSync(otherData)
    const mine = w.stage()
    const theirs = w.stage()
    registerStage(w.data, mine, { stageRoot: w.root })
    registerStage(otherData, theirs, { stageRoot: w.root })
    purgeStages(w.data, w.idle)
    expect(existsSync(mine)).toBe(false)
    expect(existsSync(theirs)).toBe(true)
    expect(readdirSync(path.join(otherData, "vm-stages")).length).toBe(1)
    // And the other installation can still purge its own.
    purgeStages(otherData, w.idle)
    expect(existsSync(theirs)).toBe(false)
  })

  test("a stage whose session may be alive, or whose disk is open, is kept", () => {
    const w = world()
    const alive = w.stage()
    registerStage(w.data, alive, { stageRoot: w.root })
    const reports = purgeStages(w.data, { ...w.idle, isAlive: () => true })
    expect(reports[0]!.disposition).toMatchObject({ action: "kept" })
    expect(existsSync(alive)).toBe(true)
    const open = purgeStages(w.data, { ...w.idle, inUse: () => true })
    expect(open[0]!.disposition).toMatchObject({
      action: "kept",
      reason: expect.stringContaining("open"),
    })
    expect(existsSync(alive)).toBe(true)
  })

  test("a symbolic link put at the recorded path is not followed", () => {
    const w = world()
    const stage = w.stage()
    registerStage(w.data, stage, { stageRoot: w.root })
    const target = path.join(base, `target${n++}`)
    mkdirSync(target)
    writeFileSync(path.join(target, "precious.txt"), "do not delete")
    rmSync(stage, { recursive: true })
    symlinkSync(target, stage)
    const reports = purgeStages(w.data, w.idle)
    expect(reports[0]!.disposition).toMatchObject({
      action: "kept",
      reason: expect.stringContaining("symbolic link"),
    })
    expect(readFileSync(path.join(target, "precious.txt"), "utf8")).toBe("do not delete")
    expect(lstatSync(stage).isSymbolicLink()).toBe(true)
  })

  test("a directory replaced after registration (different identity) survives", () => {
    const w = world()
    const stage = w.stage()
    registerStage(w.data, stage, { stageRoot: w.root })
    rmSync(stage, { recursive: true })
    mkdirSync(stage)
    // Even with a forged marker the inode differs.
    writeFileSync(path.join(stage, "theirs.txt"), "x")
    const reports = purgeStages(w.data, w.idle)
    expect(reports[0]!.disposition).toMatchObject({ action: "kept" })
    expect(existsSync(path.join(stage, "theirs.txt"))).toBe(true)
  })

  test("a missing, mismatched or symlinked ownership marker keeps the directory", () => {
    for (const tamper of ["delete", "wrong-nonce", "symlink"] as const) {
      const w = world()
      const stage = w.stage()
      registerStage(w.data, stage, { stageRoot: w.root })
      const marker = path.join(stage, MARKER)
      if (tamper === "delete") rmSync(marker)
      if (tamper === "wrong-nonce") writeFileSync(marker, JSON.stringify({ nonce: "0".repeat(32) }))
      if (tamper === "symlink") {
        const original = readFileSync(marker, "utf8")
        rmSync(marker)
        const real = path.join(base, `m${n++}`)
        writeFileSync(real, original)
        symlinkSync(real, marker)
      }
      const reports = purgeStages(w.data, w.idle)
      expect(reports[0]!.disposition.action).toBe("kept")
      expect(existsSync(stage)).toBe(true)
    }
  })

  test("a hand-written registry entry cannot point at any other location", () => {
    const w = world()
    const victim = path.join(base, `victim${n++}`)
    mkdirSync(victim)
    writeFileSync(path.join(victim, "file"), "x")
    const meta = lstatSync(victim)
    mkdirSync(path.join(w.data, "vm-stages"), { recursive: true })
    for (const [name, target] of [
      [`${STAGE_PREFIX}EVIL01`, victim],
      [`${STAGE_PREFIX}EVIL02`, path.dirname(victim)],
      [`${STAGE_PREFIX}EVIL03`, "/"],
    ] as const) {
      writeFileSync(
        path.join(w.data, "vm-stages", `${name}.json`),
        JSON.stringify({
          version: 1,
          name,
          path: target,
          dev: meta.dev,
          ino: meta.ino,
          uid: meta.uid,
          nonce: "a".repeat(32),
          pid: 1,
          startedAt: "x",
        }),
      )
    }
    const reports = purgeStages(w.data, w.idle)
    expect(reports.every((r) => r.disposition.action === "kept")).toBe(true)
    expect(existsSync(path.join(victim, "file"))).toBe(true)
  })

  test("entries owned by another user, malformed entries and vanished directories are handled safely", () => {
    const w = world()
    const foreign = w.stage()
    registerStage(w.data, foreign, { stageRoot: w.root })
    const foreignReport = purgeStages(w.data, { ...w.idle, uid: (process.getuid?.() ?? 0) + 1 })
    expect(foreignReport[0]!.disposition).toMatchObject({
      action: "kept",
      reason: expect.stringContaining("owned"),
    })
    expect(existsSync(foreign)).toBe(true)

    writeFileSync(path.join(w.data, "vm-stages", `${STAGE_PREFIX}BROKEN.json`), "{not json")
    const gone = w.stage()
    registerStage(w.data, gone, { stageRoot: w.root })
    rmSync(gone, { recursive: true })
    const reports = purgeStages(w.data, w.idle)
    const byName = Object.fromEntries(reports.map((r) => [r.name, r.disposition.action]))
    expect(byName[`${STAGE_PREFIX}BROKEN.json`]).toBe("kept")
    expect(byName[path.basename(gone)]).toBe("forgotten")
    expect(byName[path.basename(foreign)]).toBe("removed")
    expect(existsSync(foreign)).toBe(false)
  })

  test("links inside a removed stage are unlinked, never followed", () => {
    const w = world()
    const stage = w.stage()
    registerStage(w.data, stage, { stageRoot: w.root })
    const outside = path.join(base, `out${n++}`)
    mkdirSync(outside)
    writeFileSync(path.join(outside, "keep"), "k")
    symlinkSync(outside, path.join(stage, "escape"))
    purgeStages(w.data, w.idle)
    expect(existsSync(stage)).toBe(false)
    expect(readFileSync(path.join(outside, "keep"), "utf8")).toBe("k")
  })

  test("output is deterministic, ordered by name, and the listing never deletes", () => {
    const w = world()
    const a = w.stage("AAAAAA")
    const b = w.stage("BBBBBB")
    registerStage(w.data, b, { stageRoot: w.root })
    registerStage(w.data, a, { stageRoot: w.root })
    const listed = listStages(w.data, w.idle)
    expect(listed.map((r) => r.name)).toEqual([path.basename(a), path.basename(b)])
    expect(existsSync(a) && existsSync(b)).toBe(true)
    expect(renderStageReports(listed, false)).toContain("would remove")
    const purged = purgeStages(w.data, w.idle)
    expect(purged.map((r) => r.name)).toEqual([path.basename(a), path.basename(b)])
    expect(renderStageReports(purged, true).split("\n")[0]).toStartWith("removed")
  })

  test("forgetStage drops only the named entry", () => {
    const w = world()
    const a = w.stage()
    const b = w.stage()
    registerStage(w.data, a, { stageRoot: w.root })
    registerStage(w.data, b, { stageRoot: w.root })
    forgetStage(w.data, a)
    expect(readdirSync(path.join(w.data, "vm-stages"))).toEqual([`${path.basename(b)}.json`])
  })
})

// ---------------------------------------------------------------------------------------
// The shipped command and the shipped uninstaller, against decoys in the real stage root.
// ---------------------------------------------------------------------------------------

// These use the real /private/tmp stage root and the macOS process tools, so they run on macOS CI.
describe.skipIf(process.platform !== "darwin")("the installed command and uninstall.sh", () => {
  const decoys: string[] = []
  const cli = path.join(import.meta.dir, "../src/bin.ts")
  const uninstall = path.join(import.meta.dir, "../../../release/uninstall.sh")
  afterAll(() => decoys.forEach((d) => rmSync(d, { recursive: true, force: true })))

  function install(home: string) {
    const prefix = path.join(home, ".local/opt/bashwink")
    const version = path.join(prefix, "0.0.0-test")
    mkdirSync(path.join(version, "bin"), { recursive: true })
    writeFileSync(
      path.join(version, "bin/bashwink"),
      `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`,
    )
    chmodSync(path.join(version, "bin/bashwink"), 0o755)
    symlinkSync(version, path.join(prefix, "current"))
    mkdirSync(path.join(home, ".local/bin"), { recursive: true })
    symlinkSync(path.join(prefix, "current/bin/bashwink"), path.join(home, ".local/bin/bashwink"))
    return prefix
  }
  const env = (home: string) => ({ PATH: process.env["PATH"]!, HOME: home })
  const decoy = (label: string) => {
    const dir = mkdtempSync(path.join(STAGE_ROOT, STAGE_PREFIX))
    writeFileSync(path.join(dir, "evidence-of-" + label), "must survive")
    decoys.push(dir)
    return dir
  }
  const run = (home: string, args: string[], input = "") =>
    Bun.spawnSync({
      cmd: ["/bin/sh", uninstall, ...args],
      env: env(home),
      stdin: Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    })

  test("--purge-state removes this installation's recorded stage and nothing matching by name only", () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-home-")))
    decoys.push(home)
    install(home)
    // Another installation's stage, an older build's unregistered stage and a stranger's.
    const otherHome = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-home-")))
    decoys.push(otherHome)
    const other = decoy("other-installation")
    registerStage(path.join(otherHome, ".local/share/bashwink"), other, { pid: DEAD })
    const legacy = decoy("older-build")
    const stranger = decoy("another-tool")
    // This installation's own stage, created by the real code path.
    const mine = mkdtempSync(path.join(STAGE_ROOT, STAGE_PREFIX))
    decoys.push(mine)
    registerStage(path.join(home, ".local/share/bashwink"), mine, { pid: DEAD })
    mkdirSync(path.join(home, ".config/bashwink"), { recursive: true })

    const result = run(home, ["--purge-state"], "delete\n")
    expect(result.exitCode).toBe(0)
    const output = result.stdout.toString()
    expect(output).toContain(mine)
    expect(existsSync(mine)).toBe(false)
    for (const [kept, label] of [
      [other, "other-installation"],
      [legacy, "older-build"],
      [stranger, "another-tool"],
    ] as const) {
      expect(readFileSync(path.join(kept, `evidence-of-${label}`), "utf8")).toBe("must survive")
      expect(output).not.toContain(`removed  ${kept}`)
    }
    expect(existsSync(path.join(home, ".local/opt/bashwink"))).toBe(false)
    expect(existsSync(path.join(home, ".config/bashwink"))).toBe(false)
  })

  test("declining keeps state and stages; the program is still removed; exit 0", () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-home-")))
    decoys.push(home)
    install(home)
    const mine = mkdtempSync(path.join(STAGE_ROOT, STAGE_PREFIX))
    decoys.push(mine)
    registerStage(path.join(home, ".local/share/bashwink"), mine, { pid: DEAD })
    const result = run(home, ["--purge-state"], "no\n")
    expect(result.exitCode).toBe(0)
    expect(existsSync(mine)).toBe(true)
    expect(existsSync(path.join(home, ".local/opt/bashwink"))).toBe(false)
  })

  test("a stage whose session is alive is kept, and the cleanup still exits 0", () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-home-")))
    decoys.push(home)
    install(home)
    const live = mkdtempSync(path.join(STAGE_ROOT, STAGE_PREFIX))
    decoys.push(live)
    // This test process is the "session": its pid is recorded and it is running.
    registerStage(path.join(home, ".local/share/bashwink"), live)
    const result = run(home, ["--purge-state"], "delete\n")
    expect(result.exitCode).toBe(0)
    expect(existsSync(live)).toBe(true)
    expect(result.stdout.toString()).toContain("may still be running")
  })

  test("a plain uninstall touches no stage and no state", () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-home-")))
    decoys.push(home)
    install(home)
    const mine = mkdtempSync(path.join(STAGE_ROOT, STAGE_PREFIX))
    decoys.push(mine)
    registerStage(path.join(home, ".local/share/bashwink"), mine, { pid: DEAD })
    const result = run(home, [])
    expect(result.exitCode).toBe(0)
    expect(existsSync(mine)).toBe(true)
    expect(existsSync(path.join(home, ".local/share/bashwink/vm-stages"))).toBe(true)
  })

  test("the command's own output is usable and the purge subcommand rejects stray arguments", () => {
    const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bw-home-")))
    decoys.push(home)
    const listed = Bun.spawnSync({
      cmd: [process.execPath, cli, "sandbox", "stages"],
      env: { ...env(home), BASHWINK_HOME: path.join(home, "s") },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout.toString()).toContain("no VM stage directories are recorded")
    const bad = Bun.spawnSync({
      cmd: [process.execPath, cli, "sandbox", "stages", "--everything"],
      env: env(home),
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(bad.exitCode).toBe(2)
  })
})
