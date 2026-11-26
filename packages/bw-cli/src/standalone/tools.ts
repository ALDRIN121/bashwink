/**
 * Fixed 4-tool registry and executor for standalone Bashwink:
 *   1. `list_files`  — bounded workspace directory listing
 *   2. `read_file`   — bounded UTF-8 text read inside readable workspace scope
 *   3. `edit_file`   — unique-match diff preview, stale check, atomic same-dir write
 *   4. `run_command` — argv-based command execution with scrubbed env, timeout & tree termination
 */

import { createHash, randomBytes } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import {
  checkWorkspaceReadPath,
  checkWorkspaceWritePath,
  contains,
  globMatch,
  physicalPath,
  sanitizeSecretText,
  scrubbedChildEnv,
  toolPath,
  type BoundaryContext,
} from "./security.ts"
import type { StandaloneConfig, ToolDefinition } from "./types.ts"

const MAX_LIST_ENTRIES = 200
const MAX_READ_BYTES = 32 * 1024
const MAX_READ_LINES = 400
const MAX_DIFF_LINE_BYTES = 512
const MAX_DIFF_PREVIEW_BYTES = 16 * 1024
const MAX_EDIT_FILE_BYTES = 10 * 1024 * 1024
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024
const COMMAND_HEAD_BYTES = 12 * 1024
const COMMAND_TAIL_BYTES = 20 * 1024

export const BUILTIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "list_files",
    description:
      "List files and directories under a relative path inside the workspace (breadth-first, bounded, skips .git and node_modules).",
    parameters: {
      type: "object",
      properties: {
        directory: {
          type: "string",
          description: "Relative directory inside the workspace (default '.').",
        },
        maxDepth: { type: "integer", description: "Maximum recursion depth (default 4, max 8)." },
        offset: { type: "integer", description: "Optional 0-based entry offset for pagination." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the workspace with optional 1-based line range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        startLine: { type: "integer", description: "1-based inclusive start line." },
        endLine: { type: "integer", description: "1-based inclusive end line." },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description:
      "Create a new text file (`create: true`) or edit one existing text file inside the workspace by replacing a unique `oldText` match with `newText`. Shows a diff and requires user approval.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        oldText: {
          type: "string",
          description: "Exact existing text to replace (required and unique for existing files).",
        },
        newText: { type: "string", description: "Replacement text or full new file content." },
        create: { type: "boolean", description: "Set true when creating a new file." },
      },
      required: ["path", "newText"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description:
      "Run an executable with an argument array (no shell interpolation) inside the workspace. Requires user approval.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Executable name or path." },
        args: {
          type: "array",
          items: { type: "string" },
          description: "Argument array passed verbatim to the executable.",
        },
        cwd: { type: "string", description: "Optional working directory inside the workspace." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
]

function sha256Bytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex")
}

function loadGitIgnorePatterns(workspace: string): readonly string[] {
  const giPath = path.join(workspace, ".gitignore")
  if (!existsSync(giPath)) return []
  try {
    const raw = readFileSync(giPath, "utf8")
    const patterns: string[] = []
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue
      patterns.push(trimmed.replace(/^\//, "").replace(/\/+$/, ""))
    }
    return patterns
  } catch {
    return []
  }
}

function isIgnoredByRules(relPosix: string, name: string, rules: readonly string[]): boolean {
  if (name === ".git" || name === "node_modules") return true
  for (const rule of rules) {
    if (!rule) continue
    if (!rule.includes("/")) {
      if (globMatch(rule, name)) return true
    } else if (globMatch(rule, relPosix) || relPosix.startsWith(`${rule}/`)) {
      return true
    }
  }
  return false
}

export function executeListFiles(
  boundary: BoundaryContext,
  input: Record<string, unknown>,
): { readonly ok: boolean; readonly output: string } {
  const dirArg = input["directory"]
  if (dirArg !== undefined && typeof dirArg !== "string") {
    return { ok: false, output: "list_files: 'directory' must be a string." }
  }
  const maxDepthRaw = input["maxDepth"]
  if (
    maxDepthRaw !== undefined &&
    (typeof maxDepthRaw !== "number" || !Number.isInteger(maxDepthRaw) || maxDepthRaw < 1)
  ) {
    return { ok: false, output: "list_files: 'maxDepth' must be a positive integer." }
  }
  const offsetRaw = input["offset"]
  if (
    offsetRaw !== undefined &&
    (typeof offsetRaw !== "number" || !Number.isInteger(offsetRaw) || offsetRaw < 0)
  ) {
    return { ok: false, output: "list_files: 'offset' must be a non-negative integer." }
  }
  const maxDepth = Math.min(maxDepthRaw ?? 4, 8)
  const offset = offsetRaw ?? 0
  const check = checkWorkspaceReadPath(boundary, dirArg ?? ".")
  if (!check.allow) return { ok: false, output: check.reason }

  let st
  try {
    st = statSync(check.resolvedPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, output: `Permission denied accessing directory: ${dirArg ?? "."}` }
    }
    return { ok: false, output: `Directory does not exist: ${dirArg ?? "."}` }
  }
  if (!st.isDirectory()) {
    return { ok: false, output: `Not a directory: ${dirArg ?? "."}` }
  }

  const ignoreRules = loadGitIgnorePatterns(boundary.workspace)
  const allEntries: string[] = []
  const maxCollect = offset + MAX_LIST_ENTRIES + 1
  const queue: Array<{ readonly dir: string; readonly depth: number }> = [
    { dir: check.resolvedPath, depth: 1 },
  ]
  let hasMore = false

  while (queue.length > 0 && !hasMore) {
    const { dir: current, depth } = queue.shift()!
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )
    } catch {
      continue
    }
    // Root-level files and directories are emitted in breadth-first order so large subdirectories
    // never starve top-level project files like README.md or package.json.
    for (const entry of entries) {
      if (allEntries.length >= maxCollect) {
        hasMore = true
        break
      }
      const full = path.join(current, entry.name)
      const rel = path.relative(boundary.workspace, full).split(path.sep).join("/")
      if (isIgnoredByRules(rel, entry.name, ignoreRules)) continue
      if (entry.isSymbolicLink()) {
        try {
          const resolved = physicalPath(full)
          if (!contains(boundary.workspace, resolved)) continue
        } catch {
          continue
        }
      }
      if (entry.isDirectory()) {
        allEntries.push(`${rel}/`)
        if (depth < maxDepth) {
          queue.push({ dir: full, depth: depth + 1 })
        }
      } else if (entry.isFile()) {
        allEntries.push(rel)
      }
    }
  }

  const results = allEntries.slice(offset, offset + MAX_LIST_ENTRIES)
  const truncated = allEntries.length > offset + MAX_LIST_ENTRIES || hasMore
  if (results.length === 0) {
    return {
      ok: true,
      output:
        offset > 0
          ? `(no entries at offset ${offset}; total collected ${allEntries.length})`
          : "(empty directory)",
    }
  }
  return {
    ok: true,
    output:
      results.join("\n") +
      (truncated
        ? `\n... (truncated at ${MAX_LIST_ENTRIES} entries; pass offset: ${offset + results.length} to continue)`
        : ""),
  }
}

export function executeReadFile(
  boundary: BoundaryContext,
  input: Record<string, unknown>,
  activeSecret?: string,
): { readonly ok: boolean; readonly output: string } {
  const rawPath = input["path"]
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, output: "read_file: 'path' must be a non-empty string." }
  }
  const startRaw = input["startLine"]
  const endRaw = input["endLine"]
  if (
    startRaw !== undefined &&
    (typeof startRaw !== "number" || !Number.isInteger(startRaw) || startRaw < 1)
  ) {
    return { ok: false, output: "read_file: 'startLine' must be a positive integer." }
  }
  if (
    endRaw !== undefined &&
    (typeof endRaw !== "number" || !Number.isInteger(endRaw) || endRaw < 1)
  ) {
    return { ok: false, output: "read_file: 'endLine' must be a positive integer." }
  }
  if (startRaw !== undefined && endRaw !== undefined && endRaw < startRaw) {
    return {
      ok: false,
      output: `read_file: endLine (${endRaw}) must be >= startLine (${startRaw}).`,
    }
  }

  const check = checkWorkspaceReadPath(boundary, rawPath)
  if (!check.allow) return { ok: false, output: check.reason }

  let st
  try {
    st = lstatSync(check.resolvedPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, output: `Permission denied inspecting file: ${rawPath}` }
    }
    return { ok: false, output: `File not found: ${rawPath}` }
  }
  if (!st.isFile()) return { ok: false, output: `Not a regular file: ${rawPath}` }

  const start = startRaw ?? 1
  const requestedMaxLines = Math.min(
    endRaw ?? start + MAX_READ_LINES - 1,
    start + MAX_READ_LINES - 1,
  )

  let fd: number
  try {
    fd = openSync(check.resolvedPath, "r")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, output: `Cannot open file '${rawPath}': ${msg}` }
  }

  const collectedLines: string[] = []
  let lineNum = 0
  let leftover = ""
  let eof = false
  let checkedBinary = false
  let totalReadBytes = 0
  let stoppedByByteBudget = false
  const chunkBuf = Buffer.alloc(16 * 1024)

  try {
    while (!eof) {
      let bytesRead: number
      try {
        bytesRead = readSync(fd, chunkBuf, 0, chunkBuf.length, null)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, output: `Cannot read file '${rawPath}': ${msg}` }
      }
      if (bytesRead === 0) {
        eof = true
        break
      }
      if (!checkedBinary) {
        const probeSlice = chunkBuf.subarray(0, Math.min(bytesRead, 8192))
        if (probeSlice.includes(0)) {
          return { ok: false, output: `Refused to read binary file: ${rawPath}` }
        }
        checkedBinary = true
      }
      totalReadBytes += bytesRead
      const chunkStr = leftover + chunkBuf.subarray(0, bytesRead).toString("utf8")
      const parts = chunkStr.split(/\r?\n/)
      leftover = parts.pop() ?? ""
      for (const line of parts) {
        lineNum += 1
        if (lineNum >= start && lineNum <= requestedMaxLines) {
          collectedLines.push(line)
        }
        if (lineNum >= requestedMaxLines) {
          break
        }
      }
      if (lineNum >= requestedMaxLines) break
      if (lineNum < start && totalReadBytes > MAX_EDIT_FILE_BYTES) {
        // Still bound scanning on pathological multi-hundred-MB single-line files.
        stoppedByByteBudget = true
        break
      }
      if (
        lineNum >= start &&
        Buffer.byteLength(collectedLines.join("\n"), "utf8") > MAX_READ_BYTES * 2
      ) {
        stoppedByByteBudget = true
        break
      }
    }
    if (eof && leftover !== undefined) {
      // Only push trailing segment if file wasn't empty or had content after final newline
      if (totalReadBytes > 0 || collectedLines.length === 0) {
        if (leftover !== "" || !chunkBuf.subarray(0, 0).length) {
          if (totalReadBytes === 0) {
            lineNum = 1
            if (start === 1) collectedLines.push("")
          } else {
            lineNum += 1
            if (lineNum >= start && lineNum <= requestedMaxLines) {
              collectedLines.push(leftover)
            }
          }
        }
      }
    }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore close failure
    }
  }

  if (stoppedByByteBudget && collectedLines.length === 0) {
    return {
      ok: false,
      output: `File '${rawPath}' exceeded bounded read scan limit (${MAX_EDIT_FILE_BYTES} bytes) before reaching line ${start}.`,
    }
  }

  if (collectedLines.length === 0 && start > Math.max(1, lineNum)) {
    return {
      ok: false,
      output: `startLine ${start} is past end of file (${lineNum} lines).`,
    }
  }

  const numbered: string[] = []
  let outBytes = 0
  let byteTruncated = false
  let lastShownLine = start - 1
  for (let idx = 0; idx < collectedLines.length; idx += 1) {
    const curLineNum = start + idx
    const formatted = `${curLineNum}: ${collectedLines[idx]!}`
    const lineBytes = Buffer.byteLength(formatted, "utf8") + (numbered.length > 0 ? 1 : 0)
    if (outBytes + lineBytes > MAX_READ_BYTES) {
      if (numbered.length === 0) {
        // Single very long line: return a UTF-8 safe prefix so caller sees content + continuation.
        const maxPrefixBytes = Math.max(64, MAX_READ_BYTES - 32)
        let slice = ""
        let used = 0
        for (const ch of formatted) {
          const b = Buffer.byteLength(ch, "utf8")
          if (used + b > maxPrefixBytes) break
          slice += ch
          used += b
        }
        numbered.push(slice)
        lastShownLine = curLineNum
      }
      byteTruncated = true
      break
    }
    numbered.push(formatted)
    outBytes += lineBytes
    lastShownLine = curLineNum
  }

  const output = numbered.join("\n")
  let note = ""
  const hasMoreLines = !eof || lineNum > lastShownLine
  if (byteTruncated) {
    note = `\n... (truncated at ${MAX_READ_BYTES} bytes at line ${lastShownLine}; pass startLine: ${lastShownLine + 1} to continue)`
  } else if (hasMoreLines) {
    const totalLabel = eof ? ` of ${lineNum}` : "+"
    note = `\n... (showing lines ${start}-${lastShownLine}${totalLabel}; pass startLine: ${lastShownLine + 1} to continue)`
  }

  return {
    ok: true,
    output: sanitizeSecretText(output, activeSecret) + note,
  }
}

export interface PreparedEdit {
  readonly rawPath: string
  readonly resolvedPath: string
  readonly relativePath: string
  readonly create: boolean
  readonly originalSha256: string | null
  readonly originalNormalized: string | null
  readonly lineEnding: "\r\n" | "\n"
  readonly mode: number
  readonly updatedNormalized: string
  readonly updatedRawText: string
  readonly diffPreview: string
  readonly diffTruncated?: boolean
  readonly fullDiffBytes?: number
}

function truncateLineBytes(line: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(line, "utf8")
  if (bytes <= maxBytes) return line
  let out = ""
  let used = 0
  for (const ch of line) {
    const b = Buffer.byteLength(ch, "utf8")
    if (used + b > maxBytes) break
    out += ch
    used += b
  }
  return `${out} ... (+${bytes - used} bytes omitted)`
}

function renderSimpleDiff(
  relPath: string,
  beforeText: string | null,
  afterText: string,
): { readonly preview: string; readonly truncated: boolean; readonly fullBytes: number } {
  const beforeLines = beforeText === null ? [] : beforeText.split("\n")
  const afterLines = afterText.split("\n")
  let prefix = 0
  while (
    prefix < beforeLines.length &&
    prefix < afterLines.length &&
    beforeLines[prefix] === afterLines[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix)
  const added = afterLines.slice(prefix, afterLines.length - suffix)
  const header =
    beforeText === null ? `+++ ${relPath} (new file)` : `--- ${relPath}\n+++ ${relPath}`
  const ctxStart = Math.max(0, prefix - 3)
  const ctxBefore = beforeLines
    .slice(ctxStart, prefix)
    .map((l) => `  ${truncateLineBytes(l, MAX_DIFF_LINE_BYTES)}`)
  const ctxAfterCount = beforeText === null ? 0 : Math.min(3, suffix)
  const ctxAfter = afterLines
    .slice(afterLines.length - suffix, afterLines.length - suffix + ctxAfterCount)
    .map((l) => `  ${truncateLineBytes(l, MAX_DIFF_LINE_BYTES)}`)
  const shownRemoved = removed.slice(0, 60)
  const shownAdded = added.slice(0, 60)
  const oldStart = beforeText === null ? 0 : ctxStart + 1
  const oldCount =
    beforeText === null ? 0 : ctxBefore.length + shownRemoved.length + ctxAfter.length
  const newStart = ctxStart + 1
  const newCount = ctxBefore.length + shownAdded.length + ctxAfter.length
  const body = [
    ...ctxBefore,
    ...shownRemoved.map((l) => `- ${truncateLineBytes(l, MAX_DIFF_LINE_BYTES)}`),
    ...(removed.length > 60 ? [`... (${removed.length - 60} more removed lines)`] : []),
    ...shownAdded.map((l) => `+ ${truncateLineBytes(l, MAX_DIFF_LINE_BYTES)}`),
    ...(added.length > 60 ? [`... (${added.length - 60} more added lines)`] : []),
    ...ctxAfter,
  ]
  const rawFullBytes =
    Buffer.byteLength(header, "utf8") +
    removed.reduce((s, l) => s + Buffer.byteLength(l, "utf8") + 3, 0) +
    added.reduce((s, l) => s + Buffer.byteLength(l, "utf8") + 3, 0)
  let rendered = `${header}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body.join("\n")}`
  let truncated =
    removed.length > 60 ||
    added.length > 60 ||
    removed.some((l) => Buffer.byteLength(l, "utf8") > MAX_DIFF_LINE_BYTES) ||
    added.some((l) => Buffer.byteLength(l, "utf8") > MAX_DIFF_LINE_BYTES)
  if (Buffer.byteLength(rendered, "utf8") > MAX_DIFF_PREVIEW_BYTES) {
    truncated = true
    let bounded = ""
    let used = 0
    for (const ch of rendered) {
      const b = Buffer.byteLength(ch, "utf8")
      if (used + b > MAX_DIFF_PREVIEW_BYTES - 120) break
      bounded += ch
      used += b
    }
    rendered = `${bounded}\n... (diff preview truncated at ${MAX_DIFF_PREVIEW_BYTES} bytes; full diff ${rawFullBytes} bytes)`
  }
  return { preview: rendered, truncated, fullBytes: rawFullBytes }
}

/** Map a character index in LF-normalized text back to the original (CRLF/LF) string index. */
function mapNormalizedIndexToOriginal(originalText: string, normIdx: number): number {
  let ni = 0
  let oi = 0
  while (oi < originalText.length && ni < normIdx) {
    if (originalText[oi] === "\r" && originalText[oi + 1] === "\n") {
      oi += 2
      ni += 1
    } else {
      oi += 1
      ni += 1
    }
  }
  return oi
}

export function prepareEditFile(
  boundary: BoundaryContext,
  input: Record<string, unknown>,
  editedFiles?: ReadonlySet<string>,
):
  | { readonly ok: true; readonly prepared: PreparedEdit }
  | { readonly ok: false; readonly reason: string; readonly noop?: boolean } {
  const rawPath = input["path"]
  const newText = input["newText"]
  const oldText = input["oldText"]
  const create = input["create"]

  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return { ok: false, reason: "edit_file: 'path' must be a non-empty string." }
  }
  if (typeof newText !== "string") {
    return { ok: false, reason: "edit_file: 'newText' must be a string." }
  }
  if (oldText !== undefined && typeof oldText !== "string") {
    return { ok: false, reason: "edit_file: 'oldText' must be a string when provided." }
  }
  if (create !== undefined && typeof create !== "boolean") {
    return { ok: false, reason: "edit_file: 'create' must be a boolean when provided." }
  }
  if (Buffer.byteLength(newText, "utf8") > MAX_EDIT_FILE_BYTES) {
    return {
      ok: false,
      reason: `edit_file: 'newText' exceeds ${MAX_EDIT_FILE_BYTES} byte edit limit.`,
    }
  }

  const check = checkWorkspaceWritePath(boundary, rawPath)
  if (!check.allow) return { ok: false, reason: check.reason }

  const resolvedPath = check.resolvedPath
  const relativePath = path.relative(boundary.workspace, resolvedPath)
  if (
    boundary.maxFiles !== undefined &&
    !editedFiles?.has(relativePath) &&
    (editedFiles?.size ?? 0) >= boundary.maxFiles
  ) {
    return {
      ok: false,
      reason: `ScopeFence: contract maxFiles (${boundary.maxFiles}) reached; cannot modify '${relativePath}'.`,
    }
  }
  const exists = existsSync(resolvedPath)

  if (!exists) {
    if (create !== true) {
      return {
        ok: false,
        reason: `File '${relativePath}' does not exist; pass create: true to create a new file.`,
      }
    }
    const lineEnding: "\r\n" | "\n" =
      newText.includes("\r\n") && !newText.replace(/\r\n/g, "").includes("\n") ? "\r\n" : "\n"
    const normalizedNew = newText.replace(/\r\n/g, "\n")
    const diff = renderSimpleDiff(relativePath, null, normalizedNew)
    return {
      ok: true,
      prepared: {
        rawPath,
        resolvedPath,
        relativePath,
        create: true,
        originalSha256: null,
        originalNormalized: null,
        lineEnding,
        mode: 0o644,
        updatedNormalized: normalizedNew,
        updatedRawText: newText,
        diffPreview: diff.preview,
        ...(diff.truncated ? { diffTruncated: true, fullDiffBytes: diff.fullBytes } : {}),
      },
    }
  }

  if (create === true) {
    return {
      ok: false,
      reason: `File '${relativePath}' already exists; pass create: false (or omit create) with 'oldText' to edit it.`,
    }
  }

  let st
  try {
    st = lstatSync(resolvedPath)
  } catch (err) {
    return {
      ok: false,
      reason: `Cannot inspect existing file '${relativePath}': ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!st.isFile()) {
    return { ok: false, reason: `Target '${relativePath}' is not a regular file.` }
  }
  if (st.size > MAX_EDIT_FILE_BYTES) {
    return {
      ok: false,
      reason: `Refused to edit oversized file '${relativePath}' (${st.size} bytes > ${MAX_EDIT_FILE_BYTES} byte limit).`,
    }
  }

  let rawBytes: Buffer
  try {
    rawBytes = readFileSync(resolvedPath)
  } catch (err) {
    return {
      ok: false,
      reason: `Cannot read file '${relativePath}': ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (rawBytes.subarray(0, 8192).includes(0)) {
    return { ok: false, reason: `Refused to edit binary file '${relativePath}'.` }
  }
  const originalText = rawBytes.toString("utf8")
  const lineEnding: "\r\n" | "\n" =
    originalText.includes("\r\n") && !originalText.replace(/\r\n/g, "").includes("\n")
      ? "\r\n"
      : "\n"
  const normalizedOriginal = originalText.replace(/\r\n/g, "\n")

  if (oldText === undefined || oldText === "") {
    return {
      ok: false,
      reason: `edit_file requires non-empty 'oldText' to edit existing file '${relativePath}'.`,
    }
  }
  const normalizedOld = oldText.replace(/\r\n/g, "\n")
  const normalizedNew = newText.replace(/\r\n/g, "\n")
  const firstIdx = normalizedOriginal.indexOf(normalizedOld)
  if (firstIdx < 0) {
    return {
      ok: false,
      reason: `'oldText' was not found in '${relativePath}'; re-read the file before editing.`,
    }
  }
  const secondIdx = normalizedOriginal.indexOf(normalizedOld, firstIdx + 1)
  if (secondIdx >= 0) {
    return {
      ok: false,
      reason: `'oldText' matched multiple locations in '${relativePath}'; provide more context.`,
    }
  }

  if (normalizedNew === normalizedOld) {
    return {
      ok: false,
      noop: true,
      reason: `edit_file: no-op edit ('newText' is identical to 'oldText' in '${relativePath}').`,
    }
  }

  const origStart = mapNormalizedIndexToOriginal(originalText, firstIdx)
  const origEnd = mapNormalizedIndexToOriginal(originalText, firstIdx + normalizedOld.length)
  const matchedOrigSpan = originalText.slice(origStart, origEnd)
  const spanUsesCrlf =
    matchedOrigSpan.includes("\r\n") && !matchedOrigSpan.replace(/\r\n/g, "").includes("\n")
  const spanUsesLf = matchedOrigSpan.includes("\n") && !matchedOrigSpan.includes("\r\n")
  const targetSpanEnding: "\r\n" | "\n" = spanUsesCrlf ? "\r\n" : spanUsesLf ? "\n" : lineEnding
  const replacementRaw =
    targetSpanEnding === "\r\n" ? normalizedNew.replace(/\n/g, "\r\n") : normalizedNew
  const updatedRawText =
    originalText.slice(0, origStart) + replacementRaw + originalText.slice(origEnd)

  const updatedNormalized =
    normalizedOriginal.slice(0, firstIdx) +
    normalizedNew +
    normalizedOriginal.slice(firstIdx + normalizedOld.length)

  if (updatedRawText === originalText) {
    return {
      ok: false,
      noop: true,
      reason: `edit_file: no-op edit (resulting file bytes unchanged for '${relativePath}').`,
    }
  }

  const diff = renderSimpleDiff(relativePath, normalizedOriginal, updatedNormalized)
  return {
    ok: true,
    prepared: {
      rawPath,
      resolvedPath,
      relativePath,
      create: false,
      originalSha256: sha256Bytes(rawBytes),
      originalNormalized: normalizedOriginal,
      lineEnding,
      mode: st.mode & 0o777,
      updatedNormalized,
      updatedRawText,
      diffPreview: diff.preview,
      ...(diff.truncated ? { diffTruncated: true, fullDiffBytes: diff.fullBytes } : {}),
    },
  }
}

export function applyPreparedEdit(
  boundary: BoundaryContext,
  prepared: PreparedEdit,
):
  | { readonly ok: true; readonly changedFile: string }
  | { readonly ok: false; readonly reason: string } {
  const recheck = checkWorkspaceWritePath(boundary, prepared.rawPath)
  if (!recheck.allow || recheck.resolvedPath !== prepared.resolvedPath) {
    return {
      ok: false,
      reason: recheck.allow
        ? `Target path changed before write (${recheck.resolvedPath} !== ${prepared.resolvedPath}).`
        : recheck.reason,
    }
  }

  if (prepared.originalSha256 === null) {
    if (existsSync(prepared.resolvedPath)) {
      return {
        ok: false,
        reason: `File '${prepared.relativePath}' was created after the diff preview; refusing overwrite.`,
      }
    }
  } else {
    if (!existsSync(prepared.resolvedPath)) {
      return {
        ok: false,
        reason: `File '${prepared.relativePath}' disappeared before edit was applied.`,
      }
    }
    const currentHash = sha256Bytes(readFileSync(prepared.resolvedPath))
    if (currentHash !== prepared.originalSha256) {
      return {
        ok: false,
        reason: `File '${prepared.relativePath}' changed on disk since the diff was previewed; refusing stale edit.`,
      }
    }
  }

  const parent = path.dirname(prepared.resolvedPath)
  mkdirSync(parent, { recursive: true })
  const outText = prepared.updatedRawText

  const temp = path.join(
    parent,
    `.${path.basename(prepared.resolvedPath)}.bw-${process.pid}-${randomBytes(4).toString("hex")}.tmp`,
  )
  writeFileSync(temp, outText, { encoding: "utf8", mode: prepared.mode })
  renameSync(temp, prepared.resolvedPath)
  return { ok: true, changedFile: prepared.relativePath }
}

export interface PreparedCommand {
  readonly command: string
  readonly resolvedExecutable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly isWindowsCmdShim: boolean
}

function isExecutableFile(filePath: string): {
  readonly exists: boolean
  readonly executable: boolean
} {
  try {
    if (!statSync(filePath).isFile()) return { exists: false, executable: false }
  } catch {
    return { exists: false, executable: false }
  }
  if (process.platform === "win32") {
    return { exists: true, executable: true }
  }
  try {
    accessSync(filePath, constants.X_OK)
    return { exists: true, executable: true }
  } catch {
    return { exists: true, executable: false }
  }
}

function resolveExecutable(
  command: string,
  envPath: string,
  cwd: string,
): { path?: string; isCmdShim: boolean; nonExecutableMatch?: string } {
  const hasSep = command.includes("/") || command.includes("\\")
  const windows = process.platform === "win32"
  const pathext = windows
    ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
    : [""]

  const candidatesFromDir = (dir: string, name: string): string[] => {
    const out = [path.join(dir, name)]
    if (windows && path.extname(name) === "") {
      for (const ext of pathext)
        out.push(path.join(dir, name + ext.toLowerCase()), path.join(dir, name + ext))
    }
    return out
  }

  let firstNonExec: string | undefined

  if (hasSep) {
    const abs = path.resolve(cwd, command)
    for (const c of candidatesFromDir(path.dirname(abs), path.basename(abs))) {
      const check = isExecutableFile(c)
      if (check.executable) {
        const lower = c.toLowerCase()
        return { path: c, isCmdShim: windows && (lower.endsWith(".cmd") || lower.endsWith(".bat")) }
      }
      if (check.exists && !firstNonExec) firstNonExec = c
    }
    return { isCmdShim: false, ...(firstNonExec ? { nonExecutableMatch: firstNonExec } : {}) }
  }

  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const c of candidatesFromDir(dir, command)) {
      const check = isExecutableFile(c)
      if (check.executable) {
        const lower = c.toLowerCase()
        return { path: c, isCmdShim: windows && (lower.endsWith(".cmd") || lower.endsWith(".bat")) }
      }
      if (check.exists && !firstNonExec) firstNonExec = c
    }
  }
  return { isCmdShim: false, ...(firstNonExec ? { nonExecutableMatch: firstNonExec } : {}) }
}

function validateSafeWindowsShimArg(arg: string): string | undefined {
  if (/[\r\n\0]/.test(arg)) return "contains newline or null byte"
  // Reject cmd.exe delayed/env expansion or quote breakouts on .cmd/.bat shims.
  if (/[%!^"&|<>`]/.test(arg)) {
    return 'contains cmd.exe metacharacters (%, !, ^, ", &, |, <, >, `) unsafe for Windows batch shims'
  }
  return undefined
}

function quoteCmdArg(arg: string): string {
  if (arg === "") return '""'
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(arg)) return arg
  return `"${arg}"`
}

function extractCommandPathCandidates(arg: string, homeDir: string): string[] {
  const rawCandidates = [arg]
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=")
    if (eq > 0 && eq + 1 < arg.length) rawCandidates.push(arg.slice(eq + 1))
  } else if (arg.startsWith("-") && arg.length > 2) {
    rawCandidates.push(arg.slice(2))
    rawCandidates.push(arg.slice(1))
  }
  const out: string[] = []
  for (const cand of rawCandidates) {
    if (cand === "~") {
      out.push(homeDir)
    } else if (cand.startsWith("~/") || cand.startsWith("~\\")) {
      out.push(path.join(homeDir, cand.slice(2)))
    } else if (cand.includes("/") || cand.includes("\\")) {
      out.push(cand)
    }
  }
  return out
}

export function prepareRunCommand(
  boundary: BoundaryContext,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
):
  | { readonly ok: true; readonly prepared: PreparedCommand }
  | { readonly ok: false; readonly reason: string } {
  if (!boundary.trusted) {
    return {
      ok: false,
      reason: `workspace ${boundary.workspace} is not trusted (read-only mode); commands are denied until trusted.`,
    }
  }
  const command = input["command"]
  if (typeof command !== "string" || command.trim() === "" || /[\r\n\0]/.test(command)) {
    return {
      ok: false,
      reason: "run_command: 'command' must be a non-empty single-line executable name.",
    }
  }
  if (boundary.scopePolicy?.allowShell === false) {
    return {
      ok: false,
      reason: "ScopeFence: shell commands are disabled by active contract constraints.",
    }
  }
  const exeName = command.trim()
  const exeBase = path
    .basename(exeName)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/, "")
  if (
    boundary.forbiddenCommands?.some(
      (f) =>
        path
          .basename(f.trim())
          .toLowerCase()
          .replace(/\.(?:exe|cmd|bat)$/, "") === exeBase,
    )
  ) {
    return {
      ok: false,
      reason: `ScopeFence: command '${exeName}' is explicitly forbidden by the active contract.`,
    }
  }
  if (
    boundary.allowedCommands !== undefined &&
    !boundary.allowedCommands.some(
      (a) =>
        path
          .basename(a.trim())
          .toLowerCase()
          .replace(/\.(?:exe|cmd|bat)$/, "") === exeBase,
    )
  ) {
    return {
      ok: false,
      reason: `ScopeFence: command '${exeName}' is outside active contract allowedCommands (${boundary.allowedCommands.join(", ")}).`,
    }
  }
  const rawArgs = input["args"]
  let args: string[] = []
  if (rawArgs !== undefined) {
    if (!Array.isArray(rawArgs) || rawArgs.some((a) => typeof a !== "string" || a.includes("\0"))) {
      return { ok: false, reason: "run_command: 'args' must be an array of strings." }
    }
    args = rawArgs as string[]
  }
  const rawCwd = input["cwd"]
  if (rawCwd !== undefined && typeof rawCwd !== "string") {
    return { ok: false, reason: "run_command: 'cwd' must be a string when provided." }
  }
  const cwdCheck = checkWorkspaceReadPath(boundary, rawCwd ?? ".")
  if (!cwdCheck.allow) return { ok: false, reason: cwdCheck.reason }
  if (!existsSync(cwdCheck.resolvedPath) || !statSync(cwdCheck.resolvedPath).isDirectory()) {
    return { ok: false, reason: `Working directory does not exist: ${rawCwd ?? "."}` }
  }

  const homeDir = env["HOME"] ?? env["USERPROFILE"] ?? homedir()
  const scopeForbiddenRoots = boundary.scopePolicy?.forbiddenPaths ?? []
  for (const arg of args) {
    for (const expanded of extractCommandPathCandidates(arg, homeDir)) {
      try {
        const candidate = toolPath(cwdCheck.resolvedPath, expanded)
        if (boundary.forbiddenReadRoots.some((root) => contains(root, candidate))) {
          return {
            ok: false,
            reason: `Command argument '${arg}' targets protected configuration/credential path ${candidate}.`,
          }
        }
        if (
          boundary.forbiddenWriteRoots.some((root) => contains(root, candidate)) ||
          scopeForbiddenRoots.some((root) => contains(root, candidate))
        ) {
          return {
            ok: false,
            reason: `ScopeFence: command argument '${arg}' targets forbidden path ${candidate}.`,
          }
        }
      } catch {
        // Non-path argument or unresolvable token; let executable handle it cleanly
      }
    }
  }

  const found = resolveExecutable(command.trim(), env["PATH"] ?? "", cwdCheck.resolvedPath)
  if (!found.path) {
    if (found.nonExecutableMatch) {
      return {
        ok: false,
        reason: `Executable '${command.trim()}' resolved to '${found.nonExecutableMatch}', which is not executable (EACCES).`,
      }
    }
    return { ok: false, reason: `Executable not found on PATH: '${command.trim()}'` }
  }

  // Validate canonical executable identity after resolution (symlink/alias protection for allowlists).
  let canonicalExe: string
  try {
    canonicalExe = physicalPath(found.path)
  } catch {
    canonicalExe = path.resolve(found.path)
  }
  const canonicalBase = path
    .basename(canonicalExe)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/, "")
  const normalizeSpec = (spec: string) =>
    path
      .basename(spec.trim())
      .toLowerCase()
      .replace(/\.(?:exe|cmd|bat)$/, "")
  const matchesSpec = (spec: string) => {
    const trimmed = spec.trim()
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      try {
        return physicalPath(trimmed) === canonicalExe || normalizeSpec(trimmed) === canonicalBase
      } catch {
        return path.resolve(trimmed) === canonicalExe
      }
    }
    return normalizeSpec(trimmed) === canonicalBase || normalizeSpec(trimmed) === exeBase
  }
  if (boundary.forbiddenCommands?.some(matchesSpec)) {
    return {
      ok: false,
      reason: `ScopeFence: resolved executable '${canonicalExe}' matches forbiddenCommands.`,
    }
  }
  if (boundary.allowedCommands !== undefined && !boundary.allowedCommands.some(matchesSpec)) {
    return {
      ok: false,
      reason: `ScopeFence: resolved executable '${canonicalExe}' is outside active contract allowedCommands (${boundary.allowedCommands.join(", ")}).`,
    }
  }

  if (found.isCmdShim) {
    for (const arg of args) {
      const unsafe = validateSafeWindowsShimArg(arg)
      if (unsafe) {
        return {
          ok: false,
          reason: `Windows shim argument rejected (${unsafe}): '${arg}'. Use a direct executable instead of a .cmd/.bat shim.`,
        }
      }
    }
  }

  return {
    ok: true,
    prepared: {
      command: command.trim(),
      resolvedExecutable: canonicalExe,
      args,
      cwd: cwdCheck.resolvedPath,
      isWindowsCmdShim: found.isCmdShim,
    },
  }
}

export interface CommandRunResult {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly timedOut: boolean
  readonly cancelled: boolean
  readonly output: string
  readonly truncated: boolean
}

function killProcessTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already exited
    }
  }
}

export async function executePreparedCommand(
  prepared: PreparedCommand,
  config: StandaloneConfig,
  options: {
    readonly timeoutMs: number
    readonly signal?: AbortSignal
    readonly baseEnv?: NodeJS.ProcessEnv
    readonly activeSecret?: string
  },
): Promise<CommandRunResult> {
  const env = scrubbedChildEnv(options.baseEnv ?? process.env, config)
  const spawnTarget = prepared.isWindowsCmdShim
    ? process.env["ComSpec"] || "cmd.exe"
    : prepared.resolvedExecutable
  const spawnArgs = prepared.isWindowsCmdShim
    ? [
        "/d",
        "/s",
        "/c",
        `"${quoteCmdArg(prepared.resolvedExecutable)} ${prepared.args.map(quoteCmdArg).join(" ")}"`,
      ]
    : [...prepared.args]

  return await new Promise<CommandRunResult>((resolve) => {
    const child = spawn(spawnTarget, spawnArgs, {
      cwd: prepared.cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: prepared.isWindowsCmdShim,
    })

    const headChunks: Buffer[] = []
    let headBytes = 0
    const tailChunks: Buffer[] = []
    let tailBytes = 0
    const stderrTailChunks: Buffer[] = []
    let stderrTailBytes = 0
    let totalBytes = 0
    let truncated = false
    let timedOut = false
    let cancelled = false
    let finalized = false

    const pushTail = (list: Buffer[], currentBytes: number, cap: number, buf: Buffer): number => {
      list.push(buf)
      let total = currentBytes + buf.byteLength
      while (total > cap && list.length > 0) {
        const drop = list[0]!
        if (total - drop.byteLength >= cap) {
          list.shift()
          total -= drop.byteLength
        } else {
          const trimCount = total - cap
          list[0] = drop.subarray(trimCount)
          total -= trimCount
        }
      }
      return total
    }

    const appendChunk = (buf: Buffer, isStderr: boolean) => {
      totalBytes += buf.byteLength
      if (isStderr) {
        stderrTailBytes = pushTail(stderrTailChunks, stderrTailBytes, 8 * 1024, buf)
      }
      if (!truncated && headBytes + buf.byteLength <= MAX_COMMAND_OUTPUT_BYTES) {
        headChunks.push(buf)
        headBytes += buf.byteLength
        return
      }
      if (!truncated) {
        // Transition into bounded head+tail mode so final failure diagnostics are retained.
        const currentAll = Buffer.concat(headChunks)
        headChunks.length = 0
        headChunks.push(currentAll.subarray(0, Math.min(currentAll.byteLength, COMMAND_HEAD_BYTES)))
        headBytes = headChunks[0]!.byteLength
        if (currentAll.byteLength > COMMAND_HEAD_BYTES) {
          tailBytes = pushTail(
            tailChunks,
            tailBytes,
            COMMAND_TAIL_BYTES,
            currentAll.subarray(COMMAND_HEAD_BYTES),
          )
        }
        truncated = true
      }
      tailBytes = pushTail(tailChunks, tailBytes, COMMAND_TAIL_BYTES, buf)
    }

    child.stdout?.on("data", (d: Buffer) => appendChunk(d, false))
    child.stderr?.on("data", (d: Buffer) => appendChunk(d, true))

    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) killProcessTree(child.pid)
    }, options.timeoutMs)

    const onAbort = () => {
      cancelled = true
      if (child.pid !== undefined) killProcessTree(child.pid)
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener("abort", onAbort, { once: true })
    }

    const finalize = (exitCode: number | null, sig: string | null) => {
      if (finalized) return
      finalized = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      let rawOutput: string
      if (!truncated) {
        rawOutput = Buffer.concat(headChunks).toString("utf8")
      } else {
        const headText = Buffer.concat(headChunks).toString("utf8")
        const tailText = Buffer.concat(tailChunks).toString("utf8")
        const omittedBytes = Math.max(0, totalBytes - headBytes - tailBytes)
        const stderrTailText = Buffer.concat(stderrTailChunks).toString("utf8").trim()
        const stderrNote =
          stderrTailText !== "" && !tailText.includes(stderrTailText.slice(-120))
            ? `\n--- stderr tail ---\n${stderrTailText}`
            : ""
        rawOutput = `${headText}\n... (output truncated: omitted ${omittedBytes} intermediate bytes; retained head ${headBytes} + tail ${tailBytes} of ${totalBytes} bytes) ...\n${tailText}${stderrNote}`
      }
      const clean = sanitizeSecretText(rawOutput, options.activeSecret)
      resolve({
        exitCode,
        signal: sig,
        timedOut,
        cancelled,
        output: clean,
        truncated,
      })
    }

    child.on("error", (error) => {
      appendChunk(Buffer.from(`spawn error: ${error.message}\n`), true)
      finalize(null, null)
    })

    child.on("close", (code, sig) => {
      finalize(code, sig)
    })
  })
}
