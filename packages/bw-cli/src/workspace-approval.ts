/**
 * First-run workspace approval for the isolated VM.
 *
 * Starting a coding session copies project files into a virtual machine and sends their
 * content, with the prompt, to the configured model provider. That is a decision for the
 * person who owns the project, so the first launch in a project asks, shows exactly what is
 * included, and records the answer in the same trust store `bashwink trust` uses.
 *
 * There is no flag or variable that answers for the user: a non-interactive launch in an
 * unapproved project is refused.
 */

import path from "node:path"
import { StartupError, type AcknowledgmentIO } from "./release.js"
import { canonicalWorkspace, grantTrust, isTrusted, readTrust, writeTrust } from "./trust.js"

export interface ApprovalSummary {
  readonly workspace: string
  /** File names that the VM receives and the byte size of each. */
  readonly included: readonly { readonly name: string; readonly bytes: number }[]
  /** Tracked entries the isolated profile does not stage. */
  readonly notStaged: number
  readonly provider: string
  readonly model: string
  readonly maxRequests: number
}

export function renderApproval(summary: ApprovalSummary): string {
  const total = summary.included.reduce((sum, file) => sum + file.bytes, 0)
  const shown = summary.included
    .slice(0, 12)
    .map((file) => `    ${file.name} (${file.bytes} bytes)`)
  const more = summary.included.length - shown.length
  return [
    `Approve this project for isolated coding?`,
    ``,
    `  Project: ${summary.workspace}`,
    `  Copied into the VM: ${summary.included.length} file(s), ${total} bytes`,
    ...shown,
    ...(more > 0 ? [`    ... and ${more} more`] : []),
    `  Not copied: ${summary.notStaged} other tracked entr${summary.notStaged === 1 ? "y" : "ies"} ` +
      `(this alpha stages only top-level .ts, .js and .txt files)`,
    ``,
    `  The agent edits the copy. Your project changes only when you review and apply them.`,
    `  File contents and prompts are sent to ${summary.provider} (model ${summary.model}) through a`,
    `  host-side relay, limited to ${summary.maxRequests} requests per session. The key stays on this Mac.`,
    ``,
  ].join("\n")
}

/**
 * Returns `"already"` when the project was approved earlier, `"granted"` after a new
 * approval. Throws `StartupError` when approval is withheld or cannot be asked for.
 */
export function requireWorkspaceApproval(input: {
  readonly configDirectory: string
  readonly summary: ApprovalSummary
  readonly io: AcknowledgmentIO
  readonly user: string
  readonly now?: () => Date
}): "already" | "granted" {
  const file = path.join(input.configDirectory, "trust.json")
  const workspace = canonicalWorkspace(input.summary.workspace)
  const trust = readTrust(file)
  if (isTrusted(trust, workspace)) return "already"
  if (!input.io.interactive)
    throw new StartupError(
      "workspace-not-approved",
      `${workspace} has not been approved for isolated coding, and approval needs an interactive ` +
        "terminal. Run `bashwink` once from a terminal in this project, or " +
        `\`bashwink trust ${workspace} --by "<your name>"\`.`,
    )
  input.io.write(`${renderApproval({ ...input.summary, workspace })}\n`)
  const answer = input.io.readLine("Approve this project? [y/N] ")
  if (answer === null || !/^(y|yes)$/i.test(answer.trim()))
    throw new StartupError(
      "workspace-not-approved",
      "the project was not approved. Nothing was copied into the VM and no model request was made.",
    )
  writeTrust(
    file,
    grantTrust(
      trust,
      workspace,
      `interactive:${input.user}`,
      (input.now ?? (() => new Date()))().toISOString(),
    ),
  )
  return "granted"
}

/**
 * Standard mode's first-run trust question. Unlike the VM approval it does not refuse when the answer is
 * no: an untrusted workspace is still usable read-only (the policy denies writes, shell, network, web and
 * automation there). It never asks without a terminal, and never answers for the user.
 */
export function offerWorkspaceTrust(input: {
  readonly configDirectory: string
  readonly workspace: string
  readonly io: AcknowledgmentIO
  readonly user: string
  readonly now?: () => Date
}): "already" | "granted" | "declined" | "not-asked" {
  const file = path.join(input.configDirectory, "trust.json")
  const workspace = canonicalWorkspace(input.workspace)
  const trust = readTrust(file)
  if (isTrusted(trust, workspace)) return "already"
  if (!input.io.interactive) return "not-asked"
  input.io.write(
    [
      `First time in ${workspace}`,
      ``,
      `Bashwink runs here in STANDARD mode: native and permission-controlled. It is NOT a sandbox.`,
      `  - Trusted: the agent may edit files in this folder. Shell and network commands still ask each time.`,
      `  - Not trusted: it can read files but cannot write, run commands or use the network.`,
      `  - Anything you approve runs as you and can reach whatever you can reach.`,
      `  - File contents and prompts are sent to your configured model provider.`,
      ``,
      ``,
    ].join("\n"),
  )
  const answer = input.io.readLine("Trust this folder? [y/N] ")
  if (answer === null || !/^(y|yes)$/i.test(answer.trim())) return "declined"
  writeTrust(
    file,
    grantTrust(
      trust,
      workspace,
      `interactive:${input.user}`,
      (input.now ?? (() => new Date()))().toISOString(),
    ),
  )
  return "granted"
}
