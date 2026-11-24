import { dlopen, ptr } from "bun:ffi"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { acquireNativeLifetime, retireNativeActivation } from "./native-lifetime.js"
import { createInterface } from "node:readline/promises"
import {
  directoryIdentity,
  lockStage,
  readStage,
  regularFile,
  STAGED_FILE,
  syncDirectory,
  type Destination,
} from "./native-stage.js"

const INTENT = "export.json"
const RECEIPT = ".export-receipt.json"
type ExportCheckpoint = (phase: "prepared" | "exchanged" | "recorded" | "cleaned") => void

interface ExportIntent {
  readonly version: 1
  readonly rootId: string
  readonly lockId: string
  readonly directoryId: string
  readonly baseId: string
  readonly baseRevision: string
  readonly mode: number
  readonly preparedId: string
  readonly approvedRevision: string
  readonly temporary: string
}

function readOptionalFile(filename: string) {
  try {
    return regularFile(filename)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

function writeExportRecord(directory: string, name: string, value: object) {
  const temporary = path.join(directory, `.export-record-${randomUUID()}`)
  const fd = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, path.join(directory, name))
  syncDirectory(directory)
}

function requireDestinationDirectory(destination: Destination) {
  if (
    process.cwd() !== destination.directory ||
    directoryIdentity(destination.directory) !== destination.directoryId
  )
    throw new Error("run staged export from its original, unchanged host directory")
}

function finalizeExport(
  root: string,
  intent: ExportIntent,
  destination: Destination,
  checkpoint?: ExportCheckpoint,
) {
  requireDestinationDirectory(destination)
  const target = regularFile(STAGED_FILE)
  const displaced = readOptionalFile(intent.temporary)
  const receipt = { ...intent, outcome: "committed" }
  const existing = readOptionalFile(path.join(root, RECEIPT))
  const sameReceipt = existing?.data.toString() === JSON.stringify(receipt) + "\n"
  if (
    target.identity !== intent.preparedId ||
    target.revision !== intent.approvedRevision ||
    target.mode !== intent.mode ||
    (displaced === undefined
      ? !sameReceipt
      : displaced.identity !== intent.baseId ||
        displaced.revision !== intent.baseRevision ||
        displaced.mode !== intent.mode) ||
    (existing !== undefined && !sameReceipt)
  )
    throw new Error("staged export outcome is uncertain; retained the files for review")

  // The exchange becomes durable before receipt publication. A receipt permits an
  // idempotent retry even if cleanup already removed the verified displaced file.
  syncDirectory(".")
  if (!sameReceipt) writeExportRecord(root, RECEIPT, receipt)
  syncDirectory(root)
  checkpoint?.("recorded")
  if (displaced !== undefined) {
    unlinkSync(intent.temporary)
    syncDirectory(".")
  }
  checkpoint?.("cleaned")
  retireNativeActivation(root, INTENT)
  syncDirectory(root)
}

export function recoverNativeExport(root: string): boolean {
  readStage(root)
  const lifetime = acquireNativeLifetime(root, false)
  try {
    const state = readStage(root)
    const destination = state.destination
    const active = path.join(root, ".active")
    try {
      directoryIdentity(active)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
      throw error
    }
    const entries = readdirSync(active)
    if (entries.length !== 1 || entries[0] !== INTENT || destination === undefined)
      throw new Error("no verified interrupted staged export")
    requireDestinationDirectory(destination)
    const intent = JSON.parse(
      regularFile(path.join(active, INTENT), 8192).data.toString(),
    ) as ExportIntent
    if (
      intent.version !== 1 ||
      intent.rootId !== state.rootId ||
      intent.lockId !== lifetime.identity ||
      intent.directoryId !== destination.directoryId ||
      intent.baseId !== destination.fileId ||
      intent.baseRevision !== destination.revision ||
      intent.mode !== destination.mode ||
      typeof intent.preparedId !== "string" ||
      !/^\d+:\d+$/.test(intent.preparedId) ||
      intent.preparedId === intent.baseId ||
      !/^[a-f0-9]{64}$/.test(intent.approvedRevision) ||
      intent.approvedRevision === intent.baseRevision ||
      !/^\.bashwink-export-[a-f0-9-]{36}$/.test(intent.temporary)
    )
      throw new Error("invalid staged export intent")
    const target = regularFile(STAGED_FILE)
    if (
      target.identity === intent.baseId &&
      target.revision === intent.baseRevision &&
      target.mode === intent.mode &&
      readOptionalFile(path.join(root, RECEIPT)) === undefined
    ) {
      const proposal = readOptionalFile(intent.temporary)
      if (proposal !== undefined) {
        if (
          proposal.identity !== intent.preparedId ||
          proposal.revision !== intent.approvedRevision ||
          proposal.mode !== intent.mode
        )
          throw new Error("staged export outcome is uncertain; retained the files for review")
        unlinkSync(intent.temporary)
      }
      syncDirectory(".")
      retireNativeActivation(root, INTENT)
      syncDirectory(root)
    } else {
      finalizeExport(root, intent, destination)
    }
    return true
  } finally {
    lifetime.close()
  }
}

export function snapshotDestination() {
  const directory = process.cwd()
  const directoryId = directoryIdentity(directory)
  const file = regularFile(STAGED_FILE)
  const destination: Destination = {
    directory,
    directoryId,
    fileId: file.identity,
    revision: file.revision,
    stamp: file.stamp,
    mode: file.mode,
  }
  return { destination, data: file.data }
}

function unchanged(destination: Destination) {
  requireDestinationDirectory(destination)
  const file = regularFile(STAGED_FILE)
  if (
    file.identity !== destination.fileId ||
    file.revision !== destination.revision ||
    file.mode !== destination.mode ||
    file.stamp !== destination.stamp
  )
    throw new Error("staged export refused: host base or destination identity changed")
  return file
}

function safeTerminal(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    if (
      (code < 32 && ch !== "\n" && ch !== "\t") ||
      (code >= 127 && code <= 159) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    )
      throw new Error("staged export requires reviewable UTF-8 text")
  }
  return text
}

export async function exportNativeStage(root: string, checkpoint?: ExportCheckpoint) {
  readStage(root)
  if (process.platform !== "darwin") throw new Error("staged export requires macOS")
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("staged export requires explicit approval in an interactive terminal")
  const lifetime = acquireNativeLifetime(root, true)
  let unlock: (() => void) | undefined
  try {
    unlock = lockStage(root)
    const { destination, rootId } = readStage(root)
    if (destination === undefined) throw new Error("this stage has no approved host destination")
    const receipt = path.join(root, RECEIPT)
    if (readOptionalFile(receipt) !== undefined)
      throw new Error("this stage already has a committed export")
    const base = unchanged(destination)
    const staged = regularFile(path.join(root, "work", STAGED_FILE))
    if (base.revision === staged.revision) {
      process.stdout.write("No staged changes.\n")
      return
    }
    // A bounded full-file diff avoids invoking project tools or rendering guest-controlled escape sequences.
    const oldLines = safeTerminal(base.data).split("\n")
    const newLines = safeTerminal(staged.data).split("\n")
    const diff = [
      "@@ task.txt @@",
      ...oldLines.map((line) => `- ${line}`),
      ...newLines.map((line) => `+ ${line}`),
    ]
    process.stdout.write(diff.join("\n") + "\n")
    const approval = createInterface({ input: process.stdin, output: process.stdout })
    const cancel = new AbortController()
    approval.on("SIGINT", () => cancel.abort())
    try {
      const answer = await approval.question("Type apply to replace host task.txt: ", {
        signal: cancel.signal,
      })
      if (answer !== "apply") {
        process.stdout.write("Staged export cancelled.\n")
        return
      }
    } finally {
      approval.close()
    }

    // Open the kernel's current directory and use a single atomic exchange on the same volume.
    // Retain the displaced file until its exact content and identity have been checked.
    const dir = openSync(".", constants.O_RDONLY | constants.O_DIRECTORY)
    const temporary = `.bashwink-export-${randomUUID()}`
    let created = false
    let retain = false
    try {
      unchanged(destination)
      const currentStage = regularFile(path.join(root, "work", STAGED_FILE))
      if (currentStage.identity !== staged.identity || currentStage.revision !== staged.revision)
        throw new Error("staged file changed after preview")
      const fd = openSync(temporary, "wx", 0o600)
      created = true
      try {
        writeFileSync(fd, staged.data)
        fchmodSync(fd, destination.mode)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      const prepared = regularFile(temporary)
      const intent: ExportIntent = {
        version: 1,
        rootId,
        lockId: lifetime.identity,
        directoryId: destination.directoryId,
        baseId: base.identity,
        baseRevision: base.revision,
        mode: base.mode,
        preparedId: prepared.identity,
        approvedRevision: prepared.revision,
        temporary,
      }
      const api = dlopen("/usr/lib/libSystem.B.dylib", {
        renameatx_np: { args: ["int", "ptr", "int", "ptr", "u32"], returns: "int" },
      })
      const swap = () => {
        const source = Buffer.from(temporary + "\0")
        const target = Buffer.from(STAGED_FILE + "\0")
        return api.symbols.renameatx_np(dir, ptr(source), dir, ptr(target), 2) === 0 // Darwin RENAME_SWAP
      }
      try {
        unchanged(destination)
        fsyncSync(dir)
        // From publication onward, only verified retirement may clear the marker.
        unlock = undefined
        retain = true
        writeExportRecord(path.join(root, ".active"), INTENT, intent)
        syncDirectory(root)
        checkpoint?.("prepared")
        unchanged(destination)
        if (!swap()) throw new Error("filesystem refused atomic staged export")
        checkpoint?.("exchanged")
        let matched = false
        try {
          const displaced = regularFile(temporary)
          matched =
            displaced.identity === base.identity &&
            displaced.revision === base.revision &&
            displaced.mode === base.mode
        } catch {
          // A replaced destination may be a symlink or special file. Never follow it.
        }
        if (!matched) {
          let restored = false
          try {
            const installed = regularFile(STAGED_FILE)
            restored =
              installed.identity === prepared.identity &&
              installed.revision === prepared.revision &&
              swap()
          } catch {
            // Keep the displaced version available if another writer moved the new file.
          }
          if (!restored)
            throw new Error("host destination changed during export; both versions were preserved")
          throw new Error("staged export refused a concurrent host edit and restored it")
        }
        finalizeExport(root, intent, destination, checkpoint)
        created = false
        retain = false
      } finally {
        api.close()
      }
    } finally {
      closeSync(dir)
      if (created && !retain) unlinkSync(temporary)
      if (retain)
        process.stderr.write(
          `Inspect the retained displaced file in the original directory: ${temporary}\n`,
        )
    }
    process.stdout.write("Applied staged task.txt.\n")
  } finally {
    try {
      unlock?.()
    } finally {
      lifetime.close()
    }
  }
}
