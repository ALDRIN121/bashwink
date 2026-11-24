import { dlopen, ptr, read } from "bun:ffi"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { directoryIdentity, sha256 } from "./native-stage.js"
import { vmProjectFile, vmProtectedTest } from "./vm-project.js"

const JOURNAL = "apply.json"
const STAGE = /^\.bashwink-vm-apply-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const INODE = /^\d+:\d+$/
const REVISION = /^[a-f0-9]{64}$/
const STAMP = /^-?\d+(?:\.\d+)?:-?\d+(?:\.\d+)?$/
const MAX_FILE = 1024 * 1024
const MAX_MAP_FILES = 128
const MAX_FILES = 2 * MAX_MAP_FILES
const MAX_TOTAL = 16 * MAX_FILE
const AT_REMOVEDIR = 0x80
const RENAME_SWAP = 0x2
const RENAME_EXCL = 0x4
const ENOENT = 2

interface FileMark {
  readonly identity: string
  readonly revision: string
  readonly mode: number
  readonly stamp: string
}

export interface VmBase extends FileMark {
  readonly data: string
}

interface Entry {
  readonly name: string
  readonly old: FileMark | null
  readonly approved: { readonly revision: string; readonly mode: number } | null
  readonly prepared: FileMark | null
  readonly installed: FileMark | null
}

interface Journal {
  readonly version: 1
  readonly rootId: string
  readonly workspaceId: string
  readonly stage: string
  readonly stageId: string | null
  readonly phase: "preparing" | "ready" | "committed"
  readonly entries: readonly Entry[]
}

interface Receipt {
  readonly version: 1
  readonly outcome: "committed"
  readonly rootId: string
  readonly workspaceId: string
  readonly files: readonly {
    readonly name: string
    readonly before: FileMark | null
    readonly after: FileMark | null
  }[]
}

interface AbandonedReceipt {
  readonly version: 1
  readonly outcome: "abandoned-before-mutation"
  readonly rootId: string
  readonly workspaceId: string
  readonly stage: string
}

interface ReviewIO {
  readonly assertProject?: () => void
  readonly approve: (diff: string) => Promise<boolean>
  readonly checkpoint?: (
    phase:
      | "journaled"
      | "stage-created"
      | "prepared"
      | "before-mutation"
      | "checked"
      | "mutated"
      | "committed"
      | "cleaned",
    filename?: string,
  ) => void
}

function openApi() {
  if (process.platform !== "darwin") throw new Error("reviewed VM project apply requires macOS")
  return dlopen("/usr/lib/libSystem.B.dylib", {
    __error: { args: [], returns: "ptr" },
    openat: { args: ["int", "ptr", "int"], returns: "int" },
    mkdirat: { args: ["int", "ptr", "int"], returns: "int" },
    renameatx_np: { args: ["int", "ptr", "int", "ptr", "u32"], returns: "int" },
    unlinkat: { args: ["int", "ptr", "int"], returns: "int" },
  })
}

function cString(name: string) {
  return Buffer.from(name + "\0")
}

function statsIdentity(stats: { dev: number; ino: number }) {
  return `${stats.dev}:${stats.ino}`
}

function statsStamp(stats: { ctimeMs: number; mtimeMs: number }) {
  return `${stats.ctimeMs}:${stats.mtimeMs}`
}

class ApplyDirectories {
  private readonly api = openApi()
  readonly root: number
  readonly workspace: number
  readonly rootId: string
  readonly workspaceId: string

  constructor(
    readonly rootPath: string,
    readonly workspacePath: string,
  ) {
    let root: number | undefined
    let workspace: number | undefined
    try {
      const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
      root = openSync(rootPath, flags)
      workspace = openSync(workspacePath, flags)
      this.root = root
      this.workspace = workspace
      this.rootId = this.privateDirectoryId(root)
      this.workspaceId = statsIdentity(fstatSync(workspace))
      this.assertBound()
      if (this.rootId === this.workspaceId) throw new Error("invalid VM apply directories")
    } catch (error) {
      if (workspace !== undefined) closeSync(workspace)
      if (root !== undefined) closeSync(root)
      this.api.close()
      throw error
    }
  }

  close() {
    closeSync(this.workspace)
    closeSync(this.root)
    this.api.close()
  }

  assertBound() {
    if (
      this.privateDirectoryId(this.root) !== this.rootId ||
      directoryIdentity(this.rootPath) !== this.rootId ||
      directoryIdentity(this.workspacePath) !== this.workspaceId
    )
      throw new Error("reviewed VM apply directory identity changed")
  }

  private errno() {
    const address = this.api.symbols.__error()
    if (address === null) throw new Error("cannot determine native VM apply failure")
    return read.i32(address, 0)
  }

  privateDirectoryId(fd: number) {
    const stats = fstatSync(fd)
    if (!stats.isDirectory() || stats.uid !== process.getuid?.() || (stats.mode & 0o077) !== 0)
      throw new Error("reviewed VM apply directory must be private and owned")
    return statsIdentity(stats)
  }

  openOptional(dir: number, name: string, flags: number) {
    const bytes = cString(name)
    const fd = this.api.symbols.openat(dir, ptr(bytes), flags | constants.O_NOFOLLOW)
    if (fd >= 0) return fd
    const errno = this.errno()
    if (errno !== ENOENT) throw new Error(`cannot inspect ${name} (errno ${errno})`)
  }

  readOptional(dir: number, name: string, limit = MAX_FILE) {
    const fd = this.openOptional(dir, name, constants.O_RDONLY | constants.O_NONBLOCK)
    if (fd === undefined) return undefined
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.nlink !== 1 || before.size > limit || before.mode & 0o7000)
        throw new Error(
          `${name} must be a bounded regular file with no extra links or special modes`,
        )
      const data = Buffer.alloc(before.size)
      let offset = 0
      while (offset < data.length) {
        const length = readSync(fd, data, offset, data.length - offset, null)
        if (length === 0) break
        offset += length
      }
      const after = fstatSync(fd)
      if (
        offset !== data.length ||
        after.size !== before.size ||
        after.mode !== before.mode ||
        after.nlink !== 1 ||
        statsStamp(after) !== statsStamp(before)
      )
        throw new Error(`${name} changed while being inspected`)
      return {
        data,
        identity: statsIdentity(before),
        revision: sha256(data),
        mode: before.mode & 0o777,
        stamp: statsStamp(before),
      }
    } finally {
      closeSync(fd)
    }
  }

  move(from: number, src: string, to: number, dst: string, flags: number) {
    const source = cString(src)
    const target = cString(dst)
    if (this.api.symbols.renameatx_np(from, ptr(source), to, ptr(target), flags) !== 0)
      throw new Error(`atomic move of ${src} to ${dst} failed (errno ${this.errno()})`)
  }

  unlink(dir: number, name: string, flags = 0) {
    const bytes = cString(name)
    if (this.api.symbols.unlinkat(dir, ptr(bytes), flags) !== 0)
      throw new Error(`could not remove ${name} (errno ${this.errno()})`)
  }

  createStage(name: string) {
    const bytes = cString(name)
    if (this.api.symbols.mkdirat(this.workspace, ptr(bytes), 0o700) !== 0)
      throw new Error(`could not create ${name} (errno ${this.errno()})`)
    fsyncSync(this.workspace)
  }

  openStage(journal: Journal) {
    const stage = this.openOptional(
      this.workspace,
      journal.stage,
      constants.O_RDONLY | constants.O_DIRECTORY,
    )
    if (stage === undefined) return undefined
    try {
      if (this.privateDirectoryId(stage) !== journal.stageId)
        throw new Error(
          `VM apply staging identity uncertain. Inspect ${path.join(this.workspacePath, journal.stage)}`,
        )
      return stage
    } catch (error) {
      closeSync(stage)
      throw error
    }
  }

  assertStage(journal: Journal, stage: number) {
    this.assertBound()
    const current = this.openStage(journal)
    if (current === undefined) throw new Error("VM apply staging directory disappeared")
    closeSync(current)
    if (this.privateDirectoryId(stage) !== journal.stageId)
      throw new Error("VM apply staging descriptor identity changed")
  }

  writeExclusive(directory: string, name: string, bytes: Uint8Array, mode: number) {
    const file = openSync(path.join(directory, name), "wx", 0o600)
    try {
      writeFileSync(file, bytes)
      fchmodSync(file, mode)
      fsyncSync(file)
      return statsIdentity(fstatSync(file))
    } finally {
      closeSync(file)
    }
  }

  writeJournal(journal: Journal, initial = false) {
    this.writeRecord(JOURNAL, journal, initial)
  }

  writeRecord(name: string, record: Journal | Receipt | AbandonedReceipt, exclusive: boolean) {
    this.assertBound()
    const temporary = `.apply-${randomUUID()}`
    const bytes = recordBytes(record)
    const identity = this.writeExclusive(this.rootPath, temporary, bytes, 0o600)
    const saved = this.readOptional(this.root, temporary)
    if (saved?.identity !== identity || saved.revision !== sha256(bytes))
      throw new Error("VM apply record changed before publication")
    this.move(this.root, temporary, this.root, name, exclusive ? RENAME_EXCL : 0)
    fsyncSync(this.root)
  }
}

function mark(value: FileMark): FileMark {
  return {
    identity: value.identity,
    revision: value.revision,
    mode: value.mode,
    stamp: value.stamp,
  }
}

function validMode(mode: number) {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o777
}

function validMark(file: FileMark) {
  return (
    typeof file === "object" &&
    file !== null &&
    typeof file.identity === "string" &&
    INODE.test(file.identity) &&
    typeof file.revision === "string" &&
    REVISION.test(file.revision) &&
    typeof file.stamp === "string" &&
    STAMP.test(file.stamp) &&
    validMode(file.mode)
  )
}

function validEntry(entry: Entry, phase: Journal["phase"]) {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.name === "string" &&
    vmProjectFile(entry.name) &&
    !vmProtectedTest(entry.name) &&
    (entry.old === null || validMark(entry.old)) &&
    (entry.approved === null ||
      (typeof entry.approved === "object" &&
        typeof entry.approved.revision === "string" &&
        REVISION.test(entry.approved.revision) &&
        entry.approved.mode === (entry.old?.mode ?? 0o644))) &&
    entry.old?.revision !== entry.approved?.revision &&
    (phase === "preparing" || entry.approved === null
      ? entry.prepared === null
      : validMark(entry.prepared!) &&
        entry.prepared!.identity !== entry.old?.identity &&
        entry.prepared!.revision === entry.approved.revision &&
        entry.prepared!.mode === entry.approved.mode) &&
    (phase === "committed" && entry.prepared !== null
      ? validMark(entry.installed!) && same(entry.installed!, entry.prepared, true)
      : entry.installed === null)
  )
}

function uniqueNames(names: readonly string[]) {
  return new Set(names.map((name) => name.toLowerCase())).size === names.length
}

function recordBytes(record: Journal | Receipt | AbandonedReceipt) {
  const checksum = sha256(JSON.stringify(record))
  return Buffer.from(JSON.stringify({ checksum, record }) + "\n")
}

function readJournal(dirs: ApplyDirectories): Journal | undefined {
  const file = dirs.readOptional(dirs.root, JOURNAL)
  if (file === undefined) return undefined
  try {
    const { checksum, record: journal } = JSON.parse(file.data.toString()) as {
      checksum: string
      record: Journal
    }
    if (
      file.mode !== 0o600 ||
      typeof checksum !== "string" ||
      checksum !== sha256(JSON.stringify(journal)) ||
      journal.version !== 1 ||
      journal.rootId !== dirs.rootId ||
      journal.workspaceId !== dirs.workspaceId ||
      typeof journal.stage !== "string" ||
      !STAGE.test(journal.stage) ||
      (journal.phase !== "preparing" &&
        journal.phase !== "ready" &&
        journal.phase !== "committed") ||
      !(
        (journal.phase === "preparing" && journal.stageId === null) ||
        (typeof journal.stageId === "string" && INODE.test(journal.stageId))
      ) ||
      !Array.isArray(journal.entries) ||
      journal.entries.length === 0 ||
      journal.entries.length > MAX_FILES ||
      !journal.entries.every((entry) => validEntry(entry, journal.phase)) ||
      !uniqueNames(journal.entries.map((entry) => entry.name))
    )
      throw new Error()
    return journal
  } catch {
    throw new Error("invalid VM apply journal. Host files and staging were retained")
  }
}

function same(actual: FileMark | undefined, expected: FileMark | null, moved = false) {
  if (expected === null) return actual === undefined
  return (
    actual !== undefined &&
    actual.identity === expected.identity &&
    actual.revision === expected.revision &&
    actual.mode === expected.mode &&
    // Renaming changes ctime on Darwin. The inode, content, mode and mtime still bind it.
    (moved
      ? actual.stamp.split(":")[1] === expected.stamp.split(":")[1]
      : actual.stamp === expected.stamp)
  )
}

function slot(index: number) {
  return `entry-${index}`
}

type Progress = "pending" | "applied" | "uncertain"

function inspectEntry(
  dirs: ApplyDirectories,
  stage: number | undefined,
  entry: Entry,
  index: number,
  committed: boolean,
): Progress {
  try {
    const saved = stage === undefined ? undefined : dirs.readOptional(stage, slot(index))
    const file = dirs.readOptional(dirs.workspace, entry.name)
    if (
      same(file, committed ? entry.installed : entry.prepared, !committed) &&
      (same(saved, entry.old, true) || (committed && saved === undefined))
    )
      return "applied"
    if (!committed && same(file, entry.old) && same(saved, entry.prepared)) return "pending"
  } catch {
    // An unreadable or unsafe object is ambiguous. Keep it and the journal intact.
  }
  return "uncertain"
}

function readProgress(dirs: ApplyDirectories, stage: number | undefined, journal: Journal) {
  return journal.entries.map((entry, index) => ({
    name: entry.name,
    state: inspectEntry(dirs, stage, entry, index, journal.phase === "committed"),
  }))
}

function formatProgress(progress: ReturnType<typeof readProgress>) {
  return progress.map(({ name, state }) => `${name}=${state}`).join(", ")
}

function inspectBatch(dirs: ApplyDirectories, stage: number | undefined, journal: Journal) {
  const progress = readProgress(dirs, stage, journal)
  if (progress.some(({ state }) => state === "uncertain"))
    throw new Error(
      `reviewed VM apply needs recovery. Retained ${path.join(dirs.workspacePath, journal.stage)}. ` +
        formatProgress(progress),
    )
  return progress
}

function cleanup(dirs: ApplyDirectories, stage: number | undefined, journal: Journal) {
  if (stage !== undefined) {
    dirs.assertStage(journal, stage)
    for (let index = 0; index < journal.entries.length; index++) {
      const name = slot(index)
      const file = dirs.readOptional(stage, name)
      if (file !== undefined) {
        if (journal.phase === "committed" && !same(file, journal.entries[index]!.old, true))
          throw new Error(`ambiguous staged file ${name}. Retained the VM apply journal`)
        dirs.unlink(stage, name)
      }
    }
    fsyncSync(stage)
    dirs.assertStage(journal, stage)
    dirs.unlink(dirs.workspace, journal.stage, AT_REMOVEDIR)
    fsyncSync(dirs.workspace)
  }
  dirs.assertBound()
  dirs.unlink(dirs.root, JOURNAL)
  fsyncSync(dirs.root)
}

function publishReceipt(dirs: ApplyDirectories, journal: Journal) {
  const name = `apply-receipt-${journal.stage.slice(".bashwink-vm-apply-".length)}.json`
  const receipt: Receipt = {
    version: 1,
    outcome: "committed",
    rootId: journal.rootId,
    workspaceId: journal.workspaceId,
    files: journal.entries.map(({ name, old, installed }) => ({
      name,
      before: old,
      after: installed,
    })),
  }
  const existing = dirs.readOptional(dirs.root, name)
  if (existing === undefined) {
    dirs.writeRecord(name, receipt, true)
  } else {
    if (existing.mode !== 0o600 || !existing.data.equals(recordBytes(receipt)))
      throw new Error("committed VM apply receipt is ambiguous. Retained the journal")
    fsyncSync(dirs.root)
  }
}

function restoreConcurrentOverwrite(
  dirs: ApplyDirectories,
  stage: number,
  journal: Journal,
  entry: Entry,
  index: number,
) {
  if (entry.old === null || entry.prepared === null) return false
  try {
    dirs.assertStage(journal, stage)
    const name = slot(index)
    const displaced = dirs.readOptional(stage, name)
    const installed = dirs.readOptional(dirs.workspace, entry.name)
    if (
      displaced === undefined ||
      same(displaced, entry.old, true) ||
      !same(installed, entry.prepared, true)
    )
      return false
    dirs.move(stage, name, dirs.workspace, entry.name, RENAME_SWAP)
    fsyncSync(dirs.workspace)
    fsyncSync(stage)
    return (
      same(dirs.readOptional(stage, name), entry.prepared, true) &&
      same(dirs.readOptional(dirs.workspace, entry.name), displaced, true)
    )
  } catch {
    // Neither location permits cleanup until identity and content agree with the journal.
    return false
  }
}

function finish(
  dirs: ApplyDirectories,
  stage: number | undefined,
  journal: Journal,
  io?: Pick<ReviewIO, "assertProject" | "checkpoint">,
) {
  dirs.assertBound()
  if (journal.phase === "preparing") {
    cleanup(dirs, stage, journal)
    return
  }

  const progress = inspectBatch(dirs, stage, journal)
  if (journal.phase === "ready") {
    if (stage === undefined) throw new Error("reviewed VM apply staging directory is missing")
    for (let index = 0; index < journal.entries.length; index++) {
      if (progress[index]!.state === "applied") continue
      const entry = journal.entries[index]!
      try {
        io?.checkpoint?.("before-mutation", entry.name)
        io?.assertProject?.()
        dirs.assertStage(journal, stage)
        if (inspectEntry(dirs, stage, entry, index, false) !== "pending")
          throw new Error(`host base or staged proposal changed before applying ${entry.name}`)
        io?.checkpoint?.("checked", entry.name)
        if (entry.prepared === null) {
          dirs.move(dirs.workspace, entry.name, stage, slot(index), RENAME_EXCL)
        } else {
          dirs.move(
            stage,
            slot(index),
            dirs.workspace,
            entry.name,
            entry.old === null ? RENAME_EXCL : RENAME_SWAP,
          )
        }
        io?.checkpoint?.("mutated", entry.name)
        if (inspectEntry(dirs, stage, entry, index, false) !== "applied") {
          if (restoreConcurrentOverwrite(dirs, stage, journal, entry, index))
            throw new Error(`Restored the concurrent host edit for ${entry.name}`)
          throw new Error(`atomic apply outcome for ${entry.name} is uncertain`)
        }
        fsyncSync(dirs.workspace)
        fsyncSync(stage)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(
          `${message}. Retained ${path.join(dirs.workspacePath, journal.stage)}. ` +
            formatProgress(readProgress(dirs, stage, journal)),
          { cause: error },
        )
      }
    }
    if (inspectBatch(dirs, stage, journal).some(({ state }) => state !== "applied"))
      throw new Error("approved VM apply would leave a partial result")
    dirs.assertStage(journal, stage)
    fsyncSync(dirs.workspace)
    fsyncSync(stage)
    const entries = journal.entries.map((entry) => {
      const actual = dirs.readOptional(dirs.workspace, entry.name)
      if (!same(actual, entry.prepared, true))
        throw new Error(`installed VM apply path changed before commit: ${entry.name}`)
      return { ...entry, installed: actual === undefined ? null : mark(actual) }
    })
    journal = { ...journal, phase: "committed", entries }
    dirs.writeJournal(journal)
  }
  inspectBatch(dirs, stage, journal)
  publishReceipt(dirs, journal)
  io?.checkpoint?.("committed")
  cleanup(dirs, stage, journal)
  io?.checkpoint?.("cleaned")
}

export function vmProjectApplyPending(root: string): boolean {
  try {
    lstatSync(path.join(root, JOURNAL))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export function recoverVmProject(
  root: string,
  workspace: string,
  assertProject?: () => void,
  checkpoint?: () => void,
): void {
  if (!vmProjectApplyPending(root)) return
  const dirs = new ApplyDirectories(root, workspace)
  try {
    const journal = readJournal(dirs)
    if (journal === undefined) throw new Error("VM apply journal disappeared before recovery")
    if (journal.phase === "preparing" && journal.stageId === null) {
      assertProject?.()
      ensureUnchanged(dirs, journal.entries)
      const receipt: AbandonedReceipt = {
        version: 1,
        outcome: "abandoned-before-mutation",
        rootId: journal.rootId,
        workspaceId: journal.workspaceId,
        stage: journal.stage,
      }
      const name = `apply-abandoned-${journal.stage.slice(".bashwink-vm-apply-".length)}.json`
      const existing = dirs.readOptional(dirs.root, name)
      if (existing === undefined) dirs.writeRecord(name, receipt, true)
      else if (existing.mode !== 0o600 || !existing.data.equals(recordBytes(receipt)))
        throw new Error("ambiguous abandoned VM apply record. Journal retained")
      checkpoint?.()
      dirs.assertBound()
      dirs.unlink(dirs.root, JOURNAL)
      fsyncSync(dirs.root)
      process.stdout.write(
        `Unidentified VM apply staging, if present, remains at ${path.join(workspace, journal.stage)}.\n`,
      )
      return
    }
    const stage = dirs.openStage(journal)
    try {
      finish(dirs, stage, journal, assertProject === undefined ? undefined : { assertProject })
    } finally {
      if (stage !== undefined) closeSync(stage)
    }
  } finally {
    dirs.close()
  }
}

function content(value: string) {
  if (typeof value !== "string" || value.length > 4 * Math.ceil(MAX_FILE / 3))
    throw new Error("VM apply file exceeds its size limit")
  const bytes = Buffer.from(value, "base64")
  if (bytes.length > MAX_FILE || bytes.toString("base64") !== value)
    throw new Error("VM apply file has invalid base64")
  return bytes
}

function lines(bytes: Uint8Array, prefix: "-" | "+") {
  const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  for (const character of value) {
    const code = character.codePointAt(0)!
    if (
      (code < 32 && character !== "\n" && character !== "\t") ||
      (code >= 127 && code <= 159) ||
      /[\p{Cf}\p{Zl}\p{Zp}]/u.test(character)
    )
      throw new Error("VM apply requires reviewable UTF-8 text")
  }
  if (value.length === 0) return []
  const split = value.split("\n")
  const terminated = split.at(-1) === ""
  if (terminated) split.pop()
  const result = split.map((line) => `${prefix} ${line}`)
  if (!terminated) result.push("\\ No newline at end of file")
  return result
}

interface ProposedEdit {
  readonly entry: Entry
  readonly before: Buffer | null
  readonly after: Buffer | null
}

function buildReview(
  base: Record<string, VmBase>,
  proposed: Record<string, string>,
  selected?: readonly string[],
) {
  const baseNames = Object.keys(base)
  const proposedNames = Object.keys(proposed)
  const names = [...new Set([...baseNames, ...proposedNames])].sort()
  if (
    baseNames.length > MAX_MAP_FILES ||
    proposedNames.length > MAX_MAP_FILES ||
    !uniqueNames(names) ||
    names.some((name) => !vmProjectFile(name))
  )
    throw new Error("VM apply contains invalid or conflicting source names")
  if (selected && (!uniqueNames(selected) || selected.some((name) => !names.includes(name))))
    throw new Error("VM apply selection contains invalid or duplicate names")

  const edits: ProposedEdit[] = []
  let size = 0
  for (const name of names) {
    const recorded = Object.hasOwn(base, name) ? base[name] : undefined
    const offered = Object.hasOwn(proposed, name) ? proposed[name] : undefined
    if (recorded?.data === offered) continue
    if (selected && !selected.includes(name)) continue
    if (vmProtectedTest(name)) throw new Error(`VM apply refused protected test ${name}`)
    const before = recorded === undefined ? null : content(recorded.data)
    const after = offered === undefined ? null : content(offered)
    size += (before?.length ?? 0) + (after?.length ?? 0)
    if (size > MAX_TOTAL)
      throw new Error("VM apply diff exceeds its size limit. Select fewer changed files.")
    if (recorded !== undefined && (!validMark(recorded) || recorded.revision !== sha256(before!)))
      throw new Error(`invalid host base for ${name}`)
    const old = recorded === undefined ? null : mark(recorded)
    const approved = after === null ? null : { revision: sha256(after), mode: old?.mode ?? 0o644 }
    edits.push({ entry: { name, old, approved, prepared: null, installed: null }, before, after })
  }
  if (selected && edits.length !== selected.length)
    throw new Error("VM apply selection must name changed files")
  return edits
}

function ensureUnchanged(dirs: ApplyDirectories, entries: readonly Entry[]) {
  dirs.assertBound()
  for (const entry of entries) {
    if (!same(dirs.readOptional(dirs.workspace, entry.name), entry.old))
      throw new Error(`host base for ${entry.name} changed since import`)
  }
}

export async function reviewVmProjectWithApproval(
  root: string,
  workspace: string,
  base: Record<string, VmBase>,
  proposed: Record<string, string>,
  selected: readonly string[] | undefined,
  io: ReviewIO,
): Promise<boolean> {
  const edits = buildReview(base, proposed, selected)
  const dirs = new ApplyDirectories(root, workspace)
  try {
    if (vmProjectApplyPending(root)) throw new Error("recover the interrupted VM apply first")
    if (edits.length === 0) {
      process.stdout.write("No selected VM project changes.\n")
      return false
    }
    const entries = edits.map(({ entry }) => entry)
    ensureUnchanged(dirs, entries)
    const preview = edits.flatMap(({ entry, before, after }) => [
      `@@ ${entry.name} (${before === null ? "added" : after === null ? "deleted" : "modified"}) @@`,
      ...(before === null ? [] : lines(before, "-")),
      ...(after === null ? [] : lines(after, "+")),
    ])
    if (!(await io.approve(preview.join("\n") + "\n"))) return false

    io.assertProject?.()
    ensureUnchanged(dirs, entries)
    let journal: Journal = {
      version: 1,
      rootId: dirs.rootId,
      workspaceId: dirs.workspaceId,
      stage: `.bashwink-vm-apply-${randomUUID()}`,
      stageId: null,
      phase: "preparing",
      entries,
    }
    dirs.writeJournal(journal, true)
    io.checkpoint?.("journaled")
    dirs.createStage(journal.stage)
    io.checkpoint?.("stage-created")
    const stage = dirs.openOptional(
      dirs.workspace,
      journal.stage,
      constants.O_RDONLY | constants.O_DIRECTORY,
    )
    if (stage === undefined) throw new Error("VM apply staging directory disappeared")
    try {
      journal = { ...journal, stageId: dirs.privateDirectoryId(stage) }
      dirs.writeJournal(journal)
      const prepared = edits.map(({ entry, after }, index) => {
        if (after === null) return entry
        dirs.assertStage(journal, stage)
        const name = slot(index)
        const identity = dirs.writeExclusive(
          path.join(workspace, journal.stage),
          name,
          after,
          entry.approved!.mode,
        )
        const file = dirs.readOptional(stage, name)
        if (
          file?.identity !== identity ||
          file.revision !== entry.approved!.revision ||
          file.mode !== entry.approved!.mode
        )
          throw new Error(`VM apply preparation changed for ${entry.name}`)
        return { ...entry, prepared: mark(file) }
      })
      fsyncSync(stage)
      ensureUnchanged(dirs, entries)
      journal = { ...journal, phase: "ready", entries: prepared }
      dirs.writeJournal(journal)
      io.checkpoint?.("prepared")
      finish(dirs, stage, journal, io)
      return true
    } finally {
      closeSync(stage)
    }
  } finally {
    dirs.close()
  }
}

export async function reviewVmProject(
  root: string,
  workspace: string,
  base: Record<string, VmBase>,
  proposed: Record<string, string>,
  selected?: readonly string[],
  assertProject?: () => void,
): Promise<void> {
  const applied = await reviewVmProjectWithApproval(root, workspace, base, proposed, selected, {
    ...(assertProject === undefined ? {} : { assertProject }),
    approve: async (diff) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY)
        throw new Error("reviewed VM apply requires explicit approval in an interactive terminal")
      process.stdout.write(diff)
      const approval = createInterface({ input: process.stdin, output: process.stdout })
      const cancel = new AbortController()
      approval.on("SIGINT", () => cancel.abort())
      try {
        const answer = await approval.question("Type apply to apply the selected changes: ", {
          signal: cancel.signal,
        })
        if (answer === "apply") return true
        process.stdout.write("VM project apply cancelled.\n")
        return false
      } finally {
        approval.close()
      }
    },
  })
  if (applied) process.stdout.write("Applied reviewed VM project changes.\n")
}
