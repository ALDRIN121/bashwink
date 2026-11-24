import { existsSync, linkSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"

interface Lease {
  readonly runId: string
  readonly workspace: string
  readonly nonce: string
  readonly ack: string
  readonly retiring: string
}

export function readLease(): Lease | undefined {
  const value = process.env["BASHWINK_READINESS"]
  if (value === undefined) return undefined
  const lease = JSON.parse(value) as Partial<Lease>
  if (
    lease === null ||
    typeof lease.runId !== "string" ||
    lease.runId !== process.env["BASHWINK_RUN_ID"] ||
    typeof lease.workspace !== "string" ||
    !path.isAbsolute(lease.workspace) ||
    typeof lease.nonce !== "string" ||
    !/^[0-9a-f]{64}$/.test(lease.nonce) ||
    typeof lease.ack !== "string" ||
    !path.isAbsolute(lease.ack) ||
    typeof lease.retiring !== "string" ||
    path.dirname(lease.ack) !== path.dirname(lease.retiring)
  )
    throw new Error("invalid Bashwink policy readiness lease")
  return lease as Lease
}

/** Only called after every required hook has registered successfully. */
export function acknowledge(lease: Lease): () => void {
  const pending = `${lease.ack}.pending`
  writeFileSync(
    pending,
    JSON.stringify({
      v: 1,
      runId: lease.runId,
      workspace: lease.workspace,
      nonce: lease.nonce,
      pid: process.pid,
    }),
    { flag: "wx", mode: 0o600 },
  )
  try {
    linkSync(pending, lease.ack)
  } finally {
    unlinkSync(pending)
  }
  // In the pinned Promise adapter the setup cleanup finalizer is registered after
  // registrations themselves and runs first. An unexpected unload kills the owned
  // server before it can expose a generation without the required hooks.
  return () => {
    if (existsSync(lease.retiring)) return
    try {
      unlinkSync(lease.ack)
    } finally {
      process.exit(3)
    }
  }
}
