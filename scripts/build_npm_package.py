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


def stage_package(stage: Path, commit: str, bun: str) -> dict:
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
            for pattern in (r"/Users/[A-Za-z0-9._-]+/", r"[A-Z]:\\Users\\[A-Za-z0-9._-]+\\", r"/home/[a-z][a-z0-9_-]+/"):
                found = re.search(pattern, text)
                if found:
                    problems.append(f"{member.name}: development-machine path {found.group(0)!r}")
            if re.search(r"(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)", text):
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


def build_package(out_dir: Path | None, bun: str, commit: str, install: bool) -> int:
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
    manifest = stage_package(stage, commit, bun)
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
    args = parser.parse_args()
    if args.out is None and not args.install:
        parser.error("--out is required when building without --install")
    if args.install and args.out is not None and args.out.exists():
        parser.error("--out must be a new directory when using --install")
    status = capture(["git", "status", "--porcelain"], cwd=ROOT)
    if status and not args.allow_dirty:
        raise SystemExit("the working tree has uncommitted changes; commit them or pass --allow-dirty")
    commit = capture(["git", "rev-parse", "HEAD"], cwd=ROOT) + ("+dirty" if status else "")
    with ExitStack() as resources:
        bun = resolve_bun(args.bun, args.install, resources)
        return build_package(args.out, bun, commit, args.install)


if __name__ == "__main__":
    sys.exit(main())
