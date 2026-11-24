#!/usr/bin/env python3
"""Build the private npm tarball of Bashwink's standard (native) mode.

    python3 scripts/build_npm_package.py --out build/npm [--allow-dirty]

Produces, under <out>:
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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "release/npm"


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
    if notices.exists():
        (stage / "share/licenses").mkdir(parents=True)
        shutil.copyfile(notices, stage / "share/licenses/THIRD_PARTY_NOTICES.txt")
    return manifest


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--bun", default=shutil.which("bun") or "bun")
    parser.add_argument("--allow-dirty", action="store_true")
    args = parser.parse_args()
    if capture([args.bun, "--version"]) != "1.4.4":
        raise SystemExit("Bun 1.4.4 is pinned for building")
    status = capture(["git", "status", "--porcelain"], cwd=ROOT)
    if status and not args.allow_dirty:
        raise SystemExit("the working tree has uncommitted changes; commit them or pass --allow-dirty")
    commit = capture(["git", "rev-parse", "HEAD"], cwd=ROOT) + ("+dirty" if status else "")
    out = args.out.resolve()
    if out.exists():
        shutil.rmtree(out)
    stage = out / "stage/package"
    out.mkdir(parents=True)
    manifest = stage_package(stage, commit, args.bun)
    packed = capture(["npm", "pack", "--ignore-scripts", "--pack-destination", out, stage], cwd=out).splitlines()[-1]
    tarball = out / packed
    report = audit(tarball)
    shutil.rmtree(out / "stage")
    digest = sha256(tarball)
    (out / "SHA256SUMS").write_text(f"{digest}  {tarball.name}\n")
    (out / "RELEASE_MANIFEST.json").write_text(json.dumps({
        "schema": 1, "flavor": "standard", "package": manifest["name"], "version": manifest["version"],
        "candidate_commit": commit, "artifact": {"name": tarball.name, "sha256": digest, "bytes": tarball.stat().st_size},
        "dependencies": manifest["dependencies"], "engines": manifest["engines"], "os": manifest["os"], "cpu": manifest["cpu"],
        "contents": report["names"], "audit": "passed", "built_with": {"bun": "1.4.4", "npm": capture(["npm", "--version"]),
        "node": capture(["node", "--version"])},
    }, indent=2) + "\n")
    print(f"tarball  {tarball}\nsha256   {digest}\nsize     {tarball.stat().st_size} bytes, {report['files']} files\ncommit   {commit}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
