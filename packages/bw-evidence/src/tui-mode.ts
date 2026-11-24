/**
 * What the terminal UI says about the execution boundary. Kept apart from the JSX glue in
 * `tui.tsx` so the wording and the "never guess" rule are type-checked and unit tested.
 *
 * The launcher passes `BASHWINK_EXECUTION_MODE` to the child it starts. Anything else, including
 * a missing value, is reported as unknown. A display must never claim isolation that the
 * launcher did not establish.
 */

export interface ModeLabel {
  /** Always-visible footer text. */
  readonly indicator: string
  readonly title: string
  readonly message: string
  readonly variant: "info" | "warning"
}

const LABELS: Readonly<Record<string, ModeLabel>> = {
  "isolated-vm": {
    indicator: "SANDBOXED VM",
    title: "Bashwink · ISOLATED VM",
    message:
      "Working on a copy inside a network-less VM. Your project changes only when you review and apply.",
    variant: "info",
  },
  "unrestricted-host": {
    indicator: "UNSAFE LOCAL MODE",
    title: "Bashwink · UNRESTRICTED HOST ACCESS",
    message:
      "Not isolated. Approved commands run as you, with your files, network and credentials.",
    variant: "warning",
  },
  "development-host": {
    indicator: "DEVELOPMENT HOST - NOT ISOLATED",
    title: "Bashwink · DEVELOPMENT HOST",
    message: "Source build, not isolated. Approved commands run as you.",
    variant: "warning",
  },
}

const UNKNOWN: ModeLabel = {
  indicator: "EXECUTION MODE UNKNOWN",
  title: "Bashwink · execution mode unknown",
  message: "The launcher did not report an execution mode. Do not assume isolation.",
  variant: "warning",
}

export function modeLabel(mode: string | undefined): ModeLabel {
  return (mode !== undefined && Object.hasOwn(LABELS, mode) ? LABELS[mode] : undefined) ?? UNKNOWN
}
