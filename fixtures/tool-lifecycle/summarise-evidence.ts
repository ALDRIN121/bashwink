/**
 * Fixture helper: summarise an evidence log for the lifecycle assertions.
 *
 * Reads the log the way a reviewer would — parse each JSONL line, join `before`/`after` on the
 * call id, and report what is missing. Kept as a file rather than `bun -e "…"` so it survives
 * shell quoting and can be read.
 */
import { readFileSync } from "node:fs"

const file = process.env["LOG"]
if (file === undefined) {
  process.stderr.write("LOG is required\n")
  process.exit(2)
}

interface Entry {
  phase?: string
  call?: { id?: string; tool?: string; taskID?: string; unassignedReason?: string }
  payload?: { status?: string; exit?: number; outputDigest?: string }
}

const entries = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Entry)
  // A `boot` entry is the plugin's start-up record, not a tool call. Counting it here would
  // make the fixture report a permanently "bare" event on every healthy run.
  .filter((entry) => entry.phase === "before" || entry.phase === "after")

const befores = entries.filter((entry) => entry.phase === "before")
const afters = entries.filter((entry) => entry.phase === "after")
const beforeIds = new Set(befores.map((entry) => entry.call?.id))
const matched = afters.filter((entry) => beforeIds.has(entry.call?.id))

const linked = entries.filter((entry) => typeof entry.call?.taskID === "string")
const reasoned = entries.filter(
  (entry) => entry.call?.taskID === undefined && typeof entry.call?.unassignedReason === "string",
)
const bare = entries.filter(
  (entry) => entry.call?.taskID === undefined && entry.call?.unassignedReason === undefined,
)

process.stdout.write(
  `${JSON.stringify(
    {
      total: entries.length,
      befores: befores.length,
      afters: afters.length,
      matched: matched.length,
      exits: matched.map((entry) => entry.payload?.exit),
      tools: [...new Set(entries.map((entry) => entry.call?.tool))],
      linked: linked.length,
      reasoned: reasoned.length,
      bare: bare.length,
      taskIDs: [...new Set(linked.map((entry) => entry.call?.taskID))],
    },
    null,
    0,
  )}\n`,
)
