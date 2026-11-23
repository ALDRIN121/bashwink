/**
 * Fixture helper: prove the same write is applied exactly once across repeated attempts.
 *
 * Counts real writer invocations rather than trusting the returned reason, so the assertion
 * is about the write actually happening once, not about the function's own bookkeeping.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { Store } from "../../packages/bw-cli/src/store.ts"
import { applyWrite } from "../../packages/bw-cli/src/resume.ts"

const target = process.env["TARGET"]
if (target === undefined) {
  process.stderr.write("TARGET is required\n")
  process.exit(2)
}

const store = new Store({ file: `${process.env["BASHWINK_HOME"] ?? ""}/data/bashwink.sqlite` })
mkdirSync(path.dirname(target), { recursive: true })

let writes = 0
const write = (file: string, content: string) => {
  writes += 1
  writeFileSync(file, content, "utf8")
}

const content = "patched line\n"
const first = applyWrite({ store, taskId: "inspect", file: target, content, write })
const second = applyWrite({ store, taskId: "inspect", file: target, content, write })

process.stdout.write(`writes=${writes} first=${first.reason} second=${second.reason}\n`)
store.close()
