/**
 * Public surface of `@bashwink/cli`.
 *
 * Exported so the CLI's logic is testable without spawning a process, and so a future Phase
 * can drive plan/task operations programmatically instead of shelling out to itself.
 */

export * from "./status.js"
export * from "./plan.js"
export * from "./store.js"
export * from "./trust.js"
export * from "./paths.js"
export * from "./runtime.js"
export * from "./doctor.js"
export * from "./evidence-export.js"
export * from "./resume.js"
export * from "./commands.js"
export { VERSION, BUILD, renderHelp, versionLine } from "./help.js"
export { main, type MainResult } from "./main.js"
