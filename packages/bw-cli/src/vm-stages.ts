/**
 * Ownership tracking for VM stage directories.
 *
 * A session's stage directory lives in `/private/tmp` and holds a copy of the project and its
 * session state. Cleanup must never be "delete whatever matches a name": another Bashwink
 * installation, a development build, a different user's tool or a live session can own a
 * directory with the same prefix. So a stage is only ever removed when the installation that
 * created it recorded it, and the directory in front of us is provably the one it recorded.
 *
 * A stage is recorded twice: a private registry entry under the installation's data directory,
 * and a marker file inside the stage itself carrying the same random nonce. Removal requires:
 *
 *   - a registry entry that parses and names a path directly under the stage root with the
 *     expected name shape;
 *   - a real directory (never a symlink) at that path, owned by this user, whose device and
 *     inode match the entry;
 *   - a marker file inside it (a real file) with the entry's nonce;
 *   - no live process: the recorded PID is gone and nothing has the stage disk open.
 *
 * Anything else is kept, and the reason is reported. Directories this code did not register
 * (older builds, other installations, unrelated tools) are never examined for deletion.
 */

import { randomBytes } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

export const STAGE_ROOT = "/private/tmp"
export const STAGE_PREFIX = "bashwink-vm-"
export const MARKER = ".bashwink-stage"
const REGISTRY = "vm-stages"
const NAME = /^bashwink-vm-[A-Za-z0-9]{6}$/

export interface StageRecord {
  readonly version: 1
  readonly name: string
  readonly path: string
  readonly dev: number
  readonly ino: number
  readonly uid: number
  readonly nonce: string
  readonly pid: number
  readonly startedAt: string
}

export type StageDisposition =
  | { readonly action: "removed" }
  | { readonly action: "kept"; readonly reason: string }
  | { readonly action: "forgotten"; readonly reason: string }

export interface StageReport {
  readonly name: string
  readonly path: string
  readonly disposition: StageDisposition
}

export interface StageOptions {
  readonly stageRoot?: string
  readonly uid?: number
  readonly isAlive?: (pid: number) => boolean
  /** True when any process has this stage's disk open. */
  readonly inUse?: (stage: string) => boolean
}

function registryDirectory(dataDirectory: string) {
  return path.join(dataDirectory, REGISTRY)
}

function writeFileAtomic(file: string, text: string) {
  const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`
  const fd = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, file)
}

/** Record a freshly created stage directory. Call immediately after creating it. */
export function registerStage(
  dataDirectory: string,
  stage: string,
  options: StageOptions & { readonly now?: () => Date; readonly pid?: number } = {},
): StageRecord {
  const root = options.stageRoot ?? STAGE_ROOT
  const name = path.basename(stage)
  if (path.dirname(stage) !== root || !NAME.test(name))
    throw new Error("refusing to register a stage outside the stage root")
  const metadata = lstatSync(stage)
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("a stage must be a real directory")
  const record: StageRecord = {
    version: 1,
    name,
    path: stage,
    dev: metadata.dev,
    ino: metadata.ino,
    uid: metadata.uid,
    nonce: randomBytes(16).toString("hex"),
    pid: options.pid ?? process.pid,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
  }
  // The marker goes in first: an entry without a marker can never authorize deletion.
  writeFileSync(path.join(stage, MARKER), JSON.stringify({ nonce: record.nonce }), {
    flag: "wx",
    mode: 0o600,
  })
  mkdirSync(registryDirectory(dataDirectory), { recursive: true, mode: 0o700 })
  writeFileAtomic(
    path.join(registryDirectory(dataDirectory), `${name}.json`),
    JSON.stringify(record) + "\n",
  )
  return record
}

/** Drop a registry entry, for a stage the caller itself just removed. */
export function forgetStage(dataDirectory: string, stage: string) {
  const name = path.basename(stage)
  if (!NAME.test(name)) return
  rmSync(path.join(registryDirectory(dataDirectory), `${name}.json`), { force: true })
}

interface Loaded {
  readonly file: string
  readonly record?: StageRecord
  readonly problem?: string
}

function load(dataDirectory: string): Loaded[] {
  let names: string[]
  try {
    names = readdirSync(registryDirectory(dataDirectory))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name): Loaded => {
      const file = path.join(registryDirectory(dataDirectory), name)
      try {
        const value = JSON.parse(readFileSync(file, "utf8")) as Partial<StageRecord>
        if (
          value.version !== 1 ||
          typeof value.name !== "string" ||
          !NAME.test(value.name) ||
          `${value.name}.json` !== name ||
          typeof value.path !== "string" ||
          typeof value.nonce !== "string" ||
          !/^[a-f0-9]{32}$/.test(value.nonce) ||
          !Number.isInteger(value.dev) ||
          !Number.isInteger(value.ino) ||
          !Number.isInteger(value.uid) ||
          !Number.isInteger(value.pid) ||
          typeof value.startedAt !== "string"
        )
          return { file, problem: "registry entry is malformed" }
        return { file, record: value as StageRecord }
      } catch {
        return { file, problem: "registry entry is unreadable" }
      }
    })
}

function defaultAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function defaultInUse(stage: string) {
  const disk = path.join(stage, "stage.raw")
  try {
    lstatSync(disk)
  } catch {
    return false
  }
  // `lsof -t` prints the PID of every process with the file open and exits 1 when none do.
  const result = Bun.spawnSync(["/usr/sbin/lsof", "-t", "--", disk], {
    stdout: "pipe",
    stderr: "ignore",
  })
  return result.exitCode === 0 && result.stdout.toString().trim() !== ""
}

/** Why this entry's directory must not be removed, or `undefined` if it may be. */
function protection(record: StageRecord, options: StageOptions): string | undefined {
  const root = options.stageRoot ?? STAGE_ROOT
  const uid = options.uid ?? process.getuid?.() ?? -1
  if (record.path !== path.join(root, record.name))
    return "recorded path is not directly under the stage root"
  let metadata: ReturnType<typeof lstatSync>
  try {
    metadata = lstatSync(record.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone"
    return "could not be inspected"
  }
  if (metadata.isSymbolicLink()) return "is now a symbolic link; not followed"
  if (!metadata.isDirectory()) return "is no longer a directory"
  if (metadata.uid !== uid || record.uid !== uid) return "is not owned by this user"
  if (metadata.dev !== record.dev || metadata.ino !== record.ino)
    return "is not the directory that was recorded (identity changed)"
  let marker: { nonce?: unknown }
  try {
    const markerFile = path.join(record.path, MARKER)
    const fd = openSync(markerFile, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      if (!fstatSync(fd).isFile()) return "ownership marker is not a regular file"
      marker = JSON.parse(readFileSync(fd, "utf8"))
    } finally {
      closeSync(fd)
    }
  } catch {
    return "ownership marker is missing or unreadable"
  }
  if (marker.nonce !== record.nonce) return "ownership marker does not match the registry"
  if ((options.isAlive ?? defaultAlive)(record.pid)) return "its session may still be running"
  if ((options.inUse ?? defaultInUse)(record.path)) return "its disk is open in a running process"
  return undefined
}

/** Everything this installation recorded, with the current verdict for each. Read-only. */
export function listStages(dataDirectory: string, options: StageOptions = {}): StageReport[] {
  return load(dataDirectory).map(({ file, record, problem }): StageReport => {
    if (record === undefined)
      return {
        name: path.basename(file),
        path: file,
        disposition: { action: "kept", reason: problem ?? "invalid registry entry" },
      }
    const reason = protection(record, options)
    return {
      name: record.name,
      path: record.path,
      disposition:
        reason === undefined
          ? { action: "removed" }
          : reason === "gone"
            ? { action: "forgotten", reason: "directory already gone" }
            : { action: "kept", reason },
    }
  })
}

/**
 * Remove stages this installation recorded and can prove are its own and idle. Reports every
 * entry in name order, so the result is deterministic and auditable.
 */
export function purgeStages(dataDirectory: string, options: StageOptions = {}): StageReport[] {
  const reports: StageReport[] = []
  for (const { file, record, problem } of load(dataDirectory)) {
    if (record === undefined) {
      reports.push({
        name: path.basename(file),
        path: file,
        disposition: { action: "kept", reason: problem ?? "invalid registry entry" },
      })
      continue
    }
    const reason = protection(record, options)
    if (reason === "gone") {
      rmSync(file, { force: true })
      reports.push({
        name: record.name,
        path: record.path,
        disposition: { action: "forgotten", reason: "directory already gone" },
      })
    } else if (reason !== undefined) {
      reports.push({
        name: record.name,
        path: record.path,
        disposition: { action: "kept", reason },
      })
    } else {
      // The directory is a real, recorded, idle directory of ours. `recursive` removal unlinks
      // symbolic links inside it rather than following them.
      rmSync(record.path, { recursive: true, force: true })
      rmSync(file, { force: true })
      reports.push({ name: record.name, path: record.path, disposition: { action: "removed" } })
    }
  }
  return reports
}

export function renderStageReports(reports: readonly StageReport[], purged: boolean): string {
  if (reports.length === 0) return "no VM stage directories are recorded by this installation"
  return reports
    .map((report) => {
      const d = report.disposition
      const verb =
        d.action === "removed"
          ? purged
            ? "removed"
            : "would remove"
          : d.action === "forgotten"
            ? "forgot entry"
            : "kept"
      return `${verb}  ${report.path}${"reason" in d ? `  (${d.reason})` : ""}`
    })
    .join("\n")
}
