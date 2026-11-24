import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { verifyText } from "@bashwink/evidence"

const ROOT = /^\/private\/tmp\/bashwink-offline-[A-Za-z0-9]+$/
const STATE = "stage.json"
export const STAGED_FILE = "task.txt"
export const SESSION_ID = /^ses_[A-Za-z0-9_-]{1,100}$/
const FILE_LIMIT = 1024 * 1024

export function sha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function identity(stats: { dev: number; ino: number }): string {
  return `${stats.dev}:${stats.ino}`
}

export function directoryIdentity(directory: string): string {
  const stats = lstatSync(directory)
  if (!stats.isDirectory() || realpathSync(directory) !== directory)
    throw new Error("expected a real directory at its registered location")
  return identity(stats)
}

export function regularFile(filename: string, limit = FILE_LIMIT) {
  const fd = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > limit)
      throw new Error("expected a bounded regular file with no extra links")
    const data = Buffer.alloc(before.size)
    let offset = 0
    while (offset < data.length) {
      const bytes = readSync(fd, data, offset, data.length - offset, null)
      if (bytes === 0) break
      offset += bytes
    }
    const after = fstatSync(fd)
    if (
      offset !== data.length ||
      after.size !== before.size ||
      after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error("file changed while it was being inspected")
    return {
      data,
      identity: identity(before),
      mode: before.mode & 0o777,
      revision: sha256(data),
      stamp: `${before.ctimeMs}:${before.mtimeMs}`,
    }
  } finally {
    closeSync(fd)
  }
}

export interface Destination {
  readonly directory: string
  readonly directoryId: string
  readonly fileId: string
  readonly revision: string
  readonly stamp: string
  readonly mode: number
}

interface EvidenceAnchor {
  readonly length: number
  readonly digest: string
}

export interface StageState {
  readonly version: 2
  readonly rootId: string
  readonly workspaceId: string
  readonly scratchId: string
  readonly profile: string
  readonly evidence: EvidenceAnchor
  readonly destination?: Destination
}

export function newStageState(
  root: string,
  profile: string,
  destination?: Destination,
): StageState {
  return {
    version: 2,
    rootId: directoryIdentity(root),
    workspaceId: directoryIdentity(path.join(root, "work")),
    scratchId: directoryIdentity(path.join(root, "scratch")),
    profile,
    evidence: { length: 0, digest: sha256("") },
    ...(destination === undefined ? {} : { destination }),
  }
}

export function readStage(root: string): StageState {
  if (!ROOT.test(root)) throw new Error("offline stage is missing or unrecognized")
  let state: StageState
  try {
    const stats = lstatSync(root)
    if (stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0)
      throw new Error("stage is not private and owned")
    state = JSON.parse(regularFile(path.join(root, STATE), 8192).data.toString()) as StageState
    if (state.version !== 2 || state.rootId !== directoryIdentity(root))
      throw new Error("stage identity changed")
  } catch {
    throw new Error("offline stage is missing or unrecognized")
  }
  if (
    state.workspaceId !== directoryIdentity(path.join(root, "work")) ||
    state.scratchId !== directoryIdentity(path.join(root, "scratch"))
  )
    throw new Error("offline stage workspace or scratch identity changed")
  return state
}

export function lockStage(root: string): () => void {
  const directory = path.join(root, ".active")
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    throw new Error("offline stage is active or was interrupted without a supervised close")
  }
  return () => rmdirSync(directory)
}

export function writeStage(root: string, state: StageState) {
  const temporary = path.join(root, `.stage-${randomUUID()}`)
  const fd = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(fd, JSON.stringify(state) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path.join(root, STATE))
}

export function captureEvidence(root: string, previous: EvidenceAnchor): EvidenceAnchor {
  const directory = path.join(root, "scratch", "evidence")
  directoryIdentity(directory)
  const filename = path.join(directory, "evidence.jsonl")
  let bytes: Buffer
  try {
    bytes = regularFile(filename, 64 * FILE_LIMIT).data
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && previous.length === 0) return previous
    throw error
  }
  if (
    bytes.length < previous.length ||
    sha256(bytes.subarray(0, previous.length)) !== previous.digest ||
    !verifyText(bytes.toString("utf8")).ok
  )
    throw new Error("offline evidence does not extend the saved chain")
  return { length: bytes.length, digest: sha256(bytes) }
}

export function selectSavedSession(root: string, requested?: string): string {
  const data = path.join(root, "scratch", "data")
  const directory = path.join(data, "opencode")
  directoryIdentity(data)
  directoryIdentity(directory)
  const file = path.join(directory, "opencode.db")
  for (const sidecar of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      const stats = lstatSync(sidecar)
      if (!stats.isFile() || stats.nlink !== 1) throw new Error("unsafe native session database")
    } catch (error) {
      if (sidecar === file || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const database = new Database(file, { readonly: true })
  try {
    const workspace = path.join(root, "work")
    const row =
      requested === undefined
        ? database
            .query<{ id: string }, [string]>(
              "SELECT id FROM session_v2 WHERE directory = ? AND workspace_id IS NULL ORDER BY time_updated DESC, id DESC LIMIT 1",
            )
            .get(workspace)
        : database
            .query<{ id: string }, [string, string]>(
              "SELECT id FROM session_v2 WHERE directory = ? AND workspace_id IS NULL AND id = ?",
            )
            .get(workspace, requested)
    if (!row || !SESSION_ID.test(row.id))
      throw new Error("no saved session owned by this offline stage")
    return row.id
  } finally {
    database.close()
  }
}
