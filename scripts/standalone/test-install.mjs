#!/usr/bin/env node
/**
 * Packaging, install, upgrade, corrupt-tarball recovery, and uninstall checks
 * against the real standalone tarball (`build/standalone/bashwink-0.2.0-alpha.1.tgz`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditStagedPackage, buildStandalone, runNpm } from "./build.mjs";

function cleanPath(extraBinDirs) {
  const sysBins =
    process.platform === "win32"
      ? [
          process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : "C:\\Windows\\System32",
          path.dirname(process.execPath),
        ]
      : [path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...extraBinDirs, ...sysBins].filter(Boolean).join(path.delimiter);
}

function installedBin(prefix) {
  return process.platform === "win32"
    ? path.join(prefix, "bashwink.cmd")
    : path.join(prefix, "bin", "bashwink");
}

function runInstalled(binPath, args, env, cwd) {
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", binPath, ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  }
  return spawnSync(binPath, args, { cwd, env, encoding: "utf8" });
}

function main() {
  const built = buildStandalone();
  assert.equal(built.version, "0.2.0-alpha.1");
  assert.ok(existsSync(built.tarballPath));

  // Verify SHA256SUMS file matches tarball
  const sums = readFileSync(path.join(path.dirname(built.tarballPath), "SHA256SUMS"), "utf8");
  assert.match(sums, new RegExp(`^${built.tarballSha256}\\s+${built.tarballName}$`, "m"));

  // Use a prefix directory whose path contains a space to verify quoting/resolution
  const root = mkdtempSync(path.join(tmpdir(), "bw install check "));
  const prefix = path.join(root, "global prefix");
  const home = path.join(root, "profile home");
  const workspace = path.join(root, "sample workspace");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const env = {
    ...(process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot || "C:\\Windows",
          ComSpec: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
          TEMP: root,
          TMP: root,
        }
      : { TMPDIR: root }),
    PATH: cleanPath([binDir]),
    HOME: home,
    USERPROFILE: home,
    BASHWINK_HOME: path.join(home, ".bashwink"),
    npm_config_prefix: prefix,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };

  try {
    // 1. Clean install from built tarball (with npm_config_ignore_scripts=true)
    const inst = runNpm(["install", "-g", built.tarballPath, "--ignore-scripts"], { env });
    assert.equal(inst.status, 0, `npm install -g failed:\n${inst.stderr}\n${inst.stdout}`);

    const bin = installedBin(prefix);
    assert.ok(existsSync(bin), `Expected installed shim at ${bin}`);
    const installedPkgRoot = path.join(
      prefix,
      process.platform === "win32" ? "node_modules" : path.join("lib", "node_modules"),
      "bashwink",
    );
    const manifest = JSON.parse(readFileSync(path.join(installedPkgRoot, "STANDALONE_MANIFEST.json"), "utf8"));
    assert.equal(manifest.nodeRequired, ">=22.13.0");
    const launcherSrc = readFileSync(path.join(installedPkgRoot, "bin", "bashwink.js"), "utf8");
    assert.match(launcherSrc, /minor < 13/);
    if (process.platform !== "win32") {
      assert.ok((statSync(bin).mode & 0o111) !== 0, "Installed bashwink shim should be executable");
    }

    // 2. Installed CLI diagnostics and fail-closed exits
    const ver = runInstalled(bin, ["--version"], env, workspace);
    assert.equal(ver.status, 0, ver.stderr);
    assert.equal(ver.stdout.trim(), "bashwink 0.2.0-alpha.1");

    const doc = runInstalled(bin, ["doctor"], env, workspace);
    assert.equal(doc.status, 0, `doctor failed:\n${doc.stderr}\n${doc.stdout}`);
    assert.match(doc.stdout, /Node\.js: v/);
    assert.match(doc.stdout, /Profile: not configured yet/);

    const nonTtyBare = runInstalled(bin, [], env, workspace);
    assert.equal(nonTtyBare.status, 0);
    assert.match(nonTtyBare.stdout, /no provider profile is configured/);

    const sandbox = runInstalled(bin, ["--sandbox"], env, workspace);
    assert.equal(sandbox.status, 3, "Expected --sandbox to fail closed with exit 3");

    for (const removedCmd of [["model", "list"], ["auth", "add"], ["attach"]]) {
      const r = runInstalled(bin, removedCmd, env, workspace);
      assert.equal(r.status, 2, `Expected '${removedCmd.join(" ")}' to exit 2, got ${r.status}`);
      assert.match(r.stderr, /No external runtime was invoked/);
    }

    // 3. Seed user profile + legacy files, then reinstall/upgrade and verify preservation
    const cfgDir = env.BASHWINK_HOME;
    const dataDir = path.join(env.BASHWINK_HOME, "data");
    mkdirSync(cfgDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    const legacyConfigFile = path.join(cfgDir, "opencode.json");
    const standaloneFile = path.join(cfgDir, "standalone.json");
    const sqliteFile = path.join(dataDir, "bashwink.sqlite");
    const legacyBody = '{"provider":{"openai":{"options":{"baseURL":"https://example.invalid/v1"}}}}\n';
    const standaloneBody =
      '{"version":1,"endpointType":"local","baseURL":"http://127.0.0.1:8080/v1","model":"m","credential":{"kind":"none"},"updatedAt":"2026-11-25T00:00:00.000Z"}\n';
    writeFileSync(legacyConfigFile, legacyBody, "utf8");
    writeFileSync(standaloneFile, standaloneBody, "utf8");
    writeFileSync(sqliteFile, "SQLite-stub-preserved", "utf8");

    const upgrade = runNpm(["install", "-g", built.tarballPath, "--ignore-scripts"], { env });
    assert.equal(upgrade.status, 0, `repeat install failed:\n${upgrade.stderr}`);
    assert.equal(readFileSync(legacyConfigFile, "utf8"), legacyBody);
    assert.equal(readFileSync(standaloneFile, "utf8"), standaloneBody);
    assert.equal(readFileSync(sqliteFile, "utf8"), "SQLite-stub-preserved");

    // 4. Failed / corrupt tarball install must NOT break existing installed CLI
    const badTarball = path.join(root, "corrupt.tgz");
    writeFileSync(badTarball, "not-a-valid-gzip-tarball", "utf8");
    const badInst = runNpm(["install", "-g", badTarball, "--ignore-scripts"], { env });
    assert.notEqual(badInst.status, 0, "Expected corrupt tarball install to fail");
    const postBadVer = runInstalled(bin, ["--version"], env, workspace);
    assert.equal(postBadVer.status, 0);
    assert.equal(postBadVer.stdout.trim(), "bashwink 0.2.0-alpha.1");

    // 5. Negative controls on staged package auditor
    const badPkgRoot = path.join(root, "bad-stage");
    mkdirSync(path.join(badPkgRoot, "bin"), { recursive: true });
    writeFileSync(
      path.join(badPkgRoot, "package.json"),
      JSON.stringify({ name: "bashwink", type: "module", version: "0.2.0-alpha.1", dependencies: { "@opencode/plugin": "2.3.2" } }),
    );
    assert.throws(() => auditStagedPackage(badPkgRoot), /zero runtime dependencies/);

    writeFileSync(
      path.join(badPkgRoot, "package.json"),
      JSON.stringify({ name: "bashwink", type: "module", version: "0.2.0-alpha.1", dependencies: {} }),
    );
    writeFileSync(path.join(badPkgRoot, "bin", "bashwink.js"), 'import { x } from "bun"; console.log(x);\n');
    assert.throws(() => auditStagedPackage(badPkgRoot), /Forbidden non-node external import 'bun'/);

    // 6. Uninstall removes global binary while preserving user profile and data
    const uninst = runNpm(["uninstall", "-g", "bashwink"], { env });
    assert.equal(uninst.status, 0, `npm uninstall -g failed:\n${uninst.stderr}`);
    assert.equal(existsSync(bin), false, "Installed bashwink command must be removed by npm uninstall -g bashwink");
    assert.equal(readFileSync(legacyConfigFile, "utf8"), legacyBody);
    assert.equal(readFileSync(standaloneFile, "utf8"), standaloneBody);
    assert.equal(readFileSync(sqliteFile, "utf8"), "SQLite-stub-preserved");

    process.stdout.write(
      `PASS: install lifecycle verified (${built.tarballName}, space-containing prefix, upgrade preserved profile, corrupt tarball safe, uninstall clean).\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main();
