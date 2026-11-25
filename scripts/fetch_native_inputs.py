#!/usr/bin/env python3
"""Fetch the native build inputs a clean clone needs, at their pins, with recorded digests.

`vendor/engine/packages/process-daemon/build.rs` fetches Ghostty itself when `GHOSTTY_SOURCE_DIR`
is unset. That works on a developer machine with network access and is wrong for this project in
three ways:

1. it happens *during* `cargo build`, so the build's inputs are decided by the build itself;
2. a clean clone has no record of what was fetched beyond a bare commit hash;
3. there is no integrity check on the tarball, only Git's own object hashing.

This script prefetches the same bytes at the same pinned revision, records the sha256 of every
file it places on disk, and prints the environment the build needs. `scripts/build_local_engine.py`
then consumes it. Nothing here downloads an OpenCode or OpenTUI artifact — only the two native
source trees the compiler needs, which are third-party inputs the plan permits.

Usage:
    python3 scripts/fetch_native_inputs.py --check      # report what is present, exit 1 if incomplete
    python3 scripts/fetch_native_inputs.py --fetch      # clone/verify the pinned inputs
    python3 scripts/fetch_native_inputs.py --env        # print exports for the shell
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
VENDOR = REPO / "vendor" / "engine"
DAEMON = VENDOR / "packages" / "process-daemon"

# Default location, overridable so a CI job can point at a cached directory.
CACHE = Path(os.environ.get("BASHWINK_NATIVE_CACHE", REPO / "build" / "native-inputs"))
MANIFEST = CACHE / "native-inputs.json"

GHOSTTY_REPO = "https://github.com/ghostty-org/ghostty.git"
OPENTUI_REPO = "https://github.com/anomalyco/opentui.git"
OPENTUI_REVISION = "d4a2af24ba50636da5f222367f91746a1bf89644"
WANT_ZIG_PTY = "0.16.0"
WANT_ZIG_OPENTUI = "0.17.0"
MARKER_NAME = ".bw-complete"

# Mapping from manifest target to OpenTUI native library build matrix and npm package directory names.
OPENTUI_TARGET_BUILDS: dict[str, list[tuple[str, str, str]]] = {
    "darwin-arm64": [("aarch64-macos.13.0", "aarch64-macos", "core-darwin-arm64")],
    "darwin-x64": [("x86_64-macos.13.0", "x86_64-macos", "core-darwin-x64")],
    "linux-x64": [("x86_64-linux-gnu.2.17", "x86_64-linux", "core-linux-x64")],
    "linux-arm64": [("aarch64-linux-gnu.2.17", "aarch64-linux", "core-linux-arm64")],
    "linux-x64-musl": [
        ("x86_64-linux-musl", "x86_64-linux-musl", "core-linux-x64-musl"),
        ("x86_64-linux-gnu.2.17", "x86_64-linux", "core-linux-x64"),
    ],
    "linux-arm64-musl": [
        ("aarch64-linux-musl", "aarch64-linux-musl", "core-linux-arm64-musl"),
        ("aarch64-linux-gnu.2.17", "aarch64-linux", "core-linux-arm64"),
    ],
    "win32-x64": [("x86_64-windows-gnu", "x86_64-windows", "core-win32-x64")],
    "win32-arm64": [("aarch64-windows-gnu", "aarch64-windows", "core-win32-arm64")],
}

FFMPEG_MARKERS = (b"avcodec", b"avformat", b"swscale", b"swresample", b"libavutil", b"_ff_")


class FetchRefused(RuntimeError):
    pass


def ghostty_revision() -> str:
    """The revision build.rs would fetch, read from the vendored pin (not hard-coded here)."""
    path = DAEMON / "ghostty-revision"
    if not path.is_file():
        raise FetchRefused(
            f"missing {path.relative_to(REPO)}: the Ghostty pin lives in the vendored tree and "
            "cannot be guessed. Run scripts/import_local_engine.py first."
        )
    rev = path.read_text(encoding="utf-8").strip()
    if not rev or len(rev) < 7:
        raise FetchRefused(f"{path} does not contain a commit revision: {rev!r}")
    return rev


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def tree_digest(root: Path) -> str:
    """A digest over the whole tree: relative paths plus file digests, sorted.

    This is not Git's object hash. It answers a different question — "are these the bytes I
    recorded?" — which is what a build input needs, and it does not require a `.git` directory.

    `.git` and the completion marker are excluded. The marker especially: it is written *after*
    this digest is computed, so including it would make every subsequent check disagree with the
    recorded value — a self-invalidating digest that proves nothing.
    """
    entries: list[str] = []
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        rel = path.relative_to(root)
        if ".git" in rel.parts or rel.name == MARKER_NAME:
            continue
        entries.append(f"{rel}:{sha256_file(path)}")
    digest = hashlib.sha256()
    for line in entries:
        digest.update(line.encode())
        digest.update(b"\n")
    return digest.hexdigest()


def run(argv: list[str], *, cwd: Path | None = None, quiet: bool = False) -> subprocess.CompletedProcess:
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True)
    if result.returncode != 0 and not quiet:
        raise FetchRefused(
            f"command failed ({result.returncode}): {' '.join(argv)}\n"
            f"stderr: {result.stderr.strip()[:1500]}"
        )
    return result


def ghostty_dir(rev: str) -> Path:
    return CACHE / f"ghostty-{rev}"


def git_executable() -> str:
    git = shutil.which("git")
    if git:
        return git
    raise FetchRefused(
        "Git is required to fetch pinned native inputs, but `git` was not found on PATH.\n"
        "Install Git and retry: macOS (`xcode-select --install`), Linux (`apt/dnf install git`), "
        "Windows (`winget install Git.Git`)."
    )


def ensure_pinned_repo(repo_url: str, rev: str, target: Path, label: str) -> tuple[Path, str]:
    """Clone `repo_url` at pinned `rev` if absent; return directory and tree digest."""
    marker = target / MARKER_NAME

    if marker.is_file():
        return target, json.loads(marker.read_text(encoding="utf-8"))["treeDigest"]

    if target.exists():
        # A half-finished directory is deleted rather than reused: a partial checkout that happens
        # to satisfy a build is worse than no checkout at all.
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)

    git = git_executable()
    run([git, "init", "--quiet", str(target)])
    run([git, "-C", str(target), "fetch", "--depth=1", repo_url, rev])
    run([git, "-C", str(target), "-c", "core.longpaths=true", "checkout", "--detach", rev])

    head = run([git, "-C", str(target), "rev-parse", "HEAD"]).stdout.strip()
    if head != rev:
        raise FetchRefused(f"checked out {head}, expected {rev}")

    digest = tree_digest(target)
    marker.write_text(
        json.dumps({"revision": rev, "treeDigest": digest, "source": repo_url}, indent=2) + "\n",
        encoding="utf-8",
    )
    return target, digest


def ensure_ghostty(rev: str) -> tuple[Path, str]:
    """Clone the pinned Ghostty revision if absent; return the directory and its tree digest."""
    return ensure_pinned_repo(GHOSTTY_REPO, rev, ghostty_dir(rev), "Ghostty")


def ensure_opentui(rev: str = OPENTUI_REVISION) -> tuple[Path, str]:
    """Clone the pinned OpenTUI revision if absent; return the directory and its tree digest."""
    return ensure_pinned_repo(OPENTUI_REPO, rev, CACHE / f"opentui-{rev}", "OpenTUI")


def _zig_archive_hint(version: str) -> str:
    machine = platform.machine().lower()
    arch = "aarch64" if machine in ("arm64", "aarch64") else "x86_64"
    if sys.platform == "darwin":
        name = f"zig-{arch}-macos-{version}.tar.xz"
    elif sys.platform == "win32":
        name = f"zig-{arch}-windows-{version}.zip"
    else:
        name = f"zig-{arch}-linux-{version}.tar.xz"
    return (
        f"Download https://ziglang.org/download/{version}/{name} and extract it under "
        f"{REPO / 'build' / 'toolchains'} (or set BASHWINK_ZIG_{'PTY' if version == WANT_ZIG_PTY else 'OPENTUI'})."
    )


def zig_executable(wanted: str = WANT_ZIG_PTY) -> Path | None:
    """Locate an exact Zig version (`0.16.0` or `0.17.0`). Absent returns None."""
    env_var = "BASHWINK_ZIG_PTY" if wanted == WANT_ZIG_PTY else "BASHWINK_ZIG_OPENTUI"
    explicit = os.environ.get(env_var)
    if explicit:
        path = Path(explicit)
        if not path.is_file():
            return None
        try:
            out = subprocess.run([str(path), "version"], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            return None
        return path if (out.returncode == 0 and out.stdout.strip() == wanted) else None

    exe = "zig.exe" if sys.platform == "win32" else "zig"
    candidates: list[Path] = []
    for root in (
        Path("/tmp/zig-install"),
        REPO / "build" / "toolchains",
        Path.home() / ".local" / "share" / "zig",
    ):
        if not root.is_dir():
            continue
        for candidate in sorted(root.glob("zig-*")):
            binary = candidate / exe
            if binary.is_file():
                candidates.append(binary)
    on_path = shutil.which("zig")
    if on_path:
        candidates.append(Path(on_path))

    for binary in candidates:
        try:
            out = subprocess.run([str(binary), "version"], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.SubprocessError):
            continue
        if out.returncode == 0 and out.stdout.strip() == wanted:
            return binary
    return None


def check(rev: str) -> dict:
    target = ghostty_dir(rev)
    marker = target / MARKER_NAME
    status: dict = {
        "ghosttyRevision": rev,
        "ghosttyDir": str(target),
        "present": marker.is_file(),
        "treeDigest": None,
        "digestMatches": False,
        "zig": str(zig_executable()) if zig_executable() else None,
    }
    if marker.is_file():
        recorded = json.loads(marker.read_text(encoding="utf-8"))
        actual = tree_digest(target)
        status["treeDigest"] = actual
        status["recordedTreeDigest"] = recorded["treeDigest"]
        status["digestMatches"] = actual == recorded["treeDigest"]
    return status


def env_exports(rev: str, zig: Path | None) -> list[str]:
    exports = [
        f'export GHOSTTY_SOURCE_DIR="{ghostty_dir(rev)}"',
        f'export ZIG_GLOBAL_CACHE_DIR="{CACHE / "zig-cache"}"',
    ]
    if zig is not None:
        # The daemon shells out to a bare `zig`, so the PATH entry is what actually selects the
        # version — a variable would be ignored by build.rs.
        exports.append(f'export PATH="{zig.parent}:$PATH"')
    return exports


def _ffmpeg_markers(path: Path) -> set[str]:
    found: set[str] = set()
    with path.open("rb") as handle:
        while chunk := handle.read(8 << 20):
            for marker in FFMPEG_MARKERS:
                if marker in chunk:
                    found.add(marker.decode())
    return found


def _extract_opentui_zig_deps(native_dir: Path) -> None:
    deps_dir = native_dir / "zig-deps"
    archive = native_dir / "src" / "vendor" / "zig-deps.tar.gz"
    marker = deps_dir / ".ready"
    archive_digest = sha256_file(archive)
    if marker.is_file() and marker.read_text(encoding="utf-8").strip() == archive_digest:
        return
    if deps_dir.exists():
        shutil.rmtree(deps_dir)
    deps_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        tar.extractall(deps_dir, filter="data")
    marker.write_text(archive_digest + "\n", encoding="utf-8")


def _find_built_opentui_lib(opentui_root: Path, output_name: str) -> Path:
    candidates: list[Path] = []
    for base in (opentui_root / "packages" / "native" / "zig-out", opentui_root / "packages"):
        if not base.is_dir():
            continue
        for ext in ("dylib", "so", "dll"):
            candidates.extend(sorted(base.rglob(f"{output_name}/*.{ext}")))
    if not candidates:
        raise FetchRefused(
            f"OpenTUI build finished for {output_name}, but no shared library was found under {opentui_root / 'packages'}"
        )
    return candidates[0]


def _install_clean_opentui_lib(pkg_name: str, built_lib: Path) -> int:
    targets: list[Path] = []
    direct = VENDOR / "node_modules" / "@opentui" / pkg_name
    if direct.is_dir():
        targets.append(direct)
    bun_store = VENDOR / "node_modules" / ".bun"
    if bun_store.is_dir():
        for directory in sorted(bun_store.glob(f"@opentui+{pkg_name}@*/node_modules/@opentui/{pkg_name}")):
            if directory.is_dir():
                targets.append(directory)
    replaced = 0
    for target_dir in targets:
        existing = [
            p
            for pattern in ("*.dylib", "*.so", "*.dll")
            for p in sorted(target_dir.glob(pattern))
        ]
        dest_names = [p.name for p in existing] if existing else [built_lib.name]
        for old in existing:
            old.unlink()
        for name in dest_names:
            shutil.copy2(built_lib, target_dir / name)
            replaced += 1
    return replaced


def check_native_toolchains() -> tuple[str, str, Path, Path]:
    cargo = shutil.which("cargo")
    rustc = shutil.which("rustc")
    if not cargo or not rustc:
        raise FetchRefused(
            "Rust and Cargo (>= 1.90.0) are required to build the local PTY helper.\n"
            "Install Rust with rustup (https://rustup.rs) and ensure rustc 1.90.0+ is on PATH."
        )
    zig_pty = zig_executable(WANT_ZIG_PTY)
    if zig_pty is None:
        raise FetchRefused(
            f"Zig {WANT_ZIG_PTY} is required to build Ghostty for the local PTY helper.\n"
            + _zig_archive_hint(WANT_ZIG_PTY)
        )
    zig_opentui = zig_executable(WANT_ZIG_OPENTUI)
    if zig_opentui is None:
        raise FetchRefused(
            f"Zig {WANT_ZIG_OPENTUI} is required to build the no-FFmpeg OpenTUI library.\n"
            + _zig_archive_hint(WANT_ZIG_OPENTUI)
        )
    return cargo, rustc, zig_pty, zig_opentui


def prepare_engine_inputs(target: str, bun: str | None = None) -> dict:
    """Prepare a clean checkout to build the local engine: vendor deps, PTY helper, clean libopentui."""
    if target not in OPENTUI_TARGET_BUILDS:
        raise FetchRefused(f"unsupported target {target!r}")
    cargo, _rustc, zig_pty, zig_opentui = check_native_toolchains()
    bun_bin = bun or os.environ.get("BASHWINK_BUN") or shutil.which("bun")
    if not bun_bin:
        raise FetchRefused("Bun 1.4.4 is required to install vendor/engine dependencies and build the engine.")

    env = dict(os.environ)
    if Path(bun_bin).is_file():
        env["PATH"] = f"{Path(bun_bin).resolve().parent}{os.pathsep}{env.get('PATH', '')}"

    # 1. Install vendored OpenCode workspace dependencies when absent (including cross-libc on musl).
    builds = OPENTUI_TARGET_BUILDS[target]
    need_vendor_install = not (VENDOR / "node_modules" / ".bun").is_dir() or any(
        not list((VENDOR / "node_modules" / ".bun").glob(f"@opentui+{pkg}@*"))
        for _, _, pkg in builds
    )
    if need_vendor_install:
        print("prepare  installing vendor/engine JS dependencies", flush=True)
        install_cmd = [bun_bin, "install", "--frozen-lockfile", "--os=*", "--cpu=*", "--libc=*"]
        res = subprocess.run(install_cmd, cwd=VENDOR, env=env)
        if res.returncode != 0:
            raise FetchRefused(f"`{' '.join(install_cmd)}` failed in {VENDOR} (exit {res.returncode})")

    # 2. Build local PTY helper (process-daemon + Ghostty) if absent.
    pty_name = "opencode-pty.exe" if target.startswith("win32-") else "opencode-pty"
    pty_out = REPO / "build" / "pty" / target / pty_name
    if not pty_out.is_file():
        print(f"prepare  building {pty_name} with Zig {WANT_ZIG_PTY}", flush=True)
        rev = ghostty_revision()
        ghostty, _ = ensure_ghostty(rev)
        pty_env = dict(env)
        pty_env["GHOSTTY_SOURCE_DIR"] = str(ghostty)
        pty_env["ZIG_GLOBAL_CACHE_DIR"] = str(CACHE / "zig-cache")
        pty_env["PATH"] = f"{zig_pty.resolve().parent}{os.pathsep}{pty_env.get('PATH', '')}"
        cargo_res = subprocess.run([cargo, "build", "--locked", "--release"], cwd=DAEMON, env=pty_env)
        if cargo_res.returncode != 0:
            raise FetchRefused(f"`cargo build --locked --release` failed in {DAEMON} (exit {cargo_res.returncode})")
        built_pty = DAEMON / "target" / "release" / pty_name
        if not built_pty.is_file():
            raise FetchRefused(f"Cargo finished, but {built_pty} was not produced")
        pty_out.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(built_pty, pty_out)

    # 3. Rebuild FFmpeg-free libopentui and replace stock registry native libraries.
    need_clean_opentui = False
    for _, _, pkg in builds:
        libs = list((VENDOR / "node_modules" / ".bun").glob(f"@opentui+{pkg}@*/node_modules/@opentui/{pkg}/*"))
        native_libs = [p for p in libs if p.suffix in (".dylib", ".so", ".dll")]
        if not native_libs or any(_ffmpeg_markers(p) for p in native_libs):
            need_clean_opentui = True
            break

    if need_clean_opentui:
        print(f"prepare  building FFmpeg-free libopentui with Zig {WANT_ZIG_OPENTUI}", flush=True)
        opentui_root, _ = ensure_opentui(OPENTUI_REVISION)
        native_dir = opentui_root / "packages" / "native"
        _extract_opentui_zig_deps(native_dir)
        zig_env = dict(os.environ)
        zig_env["ZIG_GLOBAL_CACHE_DIR"] = str(CACHE / "zig-cache")
        for zig_target, output_name, pkg_name in builds:
            zig_res = subprocess.run(
                [str(zig_opentui), "build", "-Doptimize=ReleaseFast", f"-Dlibrary-target={zig_target}"],
                cwd=native_dir,
                env=zig_env,
            )
            if zig_res.returncode != 0:
                raise FetchRefused(
                    f"building FFmpeg-free libopentui failed for {zig_target} (exit {zig_res.returncode})"
                )
            built_lib = _find_built_opentui_lib(opentui_root, output_name)
            markers = _ffmpeg_markers(built_lib)
            if markers:
                raise FetchRefused(f"rebuilt {built_lib} unexpectedly contained FFmpeg markers {sorted(markers)}")
            replaced = _install_clean_opentui_lib(pkg_name, built_lib)
            if replaced == 0:
                raise FetchRefused(
                    f"could not find @opentui/{pkg_name} under {VENDOR / 'node_modules'} to install {built_lib.name}"
                )

    return {"pty": str(pty_out), "target": target}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fetch", action="store_true", help="clone the pinned inputs")
    ap.add_argument("--check", action="store_true", help="report state; exit 1 when incomplete")
    ap.add_argument("--env", action="store_true", help="print shell exports for the build")
    ap.add_argument("--prepare", action="store_true", help="prepare clean checkout inputs (deps, PTY, no-FFmpeg OpenTUI)")
    ap.add_argument("--target", help="manifest target key for --prepare (e.g. darwin-arm64)")
    ap.add_argument("--bun", help="path to pinned Bun 1.4.4 executable for --prepare")
    args = ap.parse_args(argv)

    try:
        if args.prepare:
            if not args.target:
                raise FetchRefused("--prepare requires --target")
            print(json.dumps(prepare_engine_inputs(args.target, args.bun), indent=2))
            return 0
        rev = ghostty_revision()
        if args.fetch:
            target, digest = ensure_ghostty(rev)
            print(f"ghostty {rev} -> {target}")
            print(f"treeDigest {digest}")
        zig = zig_executable(WANT_ZIG_PTY)
        if args.env:
            for line in env_exports(rev, zig):
                print(line)
            return 0
        if args.check or not args.fetch:
            status = check(rev)
            print(json.dumps(status, indent=2))
            incomplete = not status["present"] or not status["digestMatches"] or not status["zig"]
            return 1 if incomplete else 0
        return 0
    except FetchRefused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
