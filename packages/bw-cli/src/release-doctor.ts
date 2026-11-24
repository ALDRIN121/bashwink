/**
 * Release-build checks for `bashwink doctor`.
 *
 * These run the same validation a launch runs, so a green doctor means a launch will get past
 * its pre-flight, and a red one names the same cause the launch would. Nothing here prints a
 * credential: the provider check reports presence only.
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { summarize, type Check, type DoctorReport } from "./doctor.js"
import { validateAssets } from "./offline-vm.js"
import { paths } from "./paths.js"
import {
  STARTUP_FAILURE_LOG,
  builtInQualifiedHosts,
  describeMode,
  expectedAssetManifestDigest,
  judgeHost,
  readHostFacts,
  type ExecutionMode,
} from "./release.js"
import { configuredVmProvider } from "./vm-provider.js"

/**
 * Checks that describe host execution or point at development fixtures. In the isolated VM they
 * would be misleading: the runtime runs in the guest, and only the configured relay provider is
 * reachable, so the host's built-in model catalogue and environment credentials do not apply.
 */
const REMOVED_BY_RELEASE = new Set(["runtime", "execution-backend"])
const VM_ONLY_REMOVED = new Set(["providers", "credentials", "provider-auth", "model", "trust"])

function lastFailure(): Check | undefined {
  try {
    const file = path.join(paths().data, STARTUP_FAILURE_LOG)
    if (!existsSync(file)) return undefined
    const last = readFileSync(file, "utf8").trim().split("\n").at(-1)
    if (last === undefined || last === "") return undefined
    const record = JSON.parse(last) as { at?: string; code?: string; message?: string }
    return {
      id: "last-startup-failure",
      title: "Last startup failure",
      status: "warn",
      detail: `${record.at ?? "unknown time"}: ${record.code ?? "unknown"} — ${record.message ?? ""}`,
      fix: `full record: ${file}`,
    }
  } catch {
    return undefined
  }
}

export async function withReleaseChecks(
  base: DoctorReport,
  moduleDirectory: string,
  mode: ExecutionMode,
): Promise<DoctorReport> {
  const description = describeMode(mode)
  const checks: Check[] = base.checks.filter(
    (check) =>
      !REMOVED_BY_RELEASE.has(check.id) &&
      !(mode === "isolated-vm" && VM_ONLY_REMOVED.has(check.id)),
  )
  checks.unshift({
    id: "execution-mode",
    title: "Execution mode",
    status: mode === "isolated-vm" ? "ok" : "warn",
    detail: description.text,
  })

  const host = judgeHost(readHostFacts(), builtInQualifiedHosts())
  checks.push({
    id: "host-qualification",
    title: "Host",
    status: host.supported ? "ok" : "fail",
    detail: host.reason,
    ...(host.supported
      ? {}
      : { fix: "use a macOS Apple Silicon build listed as qualified in the release notes" }),
  })

  if (mode === "isolated-vm") {
    try {
      const assets = await validateAssets(moduleDirectory, {
        release: true,
        expectedManifest: expectedAssetManifestDigest(),
      })
      checks.push({
        id: "vm-assets",
        title: "VM assets",
        status: "ok",
        detail: `kernel, initramfs and VM owner match the pinned manifest (profile ${assets.profile.slice(0, 12)})`,
      })
    } catch (error) {
      checks.push({
        id: "vm-assets",
        title: "VM assets",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        fix: "reinstall from the release archive; a launch will refuse to start until this passes",
      })
    }
    try {
      const provider = configuredVmProvider(true)
      checks.push({
        id: "vm-provider",
        title: "Model provider",
        status: provider === undefined ? "fail" : "ok",
        detail:
          provider === undefined
            ? "no provider selected"
            : `${provider.provider}: ${provider.guest.defaultModel}, ${provider.maxRequests} requests per session, credential present`,
      })
    } catch (error) {
      checks.push({
        id: "vm-provider",
        title: "Model provider",
        status: "fail",
        detail: error instanceof Error ? error.message : String(error),
        fix: "bashwink auth add <id> --base-url <url> --env <VAR> --model <name>, export the variable, then bashwink model use <id>/<name>",
      })
    }
  }

  const failure = lastFailure()
  if (failure !== undefined) checks.push(failure)
  return summarize(checks)
}
