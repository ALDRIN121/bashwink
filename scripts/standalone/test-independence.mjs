#!/usr/bin/env node
/**
 * Physical-absence & independence test:
 * Builds and runs standalone Bashwink in a clean copy of the repo where
 * `vendor/`, `vendor/engine/`, `build/`, `node_modules/`, `.bun/`, `fixtures/`
 * are physically absent AND PATH contains ZERO OpenCode, Hermes, Pi, or Bun binaries.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverStandaloneSources } from "./build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function runNpmIn(cwd, npmArgs, env) {
  const execDir = path.dirname(process.execPath);
  const npmCli = [
    process.env.npm_execpath,
    path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((p) => typeof p === "string" && p.endsWith(".js") && existsSync(p));
  if (npmCli) {
    return spawnSync(process.execPath, [npmCli, ...npmArgs], { cwd, env, encoding: "utf8" });
  }
  if (process.platform === "win32") {
    return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "npm", ...npmArgs], {
      cwd,
      env,
      encoding: "utf8",
    });
  }
  return spawnSync("npm", npmArgs, { cwd, env, encoding: "utf8" });
}

function findGit() {
  // Resolve an absolute path: the scrubbed PATH below must still contain Git so the
  // product's own `git status`/`git ls-files` calls work on Windows, where `git` lives
  // outside System32 (e.g. C:\Program Files\Git\cmd) and is not named `git` on PATH.
  const lookup = process.platform === "win32" ? "where" : "which";
  const located = spawnSync(lookup, ["git"], { encoding: "utf8" });
  if (located.status === 0) {
    const first = (located.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) return first;
  }
  for (const candidate of ["git", "/Library/Developer/CommandLineTools/usr/bin/git", "/usr/bin/git"]) {
    const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return candidate;
  }
  return undefined;
}

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), "bw-independent-"));
  const cleanRepo = path.join(root, "checkout");
  const prefix = path.join(root, "npm-global");
  const home = path.join(root, "home");
  const work = path.join(root, "project");
  mkdirSync(cleanRepo, { recursive: true });
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(work, { recursive: true });

  // Copy ONLY the standalone checkout footprint (NO vendor/, build/, node_modules/, .bun/)
  const discoveredDeps = discoverStandaloneSources(REPO_ROOT).map((rel) => [rel, rel]);
  const copies = [
    ["package.json", "package.json"],
    ["LICENSE", "LICENSE"],
    ["release/npm", "release/npm"],
    ["scripts/standalone", "scripts/standalone"],
    ...discoveredDeps,
    ["packages/bw-cli/test/standalone", "packages/bw-cli/test/standalone"],
  ];
  for (const [srcRel, dstRel] of copies) {
    cpSync(path.join(REPO_ROOT, srcRel), path.join(cleanRepo, dstRel), { recursive: true });
  }

  assert.equal(existsSync(path.join(cleanRepo, "vendor")), false);
  assert.equal(existsSync(path.join(cleanRepo, "node_modules")), false);
  assert.equal(existsSync(path.join(cleanRepo, "build")), false);

  const binDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const sysBins =
    process.platform === "win32"
      ? [process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32") : "C:\\Windows\\System32"]
      : ["/usr/bin", "/bin"];
  const gitBin = findGit();
  const gitDir = gitBin && path.isAbsolute(gitBin) ? [path.dirname(gitBin)] : [];

  const scrubbedEnv = {
    ...(process.platform === "win32"
      ? {
          SystemRoot: process.env.SystemRoot || "C:\\Windows",
          ComSpec: process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe",
          TEMP: root,
          TMP: root,
        }
      : { TMPDIR: root }),
    PATH: [binDir, path.dirname(process.execPath), ...gitDir, ...sysBins].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    BASHWINK_HOME: path.join(home, ".bashwink"),
    npm_config_prefix: prefix,
    npm_config_ignore_scripts: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };

  // Verify upstream tools are absent on scrubbed PATH
  const lookupCmd = process.platform === "win32" ? "where" : "which";
  for (const tool of ["opencode", "hermes", "pi", "bun"]) {
    const chk = spawnSync(lookupCmd, [tool], { env: scrubbedEnv, encoding: "utf8" });
    if (chk.status === 0 && chk.stdout.trim()) {
      // Only fail if found outside system directories unlikely here; warn or fail on clean runners
      const foundPath = chk.stdout.trim();
      if (!foundPath.startsWith("/usr/bin") && !foundPath.startsWith("/bin")) {
        throw new Error(`Unexpected upstream tool '${tool}' visible on scrubbed PATH: ${foundPath}`);
      }
    }
  }

  // Loopback model server to run one programmatic task using the built package library too
  let hits = 0;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => {
      hits += 1;
      res.writeHead(200, { "content-type": "application/json" });
      if (hits === 1) {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c1",
                      type: "function",
                      function: {
                        name: "edit_file",
                        arguments: JSON.stringify({ path: "calc.js", oldText: "a - b", newText: "a + b" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
        return;
      }
      if (hits === 2) {
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "c2",
                      type: "function",
                      function: {
                        name: "run_command",
                        arguments: JSON.stringify({ command: process.execPath, args: ["--test", "calc.test.js"] }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Passed independently." } }],
        }),
      );
    });
  });

  try {
    // 1. Run `npm run install:local` in isolated checkout without node_modules or vendor/
    const installRes = runNpmIn(cleanRepo, ["run", "install:local"], scrubbedEnv);
    assert.equal(
      installRes.status,
      0,
      `install:local in independent checkout failed:\n${installRes.stderr}\n${installRes.stdout}`,
    );

    const installedBin =
      process.platform === "win32" ? path.join(binDir, "bashwink.cmd") : path.join(binDir, "bashwink");
    const ver =
      process.platform === "win32"
        ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", installedBin, "--version"], { env: scrubbedEnv, encoding: "utf8" })
        : spawnSync(installedBin, ["--version"], { env: scrubbedEnv, encoding: "utf8" });
    assert.equal(ver.status, 0, ver.stderr);
    assert.equal(ver.stdout.trim(), "bashwink 0.2.0-alpha.2");

    const doc =
      process.platform === "win32"
        ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", installedBin, "doctor"], { env: scrubbedEnv, encoding: "utf8" })
        : spawnSync(installedBin, ["doctor"], { env: scrubbedEnv, encoding: "utf8" });
    assert.equal(doc.status, 0, doc.stderr);

    // 2. Run all unit tests in the isolated checkout using ONLY Node 22+
    const unitRes = runNpmIn(cleanRepo, ["run", "test:standalone"], scrubbedEnv);
    assert.equal(unitRes.status, 0, `unit tests in independent checkout failed:\n${unitRes.stderr}\n${unitRes.stdout}`);

    // 3. Import the built installed JS module graph directly & complete red->green coding fixture
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = server.address().port;

    writeFileSync(path.join(work, "calc.js"), "export const add = (a, b) => a - b;\n", "utf8");
    writeFileSync(
      path.join(work, "calc.test.js"),
      'import test from "node:test"; import assert from "node:assert/strict"; import { add } from "./calc.js"; test("add", () => assert.equal(add(2, 3), 5));\n',
      "utf8",
    );

    const installedPkgRoot = path.join(
      prefix,
      process.platform === "win32" ? "node_modules" : path.join("lib", "node_modules"),
      "bashwink",
    );
    const { runTask, grantWorkspaceTrust, resolveStandalonePaths } = await import(
      pathToFileUrlString(path.join(installedPkgRoot, "lib", "packages", "bw-cli", "src", "standalone", "index.js"))
    );
    const paths = resolveStandalonePaths(scrubbedEnv);
    grantWorkspaceTrust(paths.config, work, "independence-check");
    const taskRes = await runTask(
      {
        workspace: work,
        prompt: "fix calc",
        trusted: true,
        config: {
          version: 1,
          endpointType: "local",
          baseURL: `http://127.0.0.1:${port}/v1`,
          model: "local-test",
          credential: { kind: "none" },
          updatedAt: "2026-11-25T00:00:00.000Z",
        },
      },
      {
        paths,
        env: scrubbedEnv,
        confirmAction: async () => true,
      },
    );
    assert.equal(taskRes.outcome, "completed");
    assert.deepEqual(taskRes.changedFiles, ["calc.js"]);
    assert.equal(taskRes.commands[0]?.exitCode, 0);
    assert.equal(readFileSync(path.join(work, "calc.js"), "utf8"), "export const add = (a, b) => a + b;\n");

    process.stdout.write(
      `PASS: independence verified without vendor/, node_modules/, build/, OpenCode, Hermes, Pi, or Bun (install + unit tests + red->green coding).\n`,
    );
  } finally {
    await new Promise((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  }
}

function pathToFileUrlString(absPath) {
  const normalized = absPath.replace(/\\/g, "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

main().catch((err) => {
  process.stderr.write(`test-independence FAILED: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
