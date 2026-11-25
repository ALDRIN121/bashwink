#!/usr/bin/env node
/**
 * Standalone executable entrypoint. The only file in the standalone bundle calling `process.exit`.
 */

import { runStandalone } from "./terminal.ts"

try {
  const code = await runStandalone(process.argv.slice(2))
  process.exit(code)
} catch (error) {
  process.stderr.write(`bashwink: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
