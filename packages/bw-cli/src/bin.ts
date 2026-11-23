/**
 * Executable entrypoint. The only file in the package that calls `process.exit`.
 *
 * Kept separate from `main.ts` so tests can import `main()` without terminating the test
 * runner — and so exit-code propagation has exactly one place to be audited.
 */

import { main } from "./main.js"

try {
  const result = await main(process.argv.slice(2))
  process.exit(result.exitCode)
} catch (error) {
  process.stderr.write(`bashwink: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(70)
}
