import { existsSync, readFileSync } from "node:fs"

/**
 * Disclosure of changed test files.
 *
 * Standard mode has no protected-test mechanism (that exists only in the isolated VM): the agent may edit or delete
 * a test, and a passing result can then come from a test that was changed. The evidence log records every file write
 * and edit the agent made through the runtime's file tools, so after a run Bashwink says which test files those were.
 *
 * What this does not see: a test changed by a shell command (`sed -i`, `rm`, `git checkout`, a formatter), or changed
 * by the user or another program during the run. The message says so; it is a disclosure, not a guarantee.
 */
const TEST_PATH =
  /(^|[\\/])(tests?|__tests__|specs?)[\\/]|[._-](test|spec)\.[A-Za-z0-9]+$|(^|[\\/])(test|spec)\.[A-Za-z0-9]+$|(^|[\\/])test_[^\\/]+\.py$|(^|[\\/])[^\\/]+_test\.(go|py|rb|exs?)$/i

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path)
}

const FILE_TOOLS = new Set(["write", "edit", "multiedit"])
const PATCH_TOOLS = new Set(["patch", "apply_patch"])

function targetsOf(tool: string, input: unknown): string[] {
  if (typeof input !== "object" || input === null) return []
  const record = input as Record<string, unknown>
  if (FILE_TOOLS.has(tool)) {
    for (const key of ["path", "filePath", "file_path", "file"]) {
      const value = record[key]
      if (typeof value === "string" && value !== "") return [value]
    }
    return []
  }
  if (PATCH_TOOLS.has(tool) && typeof record["patchText"] === "string")
    return [
      ...(record["patchText"] as string).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm),
    ].map((match) => (match[1] ?? "").trim())
  return []
}

/** Test files the agent wrote, edited or patched after evidence entry `afterSeq` (this run's boot entry). */
export function changedTestFiles(evidenceFile: string, afterSeq: number): string[] {
  if (!existsSync(evidenceFile)) return []
  const found = new Set<string>()
  for (const line of readFileSync(evidenceFile, "utf8").split("\n")) {
    if (line.trim() === "") continue
    try {
      const entry = JSON.parse(line) as {
        seq?: number
        phase?: string
        call?: { tool?: string }
        payload?: { input?: unknown }
      }
      if (entry.phase !== "before" || typeof entry.seq !== "number" || entry.seq <= afterSeq)
        continue
      const tool = entry.call?.tool
      if (tool === undefined) continue
      for (const target of targetsOf(tool, entry.payload?.input))
        if (isTestPath(target)) found.add(target)
    } catch {
      // A malformed line is the evidence verifier's concern, not a reason to hide the others.
    }
  }
  return [...found].sort()
}

export function renderTestChanges(files: readonly string[]): string {
  return (
    `Note: this run changed test files through the file tools: ${files.join(", ")}.\n` +
    "  A passing result may come from a test that was changed, so review them. Standard mode does not protect tests, and\n" +
    "  changes made by shell commands (sed, rm, git checkout) are not detected."
  )
}
