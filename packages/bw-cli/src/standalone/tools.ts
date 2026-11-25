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
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import {
  checkWorkspaceReadPath,
  checkWorkspaceWritePath,
  contains,
  physicalPath,
  sanitizeSecretText,
  scrubbedChildEnv,
  type BoundaryContext,
} from "./security.ts"
import type { StandaloneConfig, ToolDefinition } from "./types.ts"

const MAX_LIST_ENTRIES = 200
const MAX_READ_BYTES = 32 * 1024
const MAX_READ_LINES = 400
const MAX_COMMAND_OUTPUT_BYTES = 32 * 1024

export const BUILTIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "list_files",
    description:
      "List files and directories under a relative path inside the workspace (bounded, skips .git and node_modules).",
    parameters: {
      type: "object",
      properties: {
        directory: { type: "string", description: "Relative directory inside the workspace (default '.')." },
        maxDepth: { type: "integer", description: "Maximum recursion depth (default 4, max 8)." },
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
  const maxDepth = Math.min(maxDepthRaw ?? 4, 8)
  const check = checkWorkspaceReadPath(boundary, dirArg ?? ".")
  if (!check.allow) return { ok: false, output: check.reason }

  let st
  try {
    st = statSync(check.resolvedPath)
  } catch {
    return { ok: false, output: `Directory does not exist: ${dirArg ?? "."}` }
  }
  if (!st.isDirectory()) {
    return { ok: false, output: `Not a directory: ${dirArg ?? "."}` }
  }

  const results: string[] = []
  let truncated = false
  const walk = (current: string, depth: number) => {
    if (results.length >= MAX_LIST_ENTRIES) {
      truncated = true
      return
    }
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
        a.name.localeCompare(b.name),
      )
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= MAX_LIST_ENTRIES) {
        truncated = true
        return
      }
      if (entry.name === ".git" || entry.name === "node_modules") continue
      const full = path.join(current, entry.name)
      const rel = path.relative(boundary.workspace, full)
      if (entry.isSymbolicLink()) {
        try {
          const resolved = physicalPath(full)
          if (!contains(boundary.workspace, resolved)) continue
        } catch {
          continue
        }
      }
      if (entry.isDirectory()) {
        results.push(`${rel}/`)
        if (depth < maxDepth) walk(full, depth + 1)
      } else if (entry.isFile()) {
        results.push(rel)
      }
    }
  }
  walk(check.resolvedPath, 1)

  if (results.length === 0) return { ok: true, output: "(empty directory)" }
  return {
    ok: true,
    output: results.join("\n") + (truncated ? `\n... (truncated at ${MAX_LIST_ENTRIES} entries)` : ""),
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

  const check = checkWorkspaceReadPath(boundary, rawPath)
  if (!check.allow) return { ok: false, output: check.reason }

  let st
  try {
    st = lstatSync(check.resolvedPath)
  } catch {
    return { ok: false, output: `File not found: ${rawPath}` }
  }
  if (!st.isFile()) return { ok: false, output: `Not a regular file: ${rawPath}` }

  const buf = readFileSync(check.resolvedPath)
  if (buf.subarray(0, 8192).includes(0)) {
    return { ok: false, output: `Refused to read binary file: ${rawPath}` }
  }
  const text = buf.toString("utf8")
  const lines = text.split(/\r?\n/)
  const start = startRaw ?? 1
  const end = Math.min(endRaw ?? start + MAX_READ_LINES - 1, lines.length)
  if (start > lines.length && lines.length > 0) {
    return {
      ok: false,
      output: `startLine ${start} is past end of file (${lines.length} lines).`,
    }
  }
  const sliced = lines.slice(start - 1, end)
  let output = sliced.map((line, idx) => `${start + idx}: ${line}`).join("\n")
  let note = ""
  if (Buffer.byteLength(output, "utf8") > MAX_READ_BYTES) {
    output = Buffer.from(output, "utf8").subarray(0, MAX_READ_BYTES).toString("utf8")
    note = `\n... (truncated at ${MAX_READ_BYTES} bytes)`
  } else if (end < lines.length) {
    note = `\n... (showing lines ${start}-${end} of ${lines.length})`
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
  readonly lineEnding: "\r\n" | "\n"
  readonly mode: number
  readonly updatedNormalized: string
  readonly diffPreview: string
}

function renderSimpleDiff(relPath: string, beforeText: string | null, afterText: string): string {
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
  const header = beforeText === null ? `+++ ${relPath} (new file)` : `--- ${relPath}\n+++ ${relPath}`
  const ctxBefore = beforeLines.slice(Math.max(0, prefix - 2), prefix).map((l) => `  ${l}`)
  const ctxAfter = afterLines
    .slice(afterLines.length - suffix, Math.min(afterLines.length, afterLines.length - suffix + 2))
    .map((l) => `  ${l}`)
  const body = [
    ...ctxBefore,
    ...removed.slice(0, 40).map((l) => `- ${l}`),
    ...(removed.length > 40 ? [`... (${removed.length - 40} more removed lines)`] : []),
    ...added.slice(0, 40).map((l) => `+ ${l}`),
    ...(added.length > 40 ? [`... (${added.length - 40} more added lines)`] : []),
    ...ctxAfter,
  ]
  return `${header}\n@@ line ${prefix + 1} @@\n${body.join("\n")}`
}

export function prepareEditFile(
  boundary: BoundaryContext,
  input: Record<string, unknown>,
): { readonly ok: true; readonly prepared: PreparedEdit } | { readonly ok: false; readonly reason: string } {
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

  const check = checkWorkspaceWritePath(boundary, rawPath)
  if (!check.allow) return { ok: false, reason: check.reason }

  const resolvedPath = check.resolvedPath
  const relativePath = path.relative(boundary.workspace, resolvedPath)
  const exists = existsSync(resolvedPath)

  if (!exists) {
    if (create !== true && oldText !== undefined && oldText !== "") {
      return {
        ok: false,
        reason: `File '${relativePath}' does not exist; pass create: true to create a new file.`,
      }
    }
    const normalizedNew = newText.replace(/\r\n/g, "\n")
    return {
      ok: true,
      prepared: {
        rawPath,
        resolvedPath,
        relativePath,
        create: true,
        originalSha256: null,
        lineEnding: "\n",
        mode: 0o644,
        updatedNormalized: normalizedNew,
        diffPreview: renderSimpleDiff(relativePath, null, normalizedNew),
      },
    }
  }

  let st
  try {
    st = lstatSync(resolvedPath)
  } catch {
    return { ok: false, reason: `Cannot inspect existing file '${relativePath}'.` }
  }
  if (!st.isFile()) {
    return { ok: false, reason: `Target '${relativePath}' is not a regular file.` }
  }

  const rawBytes = readFileSync(resolvedPath)
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

  const updatedNormalized =
    normalizedOriginal.slice(0, firstIdx) +
    normalizedNew +
    normalizedOriginal.slice(firstIdx + normalizedOld.length)

  return {
    ok: true,
    prepared: {
      rawPath,
      resolvedPath,
      relativePath,
      create: false,
      originalSha256: sha256Bytes(rawBytes),
      lineEnding,
      mode: st.mode & 0o777,
      updatedNormalized,
      diffPreview: renderSimpleDiff(relativePath, normalizedOriginal, updatedNormalized),
    },
  }
}

export function applyPreparedEdit(
  boundary: BoundaryContext,
  prepared: PreparedEdit,
): { readonly ok: true; readonly changedFile: string } | { readonly ok: false; readonly reason: string } {
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
  const outText =
    prepared.lineEnding === "\r\n"
      ? prepared.updatedNormalized.replace(/\n/g, "\r\n")
      : prepared.updatedNormalized

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

function resolveExecutable(command: string, envPath: string): { path?: string; isCmdShim: boolean } {
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
      for (const ext of pathext) out.push(path.join(dir, name + ext.toLowerCase()), path.join(dir, name + ext))
    }
    return out
  }

  if (hasSep) {
    const abs = path.resolve(command)
    for (const c of candidatesFromDir(path.dirname(abs), path.basename(abs))) {
      try {
        if (statSync(c).isFile()) {
          const lower = c.toLowerCase()
          return { path: c, isCmdShim: windows && (lower.endsWith(".cmd") || lower.endsWith(".bat")) }
        }
      } catch {
        // continue
      }
    }
    return { isCmdShim: false }
  }

  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const c of candidatesFromDir(dir, command)) {
      try {
        if (statSync(c).isFile()) {
          const lower = c.toLowerCase()
          return { path: c, isCmdShim: windows && (lower.endsWith(".cmd") || lower.endsWith(".bat")) }
        }
      } catch {
        // continue
      }
    }
  }
  return { isCmdShim: false }
}

function quoteCmdArg(arg: string): string {
  if (arg === "") return '""'
  if (/^[A-Za-z0-9_./:\\=-]+$/.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

export function prepareRunCommand(
  boundary: BoundaryContext,
  input: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): { readonly ok: true; readonly prepared: PreparedCommand } | { readonly ok: false; readonly reason: string } {
  if (!boundary.trusted) {
    return {
      ok: false,
      reason: `workspace ${boundary.workspace} is not trusted (read-only mode); commands are denied until trusted.`,
    }
  }
  const command = input["command"]
  if (typeof command !== "string" || command.trim() === "" || /[\r\n\0]/.test(command)) {
    return { ok: false, reason: "run_command: 'command' must be a non-empty single-line executable name." }
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

  for (const arg of args) {
    if (arg.includes("/") || arg.includes("\\")) {
      try {
        const candidate = physicalPath(path.resolve(cwdCheck.resolvedPath, arg))
        if (boundary.forbiddenReadRoots.some((root) => contains(root, candidate))) {
          return {
            ok: false,
            reason: `Command argument '${arg}' targets protected configuration/credential path ${candidate}.`,
          }
        }
      } catch {
        // Non-path argument or unresolvable token; let executable handle it cleanly
      }
    }
  }

  const found = resolveExecutable(command.trim(), env["PATH"] ?? "")
  if (!found.path) {
    return { ok: false, reason: `Executable not found on PATH: '${command.trim()}'` }
  }

  return {
    ok: true,
    prepared: {
      command: command.trim(),
      resolvedExecutable: found.path,
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

    const chunks: Buffer[] = []
    let bytes = 0
    let truncated = false
    let timedOut = false
    let cancelled = false

    const appendChunk = (buf: Buffer) => {
      if (bytes >= MAX_COMMAND_OUTPUT_BYTES) {
        truncated = true
        return
      }
      const remaining = MAX_COMMAND_OUTPUT_BYTES - bytes
      if (buf.byteLength > remaining) {
        chunks.push(buf.subarray(0, remaining))
        bytes = MAX_COMMAND_OUTPUT_BYTES
        truncated = true
      } else {
        chunks.push(buf)
        bytes += buf.byteLength
      }
    }

    child.stdout?.on("data", appendChunk)
    child.stderr?.on("data", appendChunk)

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
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
      const rawOutput = Buffer.concat(chunks).toString("utf8")
      const clean = sanitizeSecretText(rawOutput, options.activeSecret)
      resolve({
        exitCode,
        signal: sig,
        timedOut,
        cancelled,
        output: clean + (truncated ? `\n... (output truncated at ${MAX_COMMAND_OUTPUT_BYTES} bytes)` : ""),
        truncated,
      })
    }

    child.on("error", (error) => {
      chunks.push(Buffer.from(`spawn error: ${error.message}\n`))
      finalize(null, null)
    })

    child.on("close", (code, sig) => {
      finalize(code, sig)
    })
  })
}
