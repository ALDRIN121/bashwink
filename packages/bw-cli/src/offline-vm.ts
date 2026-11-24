import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { regularFile } from "./native-stage.js"

const ASSETS = ["vm-owner", "Image", "initramfs"] as const
const SECTOR_SIZE = 512
const DISK_SIZE = 8 * 1024 * 1024

export const offlineVmCapabilities = {
  mode: "apple-virtualization-offline",
  workspace: "staged",
  filesystemIsolation: true,
  networkIsolation: true,
  processIsolation: true,
  cancellation: "vm-stop",
} as const

export function offlineVmSelected(moduleDirectory: string) {
  if (process.env["BASHWINK_BACKEND"] === "vm") return true
  return ["offline-vm.json", "offline-vm"].some((name) => {
    try {
      lstatSync(path.join(moduleDirectory, name))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return false
    }
  })
}

async function validateAssets(directory: string) {
  const manifest = JSON.parse(
    regularFile(path.join(directory, "offline-vm.json"), 4096).data.toString(),
  ) as { version?: unknown; sha256?: Record<string, unknown> }
  if (manifest?.version !== 1 || !manifest.sha256) throw new Error("invalid asset manifest")
  const assets = path.join(directory, "offline-vm")
  if (realpathSync(assets) !== assets) throw new Error("asset directory is a symlink")
  for (const name of ASSETS) {
    const filename = path.join(assets, name)
    const expected = manifest.sha256[name]
    const before = lstatSync(filename)
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o022) !== 0 ||
      (name === "vm-owner" && (before.mode & 0o100) === 0) ||
      typeof expected !== "string" ||
      !/^[a-f0-9]{64}$/.test(expected)
    )
      throw new Error(`invalid VM asset: ${name}`)
    const hash = createHash("sha256")
    for await (const chunk of Bun.file(filename).stream()) hash.update(chunk)
    const after = lstatSync(filename)
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.size !== after.size ||
      hash.digest("hex") !== expected
    )
      throw new Error(`VM asset integrity check failed: ${name}`)
  }
  return ASSETS.map((name) => path.join(assets, name))
}

function guestStatus(disk: string) {
  const fd = openSync(disk, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const sector = Buffer.alloc(SECTOR_SIZE)
    if (
      !fstatSync(fd).isFile() ||
      readSync(fd, sector, 0, SECTOR_SIZE, SECTOR_SIZE) !== SECTOR_SIZE
    )
      throw new Error("could not read the stopped guest's status")
    const status = /^BWVM1 (0|[1-9]\d{0,2})\n\0*$/.exec(sector.toString())
    if (status === null || Number(status[1]) > 255)
      throw new Error("guest stopped without a valid exit record")
    return Number(status[1])
  } finally {
    closeSync(fd)
  }
}

export async function runOfflineVm(moduleDirectory: string): Promise<number> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("the offline VM requires macOS Apple Silicon")
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("the offline VM requires an interactive terminal")

  const assets = await validateAssets(moduleDirectory)
  const input = regularFile("task.txt", SECTOR_SIZE - 1).data
  new TextDecoder("utf-8", { fatal: true }).decode(input)
  if (input.length === 0 || input.includes(0)) throw new Error("task.txt must be nonempty UTF-8")
  const stage = mkdtempSync("/private/tmp/bashwink-vm-")
  const disk = path.join(stage, "stage.raw")
  const fd = openSync(disk, "wx", 0o600)
  try {
    ftruncateSync(fd, DISK_SIZE)
    writeFileSync(fd, input)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  writeFileSync(disk + ".lock", "", { flag: "wx", mode: 0o600 })
  process.stdout.write(`Bashwink offline VM stage: ${stage}\n`)

  const terminal = Bun.spawnSync(["/bin/stty", "-g"], { stdin: "inherit", stderr: "ignore" })
  if (terminal.exitCode !== 0) throw new Error("could not read the host terminal settings")
  const owner = Bun.spawn([...assets, disk, "--host-terminal", "--timeout-ms=75000"], {
    cwd: stage,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    stdin: "pipe",
    stdout: "inherit",
    stderr: "inherit",
  })
  let interrupt: number | undefined
  const stop = (exitCode: number) => {
    if (interrupt !== undefined || owner.exitCode !== null) return
    interrupt = exitCode
    owner.stdin.end()
  }
  const onInterrupt = () => stop(130)
  const onTerminate = () => stop(143)
  process.on("SIGINT", onInterrupt)
  process.on("SIGTERM", onTerminate)
  try {
    const code = await owner.exited
    if (interrupt !== undefined && (code === 0 || code === interrupt)) return interrupt
    if (code !== 0) throw new Error(`VM owner exited with status ${code}; stage retained`)
    const guest = guestStatus(disk)
    if (guest !== 0 && guest !== 130)
      process.stderr.write(`offline VM guest exited with status ${guest}; stage retained\n`)
    return guest
  } finally {
    process.off("SIGINT", onInterrupt)
    process.off("SIGTERM", onTerminate)
    owner.stdin.end()
    Bun.spawnSync(["/bin/stty", terminal.stdout.toString().trim()], {
      stdin: "inherit",
      stderr: "ignore",
    })
  }
}
