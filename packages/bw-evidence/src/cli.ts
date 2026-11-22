#!/usr/bin/env bun
/**
 * Evidence log verifier.
 *
 * `bashwink verify` equivalent for Phase 0: recompute the hash chain and print a
 * machine-readable verdict. Exits nonzero on a broken chain so CI can gate on it.
 *
 * Usage:
 *   bun run packages/bw-evidence/src/cli.ts verify [path/to/evidence.jsonl]
 *   bun run packages/bw-evidence/src/cli.ts show   [path/to/evidence.jsonl]
 */

import { existsSync } from "node:fs"
import path from "node:path"
import { readFileSync } from "node:fs"
import { verify, type EvidenceEntry } from "./recorder.js"

const DEFAULT_FILE = path.join(process.cwd(), ".bashwink", "evidence", "evidence.jsonl")

function usage(): never {
  console.error("usage: cli.ts <verify|show> [file]")
  process.exit(2)
}

const [command, fileArg] = process.argv.slice(2)
if (command !== "verify" && command !== "show") usage()
const file = fileArg ?? DEFAULT_FILE

if (!existsSync(file)) {
  console.error(`no evidence log at ${file}`)
  process.exit(2)
}

if (command === "verify") {
  const result = verify(file)
  if (result.ok) {
    console.log(JSON.stringify({ ok: true, entries: result.entries, head: result.head }))
    process.exit(0)
  }
  console.error(JSON.stringify(result))
  process.exit(1)
}

const entries = readFileSync(file, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as EvidenceEntry)

for (const entry of entries) {
  const detail =
    entry.phase === "after"
      ? `status=${entry.payload.status ?? "-"} exit=${entry.payload.exit ?? "-"}`
      : "input"
  console.log(`${String(entry.seq).padStart(3)} ${entry.at} ${entry.phase.padEnd(6)} ${entry.call.tool.padEnd(10)} ${detail}`)
}
const final = verify(file)
console.log(`\n${entries.length} entries; chain ${final.ok ? "valid" : "BROKEN"}`)
process.exit(final.ok ? 0 : 1)
