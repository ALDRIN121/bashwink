#!/usr/bin/env node
"use strict";
/**
 * Bashwink launcher. npm installs this file as the `bashwink` command (and writes the .cmd / PowerShell
 * shims on Windows). It does four things and nothing else:
 *
 *   1. refuse platforms this alpha has not been qualified for, before running anything;
 *   2. find a locally built engine via `engine-manifest.json`, and hand its path to the runtime
 *      which verifies the digest before use (Task 4);
 *   3. otherwise find the pinned Bun and OpenCode binaries that npm installed as dependencies;
 *   4. run the bundled CLI under Bun with the OpenCode path passed explicitly.
 *
 * It never searches PATH for a runtime, so a different Bun or OpenCode on the machine is never used.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

/** The manifest a locally built engine installs beside this package. */
const ENGINE_MANIFEST = path.join(ROOT, "engine-manifest.json");

/** Platforms this package will try to run on. Windows ARM64 is deliberately absent: see KNOWN_LIMITATIONS. */
const SUPPORTED = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]);

function isMusl(report) {
  return report !== undefined && report.header !== undefined && !report.header.glibcVersionRuntime;
}

/**
 * Names of the platform packages npm installs for this OS and CPU.
 * Returns `{ bun, opencode, executable }` or an object with `unsupported` explaining why not.
 */
function resolvePlatform(platform, arch, musl) {
  const key = `${platform}-${arch}`;
  if (platform === "win32" && arch === "arm64") {
    return {
      unsupported:
        "Windows on ARM64 has not been qualified for this alpha, so Bashwink will not run there. " +
        "Windows x64 is the supported Windows target.",
    };
  }
  if (!SUPPORTED.has(key)) {
    return { unsupported: `this alpha supports macOS, Linux x64/arm64 and Windows x64 (found ${key}).` };
  }
  const os = platform === "win32" ? "windows" : platform;
  const bunArch = arch === "arm64" ? "aarch64" : "x64";
  const suffix = platform === "linux" && musl ? "-musl" : "";
  return {
    bun: `@oven/bun-${os}-${bunArch}${suffix}`,
    opencode: `@opencode/cli-${os}-${arch}${suffix}`,
    executable: platform === "win32" ? ".exe" : "",
  };
}

/** Directories that may hold node_modules for this package: its own, then every ancestor's. */
function searchRoots(start) {
  const roots = [];
  let current = start;
  for (let depth = 0; depth < 12; depth += 1) {
    roots.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function findBinary(packageName, name, executable, start = ROOT) {
  for (const base of searchRoots(start)) {
    const directory = path.join(base, ...packageName.split("/"));
    for (const candidate of [path.join(directory, "bin", name + executable), path.join(directory, "bin", name)]) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

function runtimePlan() {
  const report = process.report && typeof process.report.getReport === "function" ? process.report.getReport() : undefined;
  return resolvePlatform(process.platform, process.arch, isMusl(report));
}

/**
 * A locally built engine, described by the manifest beside this package.
 *
 * Returns the manifest path or a refusal. The launcher does not verify the digest itself — the
 * runtime does, so there is exactly one implementation of that check and no chance of the two
 * disagreeing. What the launcher must not do is paper over a bad manifest by finding some other
 * `opencode`, so a manifest that exists but does not parse is a hard stop here too.
 */
function localEngine() {
  if (!fs.existsSync(ENGINE_MANIFEST)) return { present: false };
  try {
    const manifest = JSON.parse(fs.readFileSync(ENGINE_MANIFEST, "utf8"));
    if (typeof manifest.target !== "string") {
      return { error: `${ENGINE_MANIFEST} has no target; the local engine build is incomplete.` };
    }
    return { present: true, path: ENGINE_MANIFEST, target: manifest.target };
  } catch (error) {
    return { error: `${ENGINE_MANIFEST} is not valid JSON: ${error.message}` };
  }
}

function main(argv) {
  const plan = runtimePlan();
  if (plan.unsupported) {
    process.stderr.write(`bashwink: ${plan.unsupported}\n`);
    return 1;
  }

  const local = localEngine();
  if (local.error) {
    process.stderr.write(`bashwink: ${local.error}\n`);
    return 1;
  }

  // With a local engine, Bun still comes from the installed package (the engine is the pinned
  // artifact under test, the JS runtime is not). No OpenCode platform package is consulted.
  if (local.present) {
    const bun = findBinary(plan.bun, "bun", plan.executable) || findBinary("bun", "bun", ".exe");
    if (!bun) {
      process.stderr.write(
        `bashwink: the pinned Bun runtime is missing (${plan.bun}).\n` +
          "  Reinstall Bashwink; the local engine is present but cannot be started without it.\n",
      );
      return 1;
    }
    return launch(bun, argv, {
      BASHWINK_ENGINE_MANIFEST: local.path,
      BASHWINK_ENGINE_TARGET: local.target,
    });
  }

  // npm's `bun` package moves the real binary from its platform package into its own bin/bun.exe (on every OS)
  // during install, so look in both places.
  const bun = findBinary(plan.bun, "bun", plan.executable) || findBinary("bun", "bun", ".exe");
  const opencode = findBinary(plan.opencode, "opencode", plan.executable);
  if (!bun || !opencode) {
    const missing = [!bun ? plan.bun : undefined, !opencode ? plan.opencode : undefined].filter(Boolean);
    process.stderr.write(
      `bashwink: a required runtime package is missing (${missing.join(", ")}).\n` +
        "  npm skips optional platform packages when installed with --no-optional or --omit=optional.\n" +
        "  Reinstall without that flag: npm install -g <the bashwink tarball>\n",
    );
    return 1;
  }
  return launch(bun, argv, { BASHWINK_OPENCODE_BIN: opencode });
}

function launch(bun, argv, extraEnv) {
  const entry = path.join(ROOT, "lib", "bashwink.js");
  const child = spawn(bun, [entry, ...argv], {
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  // The runtime owns the session and finalizes its run record on SIGINT/SIGTERM/SIGHUP. Forward those signals
  // instead of dying with the launcher, and exit with whatever the runtime exits with. (Ctrl+C in a terminal
  // reaches both processes; a signal sent to this process alone reaches the runtime only through this.)
  // On Windows `child.kill(signal)` terminates the child abruptly instead of delivering a signal, which would skip its
  // cleanup (finalizing the run record, stopping the private server). A console Ctrl+C or Ctrl+Break already reaches
  // every process in the console's group, so the launcher only has to stay alive until the child has finished.
  const windows = process.platform === "win32";
  for (const signal of windows ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      if (windows) return;
      try {
        child.kill(signal);
      } catch {
        // the child already exited
      }
    });
  }
  child.on("error", (error) => {
    process.stderr.write(`bashwink: could not start the runtime: ${error.message}\n`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(128 + (require("node:os").constants.signals[signal] || 1));
    process.exit(code === null ? 1 : code);
  });
  return undefined;
}

module.exports = { resolvePlatform, runtimePlan, searchRoots, findBinary, localEngine, SUPPORTED, ENGINE_MANIFEST };

if (require.main === module) {
  const code = main(process.argv.slice(2));
  if (code !== undefined) process.exit(code);
}
