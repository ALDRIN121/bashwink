/** @jsxImportSource @opentui/solid */
/**
 * Terminal-UI half of the Bashwink plugin: shows which execution boundary is active, inside the
 * TUI, for the whole session. A short toast announces it at start; a footer line stays on
 * screen on the home view and next to the prompt.
 *
 * The wording and the mapping from `BASHWINK_EXECUTION_MODE` live in `tui-mode.ts`. This file is
 * only glue and is not type-checked by this package, because the JSX types come from the host
 * runtime; PTY tests render the real screen instead.
 */
import { Plugin } from "@opencode/plugin/tui"
import { modeLabel } from "./tui-mode.ts"

export default Plugin.define({
  id: "bashwink-execution-mode",
  setup(context) {
    const label = modeLabel(process.env["BASHWINK_EXECUTION_MODE"])
    context.ui.toast.show({
      title: label.title,
      message: label.message,
      variant: label.variant,
      duration: 20_000,
    })
    const line = `[${label.indicator}]`
    const view = () => <text fg={context.theme.text.base}>{line}</text>
    context.ui.slot({ append: "home.footer", render: view })
    context.ui.slot({ append: "prompt.footer.status", render: view })
  },
})
