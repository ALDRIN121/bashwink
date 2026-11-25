#!/usr/bin/env python3
"""Build the private npm tarball of Bashwink's standard (native) mode.

    python3 scripts/build_npm_package.py --out build/npm [--allow-dirty]
    python3 scripts/build_npm_package.py --install [--out new/output/directory]

Use --install to install the project's frozen dependencies, build the package, and
install Bashwink globally with npm. If the pinned Bun version is unavailable,
--install offers to install a temporary build copy. The default output is a
fresh temporary directory.

Produces, in the output directory:
    bashwink-<version>.tgz     what `npm install -g ./bashwink-<version>.tgz` installs
    SHA256SUMS
    RELEASE_MANIFEST.json      version, commit, checksums, sizes, dependency pins, audit results

Nothing is published. `npm publish` is blocked by a prepublishOnly guard in the package.

The tarball contains only Bashwink's own files: a Node launcher, the bundled CLI (Bun target, built with
`__BASHWINK_STANDARD__`), the evidence plugin and documents. The Bun and OpenCode runtimes are exact-pinned
public npm dependencies (`bun`, `@opencode/cli`) that npm installs for the user's platform. The VM guest
image and the sandbox backend are NOT included.
"""
from __future__ import annotations

import argparse
import hashlib
import platform
import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from contextlib import ExitStack
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "release/npm"
BUN_VERSION = "1.4.4"
# On Windows npm is `npm.cmd`, which a bare "npm" does not find without a shell.
NPM = shutil.which("npm") or "npm"


def run(command, **kwargs):
    return subprocess.run([str(c) for c in command], check=True, text=True, **kwargs)


def capture(command, **kwargs):
    return subprocess.check_output([str(c) for c in command], text=True, **kwargs).strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def node_version() -> tuple[int, ...] | None:
    node = shutil.which("node")
    if not node:
        return None
    try:
        raw = capture([node, "--version"]).lstrip("v")
        return tuple(int(part) for part in raw.split(".")[:3])
    except (OSError, subprocess.CalledProcessError, ValueError):
        return None


def check_base_prerequisites() -> None:
    if sys.version_info < (3, 12):
        raise SystemExit(
            f"Python 3.12+ is required (found {sys.version_info.major}.{sys.version_info.minor}). "
            "Install Python 3.12 or newer and retry."
        )
    if not shutil.which("git"):
        raise SystemExit(
            "Git is required to prepare native build inputs and record commit provenance, but `git` was not found on PATH.\n"
            "Install Git: macOS (`xcode-select --install`), Linux (`apt/dnf install git`), Windows (`winget install Git.Git`)."
        )
    ver = node_version()
    if ver is None or ver[0] < 22:
        found = ".".join(str(x) for x in ver) if ver else "not installed"
        raise SystemExit(
            f"Node.js 22+ is required (found {found}). Install Node.js 22 LTS or newer "
            "(https://nodejs.org) so `node` and `npm` are on PATH, then retry."
        )
    if not shutil.which("npm"):
        raise SystemExit(
            "npm was not found on PATH. Install Node.js 22 LTS or newer (which includes npm) and retry."
        )


def _is_musl_linux() -> bool:
    if sys.platform != "linux":
        return False
    node = shutil.which("node")
    if node:
        try:
            out = capture([
                node,
                "-p",
                "String(Boolean(process.report && process.report.getReport().header && !process.report.getReport().header.glibcVersionRuntime))",
            ])
            if out == "true":
                return True
            if out == "false":
                return False
        except (OSError, subprocess.CalledProcessError):
            pass
    return Path("/etc/alpine-release").exists()


def platform_arch() -> str:
    """The manifest target key for this host, spelled the way build_local_engine.py writes it."""
    machine = platform.machine().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(machine, machine)
    os_name = {"darwin": "darwin", "linux": "linux", "win32": "win32"}.get(sys.platform, sys.platform)
    if os_name == "linux" and _is_musl_linux():
        return f"{os_name}-{arch}-musl"
    return f"{os_name}-{arch}"


def validate_engine_input(engine_dir: Path, target: str) -> dict:
    """Verify an engine artifact directory before it goes into the tarball.

    The packager must not be a way to ship an unverified binary. Everything here is checked against
    the manifest the build itself wrote, and every failure names the specific fault rather than
    "invalid engine".
    """
    manifest_path = engine_dir / "engine-manifest.json"
    if not manifest_path.is_file():
        raise SystemExit(
            f"engine input {engine_dir} has no engine-manifest.json. Build it first: "
            f"python3 scripts/build_local_engine.py --target {target}"
        )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    if manifest.get("schemaVersion") != 1:
        raise SystemExit(f"engine manifest schema {manifest.get('schemaVersion')} is not supported (expected 1)")
    if manifest.get("target") != target:
        raise SystemExit(
            f"engine input is built for '{manifest.get('target')}', not '{target}'. A tarball may only "
            "contain an engine for the platform it targets."
        )

    engine = manifest.get("engine") or {}
    declared = engine.get("sha256")
    if not declared:
        raise SystemExit("engine manifest has no sha256; an unverifiable artifact cannot be packaged")
    artifact = engine_dir / (engine.get("path") or "")
    if not artifact.is_file():
        raise SystemExit(f"engine manifest names '{engine.get('path')}', which does not exist under {engine_dir}")
    actual = sha256(artifact)
    if actual != declared:
        raise SystemExit(
            f"engine digest mismatch: manifest says {declared}, artifact is {actual}. "
            "The artifact was modified after the build; rebuild rather than packaging it."
        )
    if engine.get("ffmpegMarkers"):
        raise SystemExit(
            f"engine contains FFmpeg markers {engine['ffmpegMarkers']}; this build must ship the no-FFmpeg "
            "OpenTUI library."
        )
    return {"manifest": manifest, "artifact": artifact, "sha256": actual, "target": target}


def stage_package(stage: Path, commit: str, bun: str, engine_dir: Path | None = None, target: str | None = None) -> dict:
    manifest = json.loads((TEMPLATE / "package.json").read_text())
    cli_version = json.loads((ROOT / "packages/bw-cli/package.json").read_text())["version"]
    if manifest["version"] != cli_version:
        raise SystemExit(f"package version {manifest['version']} does not match the CLI version {cli_version}")
    for kind in ("dependencies", "optionalDependencies", "devDependencies", "peerDependencies"):
        for name, spec in manifest.get(kind, {}).items():
            if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", spec):
                raise SystemExit(f"{name}@{spec} is not an exact pin")
            if spec.startswith("workspace:") or "file:" in spec:
                raise SystemExit(f"{name}: unresolved local dependency {spec}")
    (stage / "bin").mkdir(parents=True)
    shutil.copyfile(TEMPLATE / "bin/bashwink.js", stage / "bin/bashwink.js")
    (stage / "bin/bashwink.js").chmod(0o755)
    shutil.copyfile(TEMPLATE / "package.json", stage / "package.json")
    shutil.copyfile(ROOT / "LICENSE", stage / "LICENSE")
    readme = TEMPLATE / "README.md"
    shutil.copyfile(readme if readme.exists() else ROOT / "README.md", stage / "README.md")

    lib = stage / "lib"
    lib.mkdir()
    run([bun, "build", ROOT / "packages/bw-cli/src/bin.ts", "--target=bun", "--define", "__BASHWINK_STANDARD__=true",
         "--outfile", lib / "bashwink.js"], stdout=subprocess.DEVNULL)
    (lib / "version.json").write_text(json.dumps({"version": cli_version, "build": commit[:12], "flavor": "standard"}) + "\n")
    # The evidence plugin ships as source (OpenCode loads it from a directory). Its SDK import is provided by the
    # runtime that loads it, so no nested node_modules is shipped (npm would not pack one anyway).
    shutil.copytree(ROOT / "packages/bw-evidence", lib / "evidence",
                    ignore=shutil.ignore_patterns("node_modules", "test", ".turbo", "tsconfig.json"))
    docs = TEMPLATE / "docs"
    if docs.is_dir():
        shutil.copytree(docs, stage / "share/doc")
    # The local engine, when one was supplied. It is placed beside the manifest so the launcher and
    # the runtime resolve it relative to the package root, and it replaces the registry
    # @opencode/cli dependency entirely.
    if engine_dir is not None:
        engine = validate_engine_input(engine_dir, target or "")
        libexec = stage / "libexec"
        libexec.mkdir()
        shutil.copyfile(engine["artifact"], libexec / engine["artifact"].name)
        (libexec / engine["artifact"].name).chmod(0o755)
        packaged = dict(engine["manifest"])
        packaged["engine"] = dict(packaged["engine"], path=f"libexec/{engine['artifact'].name}")
        # A shipped manifest describes an artifact. Build logs, the argv that produced it, and the
        # builder's tool paths do not belong in a package: they leak the build machine and are not
        # reproducibility facts for the person installing it. Stripped here rather than trusted to
        # the builder, because an older artifact may predate the builder's own hygiene.
        for key in ("buildResult", "buildCommand", "toolchains"):
            packaged.pop(key, None)
        (stage / "engine-manifest.json").write_text(json.dumps(packaged, indent=2) + "\n", encoding="utf-8")

    notices = TEMPLATE / "THIRD_PARTY_NOTICES.txt"
    (stage / "share/licenses").mkdir(parents=True)
    (stage / "share/licenses/THIRD_PARTY_NOTICES.txt").write_text(notice_text(notices.read_text(encoding="utf-8"), bundled_packages(lib / "bashwink.js")), encoding="utf-8")
    return manifest


# The third-party packages that `bun build` may compile into lib/bashwink.js, and the licence text each one needs.
# A bundled package that is not listed here fails the build: shipping a copy without its notice is the defect this prevents.
BUNDLED_NOTICES = {
    "effect": ("MIT", "effect.LICENSE", "https://github.com/Effect-TS/effect (LICENSE file shipped in the effect package)"),
    "@opencode/schema": ("MIT", "opencode.LICENSE", "https://github.com/anomalyco/opencode (LICENSE at the repository root; the package ships none)"),
    "@opencode/plugin": ("MIT", "opencode.LICENSE", "https://github.com/anomalyco/opencode (LICENSE at the repository root; the package ships none)"),
}


def bundled_packages(bundle: Path) -> dict[str, str]:
    """name -> version for every package under node_modules that the bundle contains (from Bun's `// node_modules/.bun/...` markers)."""
    found: dict[str, str] = {}
    for line in bundle.read_text(encoding="utf-8").splitlines():
        match = re.match(r"// node_modules/\.bun/((?:@[^+/]+\+)?[^@/+]+)@(\d+\.\d+\.\d+[^/+]*)", line)
        if match:
            found[match.group(1).replace("+", "/")] = match.group(2)
    return found


def notice_text(base: str, bundled: dict[str, str]) -> str:
    unknown = sorted(name for name in bundled if name not in BUNDLED_NOTICES)
    if unknown:
        raise SystemExit(f"the bundle contains third-party packages with no recorded licence notice: {unknown}; add them to BUNDLED_NOTICES with their licence text")
    parts = [base.rstrip("\n"), "", "=" * 78, "BUNDLED CODE (compiled into lib/bashwink.js)", "=" * 78, ""]
    for name, version in sorted(bundled.items()):
        licence, _file, source = BUNDLED_NOTICES[name]
        parts.append(f"  {name} {version}   {licence}   {source}")
    for file in sorted({BUNDLED_NOTICES[name][1] for name in bundled}):
        users = ", ".join(sorted(name for name in bundled if BUNDLED_NOTICES[name][1] == file))
        parts += ["", "-" * 78, f"Licence text for: {users}", "-" * 78, (TEMPLATE / "licenses" / file).read_text(encoding="utf-8").rstrip("\n")]
    return "\n".join(parts) + "\n"


def audit(tarball: Path) -> dict:
    """Review the packed contents. Anything suspicious is a build failure, not a warning."""
    problems, names = [], []
    with tarfile.open(tarball) as archive:
        for member in archive.getmembers():
            names.append(member.name)
            if not member.isfile():
                continue
            data = archive.extractfile(member).read()
            text = data.decode("utf-8", errors="ignore")
            if re.search(r"workspace:", text) and member.name.endswith("package.json"):
                problems.append(f"{member.name}: unresolved workspace dependency")

            # A compiled Bun binary embeds the build machine's module paths and Rust crate paths as
            # `__dirname` literals. That is inherent to `bun build --compile`, not a packaging
            # mistake: the published v0.1.0-alpha.1 engine contains /Users/runner/ 257 times. So the
            # path rules apply to TEXT files, where a stray /Users/<name>/ is a real leak, and not to
            # the engine artifact, where it would fail every correct build.
            binary = b"\x00" in data[:8192]
            if not binary:
                for pattern in (r"/Users/[A-Za-z0-9._-]+/", r"[A-Z]:\\Users\\[A-Za-z0-9._-]+\\", r"/home/[a-z][a-z0-9_-]+/"):
                    found = re.search(pattern, text)
                    if found:
                        problems.append(f"{member.name}: development-machine path {found.group(0)!r}")

            # `\bsk-` rather than a bare `sk-`: the loose form matched the concatenated HTML link
            # relations "mask-icon" + "shortcut icon" inside every Bun-compiled binary, which is not
            # a credential and buried the check in noise. Word boundaries keep it meaningful for a
            # real key while dropping that class of false positive.
            if re.search(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}|(?<![A-Za-z0-9])ghp_[A-Za-z0-9]{20,}|(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]{0,20}?[A-Za-z0-9+/]{40,}", text):
                problems.append(f"{member.name}: credential-shaped string")
    for name in names:
        if re.search(r"(^|/)(\.git|\.env|node_modules|__pycache__|test|tests)(/|$)", name) or name.endswith((".sqlite", ".db", ".log")):
            problems.append(f"{name}: file that must not be packed")
    if problems:
        raise SystemExit("package audit failed:\n  " + "\n  ".join(problems))
    return {"files": len(names), "names": sorted(names)}


def bun_version(bun: str | None) -> str | None:
    if bun is not None:
        try:
            return capture([bun, "--version"])
        except (OSError, subprocess.CalledProcessError):
            pass
    return None


def build_runtime_plan() -> dict[str, str]:
    try:
        plan = json.loads(capture([
            "node", "-p", "JSON.stringify(require(process.argv[1]).runtimePlan())", TEMPLATE / "bin/bashwink.js",
        ]))
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        raise SystemExit("Could not detect the build platform. Check that Node.js 22 runs with node --version.") from None
    if "unsupported" in plan:
        raise SystemExit(plan["unsupported"])
    return plan


def resolve_bun(override: str | None, offer_install: bool, resources: ExitStack) -> str:
    bun = override or shutil.which("bun")
    version = bun_version(bun)
    if bun is not None and version == BUN_VERSION:
        return bun

    found = f" (found {version})" if version else ""
    required = f"Bun {BUN_VERSION} is required for building{found}."
    if override is not None or not offer_install:
        raise SystemExit(required)
    try:
        answer = input(f"{required} Install a temporary copy using npm? [y/N] ")
    except EOFError:
        answer = ""
    if answer.strip().lower() not in ("y", "yes"):
        raise SystemExit(f"Setup stopped. Install Bun {BUN_VERSION} and retry, or answer yes to use a temporary copy.")

    npm_missing = "npm was not found. Install Node.js 22 with npm, reopen your terminal, and retry."
    if shutil.which(NPM) is None:
        raise SystemExit(npm_missing)
    plan = build_runtime_plan()
    package = plan["bun"]
    tools = Path(resources.enter_context(tempfile.TemporaryDirectory(prefix="bashwink-build-tools-")))
    try:
        # The generic bun package needs a postinstall to replace its placeholder executable.
        run([NPM, "install", "--prefix", tools, "--no-save", "--ignore-scripts", f"{package}@{BUN_VERSION}"],
            cwd=tools)
    except FileNotFoundError:
        raise SystemExit(npm_missing) from None
    except subprocess.CalledProcessError as error:
        raise SystemExit(
            f"npm could not install Bun {BUN_VERSION} (exit {error.returncode}). See the npm error above."
        ) from None
    except OSError as error:
        raise SystemExit(f"Could not start npm: {error}") from None
    bun = str(tools / "node_modules" / package / "bin" / f"bun{plan['executable']}")
    if bun_version(bun) != BUN_VERSION:
        raise SystemExit(f"The Bun {BUN_VERSION} binary from {package} could not run on this machine.")
    return bun


DEFAULT_ENGINE_DIR = ROOT / "build" / "local-engine"


def engine_is_current(engine_dir: Path, target: str) -> tuple[bool, str]:
    """Whether an existing artifact dir is usable as-is, and why not when it is not.

    "Reuse a verified local engine" must mean verified *now*, not verified once: a stale artifact, an
    artifact for another target, or one whose binary changed after the build are all rejections.
    """
    manifest_path = engine_dir / "engine-manifest.json"
    if not manifest_path.is_file():
        return False, "no engine-manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        return False, f"unreadable manifest ({error})"
    if manifest.get("target") != target:
        return False, f"built for {manifest.get('target')!r}, need {target!r}"
    declared = (manifest.get("engine") or {}).get("sha256")
    if not declared:
        return False, "manifest carries no digest"
    artifact = engine_dir / ((manifest.get("engine") or {}).get("path") or "")
    if not artifact.is_file():
        return False, f"artifact {manifest['engine'].get('path')!r} is missing"
    if sha256(artifact) != declared:
        return False, "artifact digest does not match the manifest"
    return True, "verified"


def resolve_engine_input(explicit: Path | None, target: str, allow_build: bool, bun: str | None = None) -> Path:
    """Return a verified engine directory, building one only when allowed and needed.

    Fails before any packaging or installation work happens. A source install that cannot get an
    engine must stop here, leaving the previously installed CLI untouched, rather than install a
    package that cannot start.
    """
    candidates: list[Path] = []
    if explicit is not None:
        candidates.append(explicit)
    # Both spellings: a caller may point at the per-target directory itself, or at the output root
    # the builder writes (`build/local-engine`, which nests one level per target).
    candidates.extend([DEFAULT_ENGINE_DIR / target, DEFAULT_ENGINE_DIR])

    reasons: list[str] = []
    for candidate in candidates:
        if explicit is not None and candidate != explicit:
            continue
        ok, why = engine_is_current(candidate, target)
        if ok:
            print(f"engine   reusing verified artifact at {candidate} ({target})", flush=True)
            return candidate
        reasons.append(f"  {candidate}: {why}")

    if explicit is not None or not allow_build:
        raise SystemExit(
            "no usable local engine for "
            f"{target}. Refusing to package an install that cannot start:\n" + "\n".join(reasons) +
            f"\nBuild one first:\n  python3 scripts/build_local_engine.py --target {target}"
        )

    print("engine   no current artifact; preparing and building from the vendored source", flush=True)
    preparer = ROOT / "scripts" / "fetch_native_inputs.py"
    prepare_cmd = [sys.executable, str(preparer), "--prepare", "--target", target]
    if bun:
        prepare_cmd.extend(["--bun", bun])
    prep_result = subprocess.run(prepare_cmd, cwd=ROOT)
    if prep_result.returncode != 0:
        raise SystemExit(
            f"preparing local engine inputs failed (exit {prep_result.returncode}). Nothing was packaged or "
            "installed; the previous installation is untouched."
        )
    builder = ROOT / "scripts" / "build_local_engine.py"
    # The builder nests its output one level deeper, per target: <outdir>/<target>/.
    expected = DEFAULT_ENGINE_DIR / target
    build_cmd = [sys.executable, str(builder), "--target", target, "--outdir", str(DEFAULT_ENGINE_DIR)]
    if bun:
        build_cmd.extend(["--bun", bun])
    result = subprocess.run(build_cmd, cwd=ROOT)
    if result.returncode != 0:
        raise SystemExit(
            f"building the local engine failed (exit {result.returncode}). Nothing was packaged or "
            "installed; the previous installation is untouched."
        )
    ok, why = engine_is_current(expected, target)
    if not ok:
        raise SystemExit(f"the engine build reported success but is not usable: {why}")
    return expected


def build_package(out_dir: Path | None, bun: str, commit: str, install: bool,
                  engine_dir: Path | None = None, engine_target: str | None = None) -> int:
    # Resolve the engine before anything is installed or staged. This is the ordering that matters:
    # `--install` used to reach npm with no engine at all and leave a package that exits 127.
    target = engine_target or platform_arch()
    engine_dir = resolve_engine_input(engine_dir, target, allow_build=True, bun=bun)
    # Carry the resolved target forward: stage_package validates the manifest against it, and the
    # caller's value may be None even though the engine was resolved for this host.
    engine_target = target

    if install:
        run([bun, "install", "--frozen-lockfile"], cwd=ROOT)
    if out_dir is None:
        out = Path(tempfile.mkdtemp(prefix="bashwink-npm-")).resolve()
    else:
        out = out_dir.resolve()
        if not install and out.exists():
            shutil.rmtree(out)
        out.mkdir(parents=True)
    stage = out / "stage/package"
    manifest = stage_package(stage, commit, bun, engine_dir, engine_target)
    bundled = bundled_packages(stage / "lib/bashwink.js")
    packed = capture([NPM, "pack", "--ignore-scripts", "--pack-destination", out, stage], cwd=out).splitlines()[-1]
    tarball = out / packed
    report = audit(tarball)
    shutil.rmtree(out / "stage")
    digest = sha256(tarball)
    (out / "SHA256SUMS").write_text(f"{digest}  {tarball.name}\n")
    (out / "RELEASE_MANIFEST.json").write_text(json.dumps({
        "schema": 1, "flavor": "standard", "package": manifest["name"], "version": manifest["version"],
        "candidate_commit": commit, "artifact": {"name": tarball.name, "sha256": digest, "bytes": tarball.stat().st_size},
        "dependencies": manifest["dependencies"], "engines": manifest["engines"], "os": manifest["os"], "cpu": manifest["cpu"],
        "contents": report["names"], "audit": "passed", "bundled_third_party": bundled, "built_with": {"bun": BUN_VERSION, "npm": capture([NPM, "--version"]),
        "node": capture(["node", "--version"])},
    }, indent=2) + "\n")
    print(f"tarball  {tarball}\nsha256   {digest}\nsize     {tarball.stat().st_size} bytes, {report['files']} files\ncommit   {commit}",
          flush=True)
    if install:
        run([NPM, "install", "--global", tarball], cwd=out)
        command = "bashwink.cmd" if sys.platform == "win32" else "bashwink"
        print(f"Bashwink installed. Run {command} doctor to check your setup.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, help="Output directory (default with --install: a fresh temporary directory)")
    parser.add_argument("--install", action="store_true", help="Install locked dependencies, build, and install Bashwink globally")
    parser.add_argument("--bun", help="Explicit path to the pinned Bun executable")
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--engine-dir", type=Path,
                        help="Directory holding a validated engine + engine-manifest.json (from scripts/build_local_engine.py)")
    parser.add_argument("--engine-target", help="Target the engine was built for, e.g. darwin-arm64 (default: this host)")
    args = parser.parse_args()
    if args.out is None and not args.install:
        parser.error("--out is required when building without --install")
    if args.install and args.out is not None and args.out.exists():
        parser.error("--out must be a new directory when using --install")
    check_base_prerequisites()
    git = shutil.which("git") or "git"
    status = capture([git, "status", "--porcelain"], cwd=ROOT)
    if status and not args.allow_dirty:
        raise SystemExit("the working tree has uncommitted changes; commit them or pass --allow-dirty")
    commit = capture([git, "rev-parse", "HEAD"], cwd=ROOT) + ("+dirty" if status else "")
    with ExitStack() as resources:
        bun = resolve_bun(args.bun, args.install, resources)
        engine_target = args.engine_target
        if args.engine_dir is not None and engine_target is None:
            engine_target = platform_arch()
        return build_package(args.out, bun, commit, args.install, args.engine_dir, engine_target)


if __name__ == "__main__":
    sys.exit(main())
