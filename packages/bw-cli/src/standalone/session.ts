/**
 * Persistent standalone session store, checkpoint snapshots, rewind/fork helpers,
 * prompt history, and workspace file discovery for `@` mentions.
 *
 * Pure Node 22+ built-ins only; respects workspace trust and path boundaries on restore.
 */

import { createHash, randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"
import { checkWorkspaceWritePath, sanitizeSecretText, type BoundaryContext } from "./security.ts"
import type {
  ChatMessage,
  CommandOutcomeRecord,
  DiffPreviewRecord,
  RunActionRecord,
  RunSummaryRecord,
  TaskResult,
} from "./types.ts"

export const SESSION_SCHEMA_VERSION = 1
const MAX_CHECKPOINT_BYTES = 1024 * 1024
const MAX_HISTORY_ENTRIES = 500
const MAX_STORED_SESSIONS = 200

export interface FileCheckpoint {
  readonly relativePath: string
  readonly existedBefore: boolean
  readonly contentBase64?: string
  readonly sha256Before?: string
}

export interface SessionTurn {
  readonly id: string
  readonly createdAt: string
  readonly userPrompt: string
  readonly assistantText: string
  readonly outcome: TaskResult["outcome"]
  readonly stopReason?: string
  readonly runId: string
  readonly model: string
  readonly messageCountBefore: number
  readonly changedFiles: readonly string[]
  readonly diffPreviews?: readonly DiffPreviewRecord[]
  readonly commands: readonly CommandOutcomeRecord[]
  readonly actions: readonly RunActionRecord[]
  readonly checkpoints: readonly FileCheckpoint[]
  readonly usage: RunSummaryRecord["usage"]
}

export interface SessionRecord {
  readonly version: 1
  readonly id: string
  readonly title: string
  readonly customTitle?: boolean
  readonly workspace: string
  readonly gitBranch?: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly archived?: boolean
  readonly pinned?: boolean
  readonly parentSessionId?: string
  readonly forkedFromTurnId?: string
  readonly messages: readonly ChatMessage[]
  readonly turns: readonly SessionTurn[]
  readonly usageTotals: {
    readonly requests: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly totalTokens: number
    readonly costUsd?: number
  }
}

export function sessionsDir(dataDir: string): string {
  return path.join(dataDir, "sessions")
}

export function sessionFilePath(dataDir: string, sessionId: string): string {
  const safeId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_")
  return path.join(sessionsDir(dataDir), `${safeId}.json`)
}

export function detectGitBranch(workspace: string): string | undefined {
  for (const gitBin of ["git", "/Library/Developer/CommandLineTools/usr/bin/git", "/usr/bin/git"]) {
    try {
      const res = spawnSync(gitBin, ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 800,
      })
      if (res.status === 0) {
        const branch = res.stdout.trim()
        if (branch && branch !== "HEAD") return branch
      }
      if (res.status !== undefined) return undefined
    } catch {
      // Try next git candidate
    }
  }
  return undefined
}

export function createSession(workspace: string, gitBranch?: string): SessionRecord {
  const now = new Date().toISOString()
  const stamp = now.slice(0, 19).replace(/[-:T]/g, "")
  const id = `ses_${stamp}_${randomBytes(3).toString("hex")}`
  return {
    version: SESSION_SCHEMA_VERSION,
    id,
    title: "New session",
    workspace,
    ...(gitBranch ? { gitBranch } : {}),
    createdAt: now,
    updatedAt: now,
    messages: [],
    turns: [],
    usageTotals: {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
  }
}

function sanitizeUnknownSecret(value: unknown, activeSecret?: string, depth = 0): unknown {
  if (depth > 12) return "[DEPTH_LIMIT]"
  if (typeof value === "string") return sanitizeSecretText(value, activeSecret)
  if (Array.isArray(value)) return value.map((item) => sanitizeUnknownSecret(item, activeSecret, depth + 1))
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeUnknownSecret(v, activeSecret, depth + 1)
    }
    return out
  }
  return value
}

function sanitizeChatMessages(messages: readonly ChatMessage[], activeSecret?: string): ChatMessage[] {
  return messages.map((msg) => {
    if (msg.role === "assistant") {
      return {
        role: "assistant",
        content: sanitizeSecretText(msg.content, activeSecret),
        ...(msg.toolCalls
          ? {
              toolCalls: msg.toolCalls.map((tc) => ({
                ...tc,
                input: sanitizeUnknownSecret(tc.input, activeSecret) as Record<string, unknown>,
                ...(tc.rawArguments !== undefined
                  ? { rawArguments: sanitizeSecretText(tc.rawArguments, activeSecret) }
                  : {}),
              })),
            }
          : {}),
      }
    }
    if (msg.role === "tool") {
      return {
        role: "tool",
        callId: msg.callId,
        name: msg.name,
        content: sanitizeSecretText(msg.content, activeSecret),
        ...(msg.isError === undefined ? {} : { isError: msg.isError }),
      }
    }
    return {
      role: msg.role,
      content: sanitizeSecretText(msg.content, activeSecret),
    }
  })
}

export function deriveSessionTitle(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim()
  if (clean === "") return "Untitled session"
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean
}

export function saveSession(
  dataDir: string,
  session: SessionRecord,
  activeSecret?: string,
): string {
  const dir = sessionsDir(dataDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const sanitized: SessionRecord = {
    ...session,
    title: sanitizeSecretText(session.title, activeSecret),
    messages: sanitizeChatMessages(session.messages, activeSecret),
    turns: session.turns.map((t) => ({
      ...t,
      userPrompt: sanitizeSecretText(t.userPrompt, activeSecret),
      assistantText: sanitizeSecretText(t.assistantText, activeSecret),
      commands: t.commands.map((c) => ({
        ...c,
        command: sanitizeSecretText(c.command, activeSecret),
        args: c.args.map((a) => sanitizeSecretText(a, activeSecret)),
      })),
      ...(t.actions
        ? {
            actions: t.actions.map((a) => ({
              ...a,
              summary: sanitizeSecretText(a.summary, activeSecret),
            })),
          }
        : {}),
      ...(t.diffPreviews
        ? {
            diffPreviews: t.diffPreviews.map((d) => ({
              ...d,
              patch: sanitizeSecretText(d.patch, activeSecret),
            })),
          }
        : {}),
      ...(t.stopReason === undefined
        ? {}
        : { stopReason: sanitizeSecretText(t.stopReason, activeSecret) }),
    })),
  }
  const target = sessionFilePath(dataDir, sanitized.id)
  const temp = path.join(dir, `.${sanitized.id}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  writeFileSync(temp, `${JSON.stringify(sanitized, null, 2)}\n`, { mode: 0o600, encoding: "utf8" })
  renameSync(temp, target)
  return target
}

export function loadSession(dataDir: string, sessionId: string): SessionRecord | undefined {
  const file = sessionFilePath(dataDir, sessionId)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
    if (parsed["version"] !== SESSION_SCHEMA_VERSION) return undefined
    if (typeof parsed["id"] !== "string" || typeof parsed["workspace"] !== "string") return undefined
    return parsed as unknown as SessionRecord
  } catch {
    return undefined
  }
}

export function deleteSession(dataDir: string, sessionId: string): boolean {
  const file = sessionFilePath(dataDir, sessionId)
  if (!existsSync(file)) return false
  try {
    unlinkSync(file)
    return true
  } catch {
    return false
  }
}

export function listSessions(
  dataDir: string,
  options: { readonly workspace?: string; readonly includeArchived?: boolean } = {},
): SessionRecord[] {
  const dir = sessionsDir(dataDir)
  if (!existsSync(dir)) return []
  const out: SessionRecord[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  for (const name of entries) {
    if (!name.endsWith(".json") || name.startsWith(".")) continue
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as Record<string, unknown>
      if (parsed["version"] !== SESSION_SCHEMA_VERSION) continue
      const rec = parsed as unknown as SessionRecord
      if (!options.includeArchived && rec.archived) continue
      if (options.workspace && path.resolve(rec.workspace) !== path.resolve(options.workspace)) continue
      out.push(rec)
    } catch {
      // Ignore corrupt session file
    }
  }
  out.sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
    return b.updatedAt.localeCompare(a.updatedAt)
  })
  return out.slice(0, MAX_STORED_SESSIONS)
}

export function appendTurnToSession(
  session: SessionRecord,
  turnInput: {
    readonly userPrompt: string
    readonly result: TaskResult
    readonly model: string
    readonly checkpoints: readonly FileCheckpoint[]
  },
): SessionRecord {
  const now = new Date().toISOString()
  const messageCountBefore = session.messages.length
  const delta = turnInput.result.messages ?? [
    { role: "user" as const, content: turnInput.userPrompt },
    ...(turnInput.result.finalText
      ? [{ role: "assistant" as const, content: turnInput.result.finalText }]
      : []),
  ]
  const turn: SessionTurn = {
    id: `turn_${session.turns.length + 1}`,
    createdAt: now,
    userPrompt: turnInput.userPrompt,
    assistantText: turnInput.result.finalText,
    outcome: turnInput.result.outcome,
    ...(turnInput.result.stopReason === undefined ? {} : { stopReason: turnInput.result.stopReason }),
    runId: turnInput.result.runId,
    model: turnInput.model,
    messageCountBefore,
    changedFiles: [...turnInput.result.changedFiles],
    ...(turnInput.result.diffPreviews ? { diffPreviews: [...turnInput.result.diffPreviews] } : {}),
    commands: [...turnInput.result.commands],
    actions: [...(turnInput.result.actions ?? [])],
    checkpoints: [...turnInput.checkpoints],
    usage: turnInput.result.usage,
  }
  const nextTitle =
    !session.customTitle && session.turns.length === 0
      ? deriveSessionTitle(turnInput.userPrompt)
      : session.title
  const nextCost =
    session.usageTotals.costUsd !== undefined || turnInput.result.usage.costUsd !== undefined
      ? Number(((session.usageTotals.costUsd ?? 0) + (turnInput.result.usage.costUsd ?? 0)).toFixed(6))
      : undefined
  return {
    ...session,
    title: nextTitle,
    updatedAt: now,
    messages: [...session.messages, ...delta],
    turns: [...session.turns, turn],
    usageTotals: {
      requests: session.usageTotals.requests + turnInput.result.requests,
      inputTokens: session.usageTotals.inputTokens + turnInput.result.usage.inputTokens,
      outputTokens: session.usageTotals.outputTokens + turnInput.result.usage.outputTokens,
      totalTokens: session.usageTotals.totalTokens + turnInput.result.usage.totalTokens,
      ...(nextCost === undefined ? {} : { costUsd: nextCost }),
    },
  }
}

export function forkSession(
  source: SessionRecord,
  upToTurnCount?: number,
): SessionRecord {
  const count = upToTurnCount === undefined ? source.turns.length : Math.max(0, Math.min(upToTurnCount, source.turns.length))
  const keptTurns = source.turns.slice(0, count)
  const cutTurn = source.turns[count]
  const keptMessages = cutTurn ? source.messages.slice(0, cutTurn.messageCountBefore) : [...source.messages]
  const base = createSession(source.workspace, source.gitBranch)
  const forkedFrom = keptTurns.at(-1)?.id
  return {
    ...base,
    title: `${source.title} (fork)`,
    customTitle: true,
    parentSessionId: source.id,
    ...(forkedFrom === undefined ? {} : { forkedFromTurnId: forkedFrom }),
    messages: keptMessages,
    turns: keptTurns,
    usageTotals: keptTurns.reduce(
      (acc, t) => ({
        requests: acc.requests + 1,
        inputTokens: acc.inputTokens + t.usage.inputTokens,
        outputTokens: acc.outputTokens + t.usage.outputTokens,
        totalTokens: acc.totalTokens + t.usage.totalTokens,
        ...(acc.costUsd !== undefined || t.usage.costUsd !== undefined
          ? { costUsd: Number(((acc.costUsd ?? 0) + (t.usage.costUsd ?? 0)).toFixed(6)) }
          : {}),
      }),
      { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } as SessionRecord["usageTotals"],
    ),
  }
}

export function captureFileCheckpoint(
  workspace: string,
  relativePath: string,
  targetPath: string,
): FileCheckpoint | undefined {
  if (!existsSync(targetPath)) {
    return { relativePath, existedBefore: false }
  }
  try {
    const st = statSync(targetPath)
    if (!st.isFile() || st.size > MAX_CHECKPOINT_BYTES) return undefined
    const bytes = readFileSync(targetPath)
    return {
      relativePath,
      existedBefore: true,
      contentBase64: bytes.toString("base64"),
      sha256Before: createHash("sha256").update(bytes).digest("hex"),
    }
  } catch {
    return undefined
  }
}

export interface RestoreResult {
  readonly restored: string[]
  readonly removed: string[]
  readonly skipped: { readonly path: string; readonly reason: string }[]
}

export function restoreTurnCheckpoints(
  boundary: BoundaryContext,
  turnsToRevert: readonly SessionTurn[],
): RestoreResult {
  const restored: string[] = []
  const removed: string[] = []
  const skipped: { path: string; reason: string }[] = []

  // Apply checkpoints in reverse chronological order so earliest state wins
  const allCheckpoints: FileCheckpoint[] = []
  for (let i = turnsToRevert.length - 1; i >= 0; i -= 1) {
    const turn = turnsToRevert[i]!
    for (let j = turn.checkpoints.length - 1; j >= 0; j -= 1) {
      allCheckpoints.push(turn.checkpoints[j]!)
    }
  }

  for (const cp of allCheckpoints) {
    const check = checkWorkspaceWritePath(boundary, cp.relativePath)
    if (!check.allow) {
      skipped.push({ path: cp.relativePath, reason: check.reason })
      continue
    }
    try {
      if (!cp.existedBefore) {
        if (existsSync(check.resolvedPath)) {
          unlinkSync(check.resolvedPath)
          removed.push(cp.relativePath)
        }
      } else if (cp.contentBase64 !== undefined) {
        const buf = Buffer.from(cp.contentBase64, "base64")
        mkdirSync(path.dirname(check.resolvedPath), { recursive: true })
        const temp = path.join(
          path.dirname(check.resolvedPath),
          `.bw-rewind.${process.pid}.${randomBytes(3).toString("hex")}.tmp`,
        )
        writeFileSync(temp, buf)
        renameSync(temp, check.resolvedPath)
        restored.push(cp.relativePath)
      }
    } catch (err) {
      skipped.push({
        path: cp.relativePath,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return { restored, removed, skipped }
}

export function rewindSessionToTurn(
  session: SessionRecord,
  turnIndex: number,
): { readonly updated: SessionRecord; readonly revertedTurns: readonly SessionTurn[]; readonly promptToRestore: string } {
  const clamped = Math.max(0, Math.min(turnIndex, session.turns.length - 1))
  const targetTurn = session.turns[clamped]
  if (!targetTurn) {
    return { updated: session, revertedTurns: [], promptToRestore: "" }
  }
  const keptTurns = session.turns.slice(0, clamped)
  const revertedTurns = session.turns.slice(clamped)
  const keptMessages = session.messages.slice(0, targetTurn.messageCountBefore)
  return {
    updated: {
      ...session,
      updatedAt: new Date().toISOString(),
      messages: keptMessages,
      turns: keptTurns,
    },
    revertedTurns,
    promptToRestore: targetTurn.userPrompt,
  }
}

export function compactSessionMessages(
  session: SessionRecord,
  keepRecentTurns = 2,
): { readonly updated: SessionRecord; readonly summarizedTurns: number; readonly beforeMessages: number; readonly afterMessages: number } {
  const beforeMessages = session.messages.length
  if (session.turns.length <= keepRecentTurns) {
    return { updated: session, summarizedTurns: 0, beforeMessages, afterMessages: beforeMessages }
  }
  const cutIdx = session.turns.length - keepRecentTurns
  const olderTurns = session.turns.slice(0, cutIdx)
  const firstKeptTurn = session.turns[cutIdx]!
  const recentMessages = session.messages.slice(firstKeptTurn.messageCountBefore)

  const summaryLines = olderTurns.map((t, idx) => {
    const files = t.changedFiles.length > 0 ? ` [edited: ${t.changedFiles.join(", ")}]` : ""
    const promptShort = t.userPrompt.replace(/\s+/g, " ").trim().slice(0, 120)
    const answerShort = t.assistantText.replace(/\s+/g, " ").trim().slice(0, 180)
    return `Turn ${idx + 1} (${t.outcome}${files}): User="${promptShort}" -> Assistant="${answerShort}"`
  })
  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[Compacted session context from ${olderTurns.length} earlier turn(s)]\n${summaryLines.join("\n")}`,
  }
  const nextMessages = [summaryMessage, ...recentMessages]
  const offsetDelta = firstKeptTurn.messageCountBefore - 1
  const nextTurns = session.turns.map((t, i) =>
    i < cutIdx
      ? { ...t, messageCountBefore: 0 }
      : { ...t, messageCountBefore: Math.max(1, t.messageCountBefore - offsetDelta) },
  )
  return {
    updated: {
      ...session,
      updatedAt: new Date().toISOString(),
      messages: nextMessages,
      turns: nextTurns,
    },
    summarizedTurns: olderTurns.length,
    beforeMessages,
    afterMessages: nextMessages.length,
  }
}

export function promptHistoryFile(dataDir: string): string {
  return path.join(dataDir, "prompt-history.json")
}

export function loadPromptHistory(dataDir: string): string[] {
  const file = promptHistoryFile(dataDir)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === "string")
  } catch {
    return []
  }
}

export function appendPromptHistory(dataDir: string, entry: string): string[] {
  const clean = entry.trim()
  const existing = loadPromptHistory(dataDir)
  if (clean === "" || existing.at(-1) === clean) return existing
  const next = [...existing, clean].slice(-MAX_HISTORY_ENTRIES)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const target = promptHistoryFile(dataDir)
  const temp = path.join(dataDir, `.history.${process.pid}.${randomBytes(3).toString("hex")}.tmp`)
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, encoding: "utf8" })
  renameSync(temp, target)
  return next
}

/** Bounded workspace file walk for `@` autocomplete suggestions. */
export function listWorkspaceFiles(workspace: string, maxFiles = 300): string[] {
  const out: string[] = []
  const skip = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo"])
  const walk = (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > 5) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break
      if (entry.isSymbolicLink() || skip.has(entry.name)) continue
      const abs = path.join(dir, entry.name)
      const rel = path.relative(workspace, abs).split(path.sep).join("/")
      if (entry.isDirectory()) {
        walk(abs, depth + 1)
      } else if (entry.isFile()) {
        out.push(rel)
      }
    }
  }
  walk(workspace, 0)
  return out
}
