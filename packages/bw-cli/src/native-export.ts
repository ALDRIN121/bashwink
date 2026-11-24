import { dlopen, ptr } from "bun:ffi"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import {
  directoryIdentity,
  lockStage,
  readStage,
  regularFile,
  STAGED_FILE,
  type Destination,
} from "./native-stage.js"

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
  if (
    process.cwd() !== destination.directory ||
    directoryIdentity(destination.directory) !== destination.directoryId
  )
    throw new Error("run staged export from its original, unchanged host directory")
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

export async function exportNativeStage(root: string) {
  readStage(root)
  if (process.platform !== "darwin") throw new Error("staged export requires macOS")
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("staged export requires explicit approval in an interactive terminal")
  const unlock = lockStage(root)
  try {
    const { destination } = readStage(root)
    if (destination === undefined) throw new Error("this stage has no approved host destination")
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
        if (!swap()) throw new Error("filesystem refused atomic staged export")
        retain = true
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
          retain = false
          throw new Error("staged export refused a concurrent host edit and restored it")
        }
        fsyncSync(dir)
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
    unlock()
  }
}
