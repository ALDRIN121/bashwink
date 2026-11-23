/**
 * Fixture helper: record an attempt and then hold it open forever.
 *
 * The parent fixture SIGKILLs this process, so the attempt is left exactly as a real crash
 * leaves it: `state = 'started'`, no `finished_at`.
 */
import { Store } from "../../packages/bw-cli/src/store.ts"

const store = new Store({ file: `${process.env["BASHWINK_HOME"] ?? ""}/data/bashwink.sqlite` })
const attempt = store.startAttempt("inspect", "write_file", "fingerprint-of-intended-write")
process.stdout.write(`attempt=${attempt}\n`)
store.close()
await new Promise(() => {})
