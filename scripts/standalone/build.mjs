#!/usr/bin/env node
/**
 * Build, audit, pack, and optionally globally install standalone Bashwink (0.2.0-alpha.1).
 *
 * Uses only Node.js 22+ built-ins (`node:module` `stripTypeScriptTypes`) and `npm` —
 * zero Bun, Python, Rust, Zig, OpenCode, Hermes, Pi, or third-party build packages.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "release", "npm");
const OUT_ROOT = path.join(REPO_ROOT, "build", "standalone");
const STAGE_DIR = path.join(OUT_ROOT, "package");

const args = new Set(process.argv.slice(2));
const DO_INSTALL = args.has("--install");
const JSON_OUTPUT = args.has("--json");

export function runNpm(npmArgs, options = {}) {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((p) => typeof p === "string" && p.endsWith(".js") && existsSync(p));

  if (candidates.length > 0) {
    return spawnSync(process.execPath, [candidates[0], ...npmArgs], {
      encoding: "utf8",
      ...options,
    });
  }
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe";
    return spawnSync(comspec, ["/d", "/s", "/c", "npm", ...npmArgs], {
      encoding: "utf8",
      ...options,
    });
  }
  return spawnSync("npm", npmArgs, {
    encoding: "utf8",
    ...options,
  });
}

function checkPrerequisites() {
  const [majorRaw, minorRaw] = process.versions.node.split(".");
  const major = Number((majorRaw || "").trim());
  const minor = Number((minorRaw || "").trim());
  if (!Number.isFinite(major) || !Number.isFinite(minor) || major < 22 || (major === 22 && minor < 13)) {
    throw new Error(
      `Node.js >= 22.13.0 is required for module.stripTypeScriptTypes (found ${process.versions.node}). Install Node >=22.13.0 from https://nodejs.org/`,
    );
  }
  const npmCheck = runNpm(["--version"]);
  if (npmCheck.status !== 0) {
    throw new Error(
      `npm >= 10 is required and was not found (${npmCheck.stderr?.trim() || npmCheck.error?.message || "exit " + npmCheck.status}). Install Node.js 22+ (which bundles npm) from https://nodejs.org/`,
    );
  }
  return { node: process.version, npm: npmCheck.stdout.trim() };
}

export function discoverStandaloneSources(repoRoot = REPO_ROOT) {
  const standaloneDir = path.join(repoRoot, "packages", "bw-cli", "src", "standalone");
  const seeds = readdirSync(standaloneDir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => path.join("packages", "bw-cli", "src", "standalone", name));

  const packagesRoot = path.resolve(repoRoot, "packages");
  const visited = new Set();
  const queue = [];

  const enqueue = (relPath) => {
    const normalized = relPath.split(path.sep).join("/");
    if (visited.has(normalized)) return;
    visited.add(normalized);
    queue.push(normalized);
  };

  for (const s of seeds) enqueue(s);

  while (queue.length > 0) {
    const relTs = queue.shift();
    const absTs = path.join(repoRoot, relTs);
    if (!existsSync(absTs)) {
      throw new Error(`Missing standalone source dependency: ${relTs}`);
    }
    const rawTs = readFileSync(absTs, "utf8");
    const stripped = stripTypeScriptTypes(rawTs, {
      mode: "strip",
      sourceUrl: relTs,
    });
    for (const spec of extractModuleSpecifiers(stripped)) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      let resolved = path.resolve(path.dirname(absTs), spec);
      if (resolved.endsWith(".js") && !existsSync(resolved)) {
        const tsCandidate = resolved.slice(0, -3) + ".ts";
        if (existsSync(tsCandidate)) resolved = tsCandidate;
      }
      if (!existsSync(resolved)) {
        throw new Error(`Broken relative import '${spec}' in ${relTs} (expected ${resolved})`);
      }
      if (!resolved.startsWith(packagesRoot + path.sep)) {
        throw new Error(`Standalone dependency '${resolved}' escapes packages/`);
      }
      if (resolved.endsWith(".ts")) {
        enqueue(path.relative(repoRoot, resolved));
      }
    }
  }

  return [...visited].sort();
}

function sourceFiles() {
  return discoverStandaloneSources(REPO_ROOT);
}

function rewriteRelativeTsSpecifiers(jsCode) {
  return jsCode
    .replace(/(from\s*["'])(\.\.?\/[^"']+)\.ts(["'])/g, "$1$2.js$3")
    .replace(/(import\s*["'])(\.\.?\/[^"']+)\.ts(["'])/g, "$1$2.js$3")
    .replace(/(import\s*\(\s*["'])(\.\.?\/[^"']+)\.ts(["']\s*\))/g, "$1$2.js$3");
}

function walkFiles(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, rel));
    else if (entry.isFile()) out.push({ rel, full });
  }
  return out;
}

function extractModuleSpecifiers(jsSource) {
  const specs = [];
  const staticFromRe =
    /^[ \t]*(?:import|export)\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\}|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?)\s+from\s*["']([^"']+)["']/gm;
  const sideEffectImportRe = /^[ \t]*import\s+["']([^"']+)["']/gm;
  const dynamicRe = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticFromRe, sideEffectImportRe, dynamicRe]) {
    let m;
    while ((m = re.exec(jsSource)) !== null) {
      specs.push(m[1]);
    }
  }
  return specs;
}

export function auditStagedPackage(stageDir) {
  const pkgPath = path.join(stageDir, "package.json");
  const rawPkg = readFileSync(pkgPath, "utf8");
  if (rawPkg.includes("workspace:")) {
    throw new Error("Forbidden workspace: dependency protocol in package.json");
  }
  const pkg = JSON.parse(rawPkg);
  if (pkg.name !== "bashwink") throw new Error(`Unexpected package name: ${pkg.name}`);
  if (pkg.type !== "module") throw new Error(`Expected type: "module", got ${pkg.type}`);
  if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
    throw new Error(`Standalone package must have zero runtime dependencies; found ${JSON.stringify(pkg.dependencies)}`);
  }
  if (pkg.optionalDependencies || pkg.peerDependencies) {
    throw new Error("Standalone package must declare zero optionalDependencies or peerDependencies");
  }

  const files = walkFiles(stageDir);
  for (const { rel, full } of files) {
    if (rel.endsWith(".ts")) {
      throw new Error(`Uncompiled TypeScript file left in staged package: ${rel}`);
    }
    if (rel.startsWith("libexec/") || rel.startsWith("node_modules/")) {
      throw new Error(`Forbidden directory in standalone package: ${rel}`);
    }
    const content = readFileSync(full, "utf8");
    if (/\/Users\/(?!me\b)[A-Za-z0-9._-]+|\/home\/(?!user\b)[A-Za-z0-9._-]+|C:\\Users\\(?!me\b)/i.test(content)) {
      throw new Error(`Absolute user home path leaked into ${rel}`);
    }
    if (/sk-(?:ant|proj)-[A-Za-z0-9]{10,}/.test(content)) {
      throw new Error(`Potential API key literal leaked into ${rel}`);
    }
    if (rel.endsWith(".js")) {
      for (const spec of extractModuleSpecifiers(content)) {
        if (spec.startsWith("workspace:")) {
          throw new Error(`Forbidden workspace: specifier '${spec}' in ${rel}`);
        }
        if (spec.startsWith("node:")) continue;
        if (spec.startsWith("./") || spec.startsWith("../")) {
          const target = path.resolve(path.dirname(full), spec);
          if (!existsSync(target) || !statSync(target).isFile()) {
            throw new Error(`Broken relative import '${spec}' in ${rel} (expected ${target})`);
          }
          continue;
        }
        throw new Error(`Forbidden non-node external import '${spec}' in ${rel}`);
      }
    }
  }
  return { fileCount: files.length, version: pkg.version };
}

function readGitCommit() {
  for (const gitBin of ["git", "/Library/Developer/CommandLineTools/usr/bin/git"]) {
    const res = spawnSync(gitBin, ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" });
    if (res.status === 0 && res.stdout.trim()) return res.stdout.trim();
  }
  return "unknown";
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function buildStandalone() {
  const prereqs = checkPrerequisites();
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });

  // 1. Copy static package files
  const staticCopies = [
    ["package.json", "package.json"],
    ["README.md", "README.md"],
    ["THIRD_PARTY_NOTICES.txt", "THIRD_PARTY_NOTICES.txt"],
    [path.join("bin", "bashwink.js"), path.join("bin", "bashwink.js")],
    ["docs", "docs"],
    [path.join("licenses", "opencode.LICENSE"), path.join("licenses", "opencode.LICENSE")],
  ];
  for (const [fromRel, toRel] of staticCopies) {
    const src = path.join(TEMPLATE_DIR, fromRel);
    if (!existsSync(src)) throw new Error(`Missing template asset: ${src}`);
    const dst = path.join(STAGE_DIR, toRel);
    mkdirSync(path.dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
  cpSync(path.join(REPO_ROOT, "LICENSE"), path.join(STAGE_DIR, "LICENSE"));
  if (process.platform !== "win32") {
    chmodSync(path.join(STAGE_DIR, "bin", "bashwink.js"), 0o755);
  }

  // 2. Transpile pure-Node TypeScript graph using Node 22+ stripTypeScriptTypes
  const files = sourceFiles();
  for (const relTs of files) {
    const absTs = path.join(REPO_ROOT, relTs);
    const rawTs = readFileSync(absTs, "utf8");
    const stripped = stripTypeScriptTypes(rawTs, {
      mode: "strip",
      sourceUrl: relTs.split(path.sep).join("/"),
    });
    const jsOut = rewriteRelativeTsSpecifiers(stripped);
    const relJs = relTs.replace(/\.ts$/, ".js");
    const absOut = path.join(STAGE_DIR, "lib", relJs);
    mkdirSync(path.dirname(absOut), { recursive: true });
    writeFileSync(absOut, jsOut, "utf8");
  }

  // 3. Audit staged files before manifest + pack
  const audit = auditStagedPackage(STAGE_DIR);

  // 4. Write build manifest
  const stagedFiles = walkFiles(STAGE_DIR).map(({ rel, full }) => ({
    path: rel,
    bytes: statSync(full).size,
    sha256: sha256File(full),
  }));
  const manifest = {
    name: "bashwink",
    version: audit.version,
    standalone: true,
    nodeRequired: ">=22.13.0",
    builtWithNode: prereqs.node,
    builtWithNpm: prereqs.npm,
    sourceGitCommit: readGitCommit(),
    upstreamPorts: [
      {
        project: "OpenCode",
        revision: "c0ad18b402eb2827fc1ee71c171b1177b3fc02d1",
        license: "MIT",
        scope: "pendingCalls & stepMessages helpers in packages/bw-cli/src/standalone/task-loop.ts",
      },
      {
        project: "Pi (@mariozechner/pi-coding-agent)",
        revision: "b882d08",
        license: "MIT",
        scope: "length-truncation rejection and CRLF-preserving edit pattern in task-loop.ts / tools.ts",
      },
    ],
    files: stagedFiles,
  };
  writeFileSync(
    path.join(STAGE_DIR, "STANDALONE_MANIFEST.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  // 5. Pack with npm pack --ignore-scripts
  const tarballName = `bashwink-${audit.version}.tgz`;
  const tarballPath = path.join(OUT_ROOT, tarballName);
  rmSync(tarballPath, { force: true });
  const packRes = runNpm(["pack", "--ignore-scripts", "--pack-destination", OUT_ROOT], {
    cwd: STAGE_DIR,
  });
  if (packRes.status !== 0 || !existsSync(tarballPath)) {
    throw new Error(`npm pack failed (status ${packRes.status}): ${packRes.stderr || packRes.stdout}`);
  }

  // 6. Verify tarball entries
  const tarList = spawnSync("tar", ["-tzf", tarballPath], { encoding: "utf8" });
  if (tarList.status === 0) {
    const entries = tarList.stdout.split(/\r?\n/).filter(Boolean);
    const bad = entries.filter(
      (e) => e.endsWith(".ts") || e.includes("node_modules/") || e.includes("libexec/"),
    );
    if (bad.length > 0) {
      throw new Error(`Unexpected tarball entries found: ${bad.join(", ")}`);
    }
    if (!entries.includes("package/bin/bashwink.js") || !entries.includes("package/package.json")) {
      throw new Error("Tarball is missing required package/bin/bashwink.js or package/package.json");
    }
  }

  const tarballSha256 = sha256File(tarballPath);
  writeFileSync(path.join(OUT_ROOT, "SHA256SUMS"), `${tarballSha256}  ${tarballName}\n`, "utf8");

  return {
    prereqs,
    version: audit.version,
    compiledFiles: files.length,
    stagedFileCount: stagedFiles.length + 1,
    tarballPath,
    tarballName,
    tarballSha256,
  };
}

function installTarball(tarballPath) {
  const installRes = runNpm(["install", "-g", tarballPath, "--no-audit", "--no-fund"]);
  if (installRes.status !== 0) {
    throw new Error(
      `npm install -g ${tarballPath} failed (exit ${installRes.status}):\n${installRes.stderr || installRes.stdout}`,
    );
  }
  const prefixRes = runNpm(["prefix", "-g"]);
  if (prefixRes.status !== 0) {
    throw new Error(`npm prefix -g failed: ${prefixRes.stderr}`);
  }
  const prefix = prefixRes.stdout.trim();
  const globalBinDir = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const binName = process.platform === "win32" ? "bashwink.cmd" : "bashwink";
  const binPath = path.join(globalBinDir, binName);

  const verRes =
    process.platform === "win32"
      ? spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", binPath, "--version"], { encoding: "utf8" })
      : spawnSync(binPath, ["--version"], { encoding: "utf8" });

  if (verRes.status !== 0 || !verRes.stdout.includes("bashwink ")) {
    throw new Error(
      `Installed binary verification failed for ${binPath} (exit ${verRes.status}): ${verRes.stderr || verRes.stdout}`,
    );
  }

  const pathEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const onPath = pathEntries.some((p) => path.resolve(p) === path.resolve(globalBinDir));
  return { prefix, globalBinDir, binPath, onPath, versionOutput: verRes.stdout.trim() };
}

if (path.resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    const built = buildStandalone();
    const installed = DO_INSTALL ? installTarball(built.tarballPath) : undefined;
    if (JSON_OUTPUT) {
      process.stdout.write(`${JSON.stringify({ built, installed }, null, 2)}\n`);
    } else {
      process.stdout.write(
        `Built standalone package: ${built.tarballPath}\n` +
          `  sha256: ${built.tarballSha256}\n` +
          `  files:  ${built.compiledFiles} TS sources compiled with Node ${built.prereqs.node} (0 runtime dependencies)\n`,
      );
      if (installed) {
        process.stdout.write(
          `Installed globally: ${installed.binPath} (${installed.versionOutput})\n`,
        );
        if (!installed.onPath) {
          process.stdout.write(
            `\nNOTE: ${installed.globalBinDir} is not on your current PATH.\n` +
              (process.platform === "win32"
                ? `  PowerShell: $env:Path = "${installed.globalBinDir};" + $env:Path\n`
                : `  Shell:      export PATH="${installed.globalBinDir}:$PATH"\n`),
          );
        }
        process.stdout.write(
          "\nNext steps:\n" +
            "  cd /path/to/your/project\n" +
            "  bashwink\n" +
            "Uninstall later:\n" +
            "  npm uninstall -g bashwink\n",
        );
      }
    }
  } catch (err) {
    process.stderr.write(`build-standalone error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
