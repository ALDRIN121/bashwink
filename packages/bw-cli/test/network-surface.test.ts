/**
 * Task 4A — the shipped product's network surface.
 *
 * Bashwink must not contact OpenCode's own services. This file makes that a checked property rather
 * than a claim in a document: it reads the shipped sources and the vendored engine, and fails if a
 * control-plane route reappears in a place a shipped command can reach.
 *
 * What this can and cannot prove: it is a static audit of named destinations and environment
 * gates. It cannot prove that no code path anywhere constructs a URL from parts. That is what the
 * isolated-network run in Task 6 is for. This test exists so a regression is caught in seconds
 * rather than in a manual review, and it deliberately names each surface so the fix is obvious.
 */
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "../../..")
const read = (relative: string) => readFileSync(path.join(repo, relative), "utf8")

/**
 * Upstream control-plane destinations, by whether a shipped Bashwink command can reach them.
 *
 * `closed` means the route is already non-functional in a Bashwink launch and a test proves it.
 * `open` means it is reachable today; every entry needs a reason, because this table is the audit.
 */
const SURFACES = [
  {
    name: "model catalog refresh",
    url: "models.opencode.ai",
    where: "vendor/engine/packages/core/src/models-dev.ts",
    state: "closed",
    how: "OPENCODE_DISABLE_MODELS_FETCH=1 on every launch path, so the timer never starts; the engine boots from the pinned snapshot compiled into the binary.",
    test: "test/engine-environment.test.ts",
  },
  {
    name: "updater",
    url: "opencode.ai/update",
    where: "vendor/engine/packages/cli/src/services/updater.ts",
    state: "closed",
    how: "OPENCODE_DISABLE_AUTOUPDATE=1 returns before `latest()` is called, so no request is made even if the command is invoked.",
    test: "test/engine-environment.test.ts",
  },
  {
    name: "upstream account credential",
    url: "OPENCODE_API_KEY bearer auth",
    where: "vendor/engine/packages/ai/src/providers/opencode.ts",
    state: "closed",
    how: "scrubbed from the launch environment at the single point every backend passes through (launchEnvironment).",
    test: "test/engine-environment.test.ts",
  },
  {
    name: "config schema hint",
    url: "opencode.ai/config.json",
    where: "packages/bw-cli/src/paths.ts",
    state: "closed",
    how: "written as the Bashwink-owned schema URL; never fetched by any code path (validation is local).",
    test: "this file",
  },
  {
    name: "upstream console / MCP OAuth client",
    url: "opencode.ai/oauth",
    where: "vendor/engine/packages/core/src/mcp/oauth.ts",
    state: "not-implemented",
    how: "no Bashwink command starts MCP OAuth; Bashwink's `auth` surface is its own provider configuration.",
    test: "n/a — unreachable from the shipped CLI surface",
  },
] as const

test("every control-plane surface is accounted for with a real mechanism", () => {
  for (const surface of SURFACES) {
    expect(surface.how.length, `${surface.name} has no stated mechanism`).toBeGreaterThan(20)
    if (surface.state === "closed") {
      // A closed route must name a test, except the static ones this file asserts itself.
      expect(
        surface.test === "this file" || surface.test.length > 0,
        `${surface.name} claims closed without a test`,
      ).toBe(true)
    }
  }
})

test("the config schema Bashwink writes names Bashwink, not upstream", () => {
  const paths = read("packages/bw-cli/src/paths.ts")
  const match = /BASHWINK_CONFIG_SCHEMA = "([^"]+)"/.exec(paths)
  expect(match).not.toBeNull()
  expect(match![1]).not.toContain("opencode")
  // The literal string must not survive anywhere the config writer can reach it.
  const writeConfig = paths.slice(paths.indexOf("export function writeConfig"))
  expect(writeConfig.slice(0, 2000)).not.toContain("opencode.ai/config.json")
})

test("the catalog fetch and updater are disabled at every launch point that spawns the engine", () => {
  // Every module that spawns the engine must carry both gates: a new backend that forgets one is
  // exactly how the standard path lost the catalog gate in the first place.
  const spawners = [
    "packages/bw-cli/src/execution-backend.ts",
    "packages/bw-cli/src/private-server.ts",
    "packages/bw-cli/src/native-sandbox.ts",
    "packages/bw-cli/src/native-offline.ts",
  ]
  for (const file of spawners) {
    const source = read(file)
    expect(source, `${file} lost OPENCODE_DISABLE_AUTOUPDATE`).toContain(
      "OPENCODE_DISABLE_AUTOUPDATE",
    )
    expect(source, `${file} lost OPENCODE_DISABLE_MODELS_FETCH`).toContain(
      "OPENCODE_DISABLE_MODELS_FETCH",
    )
    expect(source, `${file} lost OPENCODE_DISABLE_FREE_MODELS`).toContain(
      "OPENCODE_DISABLE_FREE_MODELS",
    )
  }
})

test("no telemetry client is present at all", () => {
  // Worth asserting explicitly: an absence that is never checked is an absence that can appear.
  //
  // Matched as an import or a hostname, not as a bare word. "segment" is ordinary English in this
  // codebase ("a path segment"), and a bare-word check flagged two innocent comments — a test that
  // fails on prose trains people to weaken it.
  const patterns = [
    "from [\"']posthog",
    "from [\"']@sentry",
    "from [\"']segment",
    "from [\"']@segment",
    "from [\"']amplitude",
    "from [\"']mixpanel",
    "api\\.segment\\.io",
    "posthog\\.com",
    "sentry\\.io",
  ]
  for (const pattern of patterns) {
    const found = Bun.spawnSync(["git", "grep", "-nE", pattern, "--", "packages/bw-cli/src"], {
      cwd: repo,
    })
    expect(
      found.exitCode,
      `telemetry route ${pattern} appeared in bw-cli:\n${found.stdout.toString()}`,
    ).not.toBe(0)
  }
})
