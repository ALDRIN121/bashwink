/**
 * Fixture helper: is the abandoned attempt counted as applied?
 *
 * A separate file rather than `bun -e "…"` because an inline script inside a bash heredoc
 * has to survive two levels of quoting, and a shell-expanded `+ "/data/…"` silently became a
 * regex literal. That failure mode is invisible in review and cost a debugging cycle.
 */
import { Store } from "../../packages/bw-cli/src/store.ts"

const store = new Store({ file: `${process.env["BASHWINK_HOME"] ?? ""}/data/bashwink.sqlite` })
const applied = store.alreadyApplied("inspect", "write_file", "fingerprint-of-intended-write")
process.stdout.write(`${applied ? "yes" : "no"}\n`)
store.close()
