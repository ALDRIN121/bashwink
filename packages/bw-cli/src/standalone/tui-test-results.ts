import {
  ACTIVITY_CARD_INSET,
  alignRight,
  renderActivityCard,
  truncatePlain,
  visibleWidth,
  type TuiStyle,
} from "./tui-theme.ts"

interface TestCase {
  readonly name: string
  readonly status: "passed" | "failed" | "skipped" | "todo"
  detail?: string
  duration?: number
}

/** Summarize complete Node TAP output. The transcript uses plain command output for other reporters. */
export function renderTapResults(output: string, cols: number, style: TuiStyle): string[] | undefined {
  const lines = output.split("\n")
  const header = lines.indexOf("TAP version 13")
  if (header < 0 || lines.lastIndexOf("TAP version 13") !== header || cols < 30) return undefined

  const cases: TestCase[] = []
  const totals = new Map<string, number>()
  let current: TestCase | undefined
  let plan: number | undefined
  for (const line of lines.slice(header + 1)) {
    if (/^\s*Bail out!/i.test(line)) return undefined
    const total = /^# (tests|pass|fail|skipped|todo) (\d+)$/.exec(line)
    if (total) {
      if (plan === undefined || totals.has(total[1]!)) return undefined
      totals.set(total[1]!, Number(total[2]))
    } else if (/^1\.\.\d+$/.test(line)) {
      if (plan !== undefined) return undefined
      plan = Number(line.slice(3))
      current = undefined
    } else {
      const result = /^(not ok|ok) (\d+) - (.+)$/.exec(line)
      if (result) {
        if (plan !== undefined || Number(result[2]) !== cases.length + 1) return undefined
        const name = result[3]!
        const directive = /\s+# (SKIP|TODO)\b/i.exec(name)
        const status = directive?.[1]?.toUpperCase() === "SKIP" ? "skipped"
          : directive ? "todo" : result[1] === "ok" ? "passed" : "failed"
        current = { name: directive ? name.slice(0, directive.index) : name, status }
        cases.push(current)
      } else if (current) {
        const duration = /^  duration_ms: (\d+(?:\.\d+)?)$/.exec(line)
        if (duration) current.duration = Math.round(Number(duration[1]))
        const detail = /^  error: (.+)$/.exec(line)
        if (detail) current.detail = detail[1]!.replace(/^(['"])(.*)\1$/, "$2")
      }
    }
  }

  const groups = [
    { status: "failed", key: "fail", color: style.red, icon: "✗" },
    { status: "passed", key: "pass", color: style.green, icon: "✓" },
    { status: "skipped", key: "skipped", color: style.muted, icon: "–" },
    { status: "todo", key: "todo", color: style.muted, icon: "–" },
  ].map((group) => ({ ...group, cases: cases.filter((item) => item.status === group.status) }))
  if (plan !== cases.length || totals.get("tests") !== cases.length || !totals.has("pass") || !totals.has("fail") ||
    groups.some((group) => (totals.get(group.key) ?? 0) !== group.cases.length)) return undefined

  const width = cols - ACTIVITY_CARD_INSET
  const summary = groups.filter((group) => group.cases.length > 0)
    .map((group) => `${group.cases.length} ${group.status}`).join(", ") || "0 tests"
  const rows = [`${style.accent("❯")} ${style.bold(truncatePlain(`Test results (${summary})`, width - 2))}`]
  for (const group of groups) {
    const shown = group.cases.slice(0, group.status === "failed" ? 2 : 1)
    for (const item of shown) {
      const duration = item.duration === undefined ? "" : style.muted(`${item.duration} ms`)
      const textWidth = width - 2 - (duration ? visibleWidth(duration) + 1 : 0)
      const label = item.detail && item.status === "failed" ? `${item.name}  —  ${item.detail}` : item.name
      const text = truncatePlain(label, textWidth)
      const colored = item.status === "failed" ? group.color(text) : text
      rows.push(alignRight(`${group.color(group.icon)} ${colored}`, duration, width))
    }
    if (group.cases.length > shown.length) {
      rows.push(style.muted(`  … ${group.cases.length - shown.length} more ${group.status}`))
    }
  }
  return renderActivityCard(rows, cols, style)
}
