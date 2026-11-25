// Local replacement for the `@opencode/pty` registry package. See local-pty.ts for why this is
// not a re-export: the migration removes the registry dependency, and a shim that re-exported it
// would put the dependency straight back.
import { binaryPath as localBinaryPath } from "./local-pty.js"

const binding: string | { readonly path: string; readonly version: string; readonly sha256: string } | undefined =
  localBinaryPath

export default binding
