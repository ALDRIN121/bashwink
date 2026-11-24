/**
 * Terminal-UI half of the Bashwink plugin: tells the person which execution mode this session
 * runs in, inside the TUI itself, not only in the line printed before it started.
 *
 * It reads `BASHWINK_EXECUTION_MODE`, which the launcher sets for the child it starts. A
 * missing or unknown value is shown as "unknown" rather than guessed, so the display can never
 * claim isolation the launcher did not establish.
 */
import { Plugin } from "@opencode/plugin/tui"

const LABELS: Record<string, { title: string; message: string; variant: "info" | "warning" }> = {
  "isolated-vm": {
    title: "Bashwink · ISOLATED VM",
    message:
      "Working on a copy inside a network-less VM. Your project changes only when you review and apply.",
    variant: "info",
  },
  "unrestricted-host": {
    title: "Bashwink · UNRESTRICTED HOST ACCESS",
    message:
      "Not isolated. Approved commands run as you, with your files, network and credentials.",
    variant: "warning",
  },
  "development-host": {
    title: "Bashwink · DEVELOPMENT HOST",
    message: "Source build, not isolated. Approved commands run as you.",
    variant: "warning",
  },
}

export default Plugin.define({
  id: "bashwink-execution-mode",
  setup(context) {
    const mode = process.env["BASHWINK_EXECUTION_MODE"] ?? ""
    const label = LABELS[mode] ?? {
      title: "Bashwink · execution mode unknown",
      message: "The launcher did not report an execution mode. Do not assume isolation.",
      variant: "warning" as const,
    }
    context.ui.toast.show({ ...label, duration: 20_000 })
  },
})
