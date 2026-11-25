#!/usr/bin/env python3
"""Build the local engine from the vendored source (Task 3).

This is the reproducible, reviewable half of Task 3. It does not replace
`vendor/engine/packages/cli/script/build.ts` — it *drives* it, with the stock flags the plan names
(`--single --skip-install --skip-web-ui`) and with the local PTY helper supplied through
`BASHWINK_PTY_DIR`, so no registry `@opencode/pty` is needed even though the stock script would
normally install one.

Two things it deliberately does not do:

- it never downloads a published OpenCode runtime, and there is no code path that could;
- it never resolves the PTY helper from `PATH` or from a registry package.

Design notes worth keeping:

**Target names differ.** `build.ts` maps `os === "win32"` to the string `windows`, so the Bashwink
manifest key (`win32-arm64`) and the `OPENCODE_TARGET` value (`windows-arm64`) are not the same.
`to_opencode_target()` is the single place that translation happens.

**`--skip-install` is only valid once the inputs exist.** The stock script's install step is what
would fetch `@opencode/pty`, so skipping it is correct — but then every input the build needs must
already be on disk, including OpenTUI's native libraries. `preflight()` proves that before the
build is attempted, and names what is missing rather than letting Bun fail obscurely.

**Containment is checked after resolution.** `contained_path()` resolves the path and then compares
real paths, and refuses symlinks outright, because a symlink inside the build root pointing outside
it defeats a string-prefix check.
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
from pathlib import Path

SCHEMA_VERSION = 1

# Targets the manifest understands. Deliberately a fixed set: an unknown target must be refused by
# name rather than falling back to the host, because "built for whatever the host is" is exactly the
# mistake that produces a binary labelled as one platform and runnable on another.
SUPPORTED_TARGETS: dict[str, dict[str, str]] = {
    "darwin-arm64": {"os": "darwin", "arch": "arm64"},
    "darwin-x64": {"os": "darwin", "arch": "x64"},
    "linux-arm64": {"os": "linux", "arch": "arm64", "abi": "glibc"},
    "linux-arm64-musl": {"os": "linux", "arch": "arm64", "abi": "musl"},
    "linux-x64": {"os": "linux", "arch": "x64", "abi": "glibc"},
    "linux-x64-musl": {"os": "linux", "arch": "x64", "abi": "musl"},
    "win32-arm64": {"os": "win32", "arch": "arm64"},
    "win32-x64": {"os": "win32", "arch": "x64"},
}

# Where the PTY helper may come from. `registry` is absent on purpose: it is not a valid source for
# this build, and a manifest that could record it would make a registry dependency look legitimate.
PTY_SOURCE_KINDS = ("local-build",)

REQUIRED_MANIFEST_KEYS = (
    "schemaVersion",
    "target",
    "sourcePins",
    "engine",
    "pty",
    "toolchains",
    "notices",
    "buildInputs",
)

# The directory `build.ts` creates for each target, which is not the same string as either the
# manifest key or OPENCODE_TARGET: it prefixes `cli-` and omits `-baseline`. Derived here rather
# than guessed at the point of use.
OPENCODE_TARGET_SUFFIX: dict[str, str] = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-arm64": "linux-arm64",
    "linux-arm64-musl": "linux-arm64-musl",
    "linux-x64": "linux-x64",
    "linux-x64-musl": "linux-x64-musl",
    "win32-arm64": "windows-arm64",
    "win32-x64": "windows-x64",
}

# The pins this build is allowed to claim. Taken from the vendored tree, not from this file, so a
# changed vendor pin cannot be papered over by a stale constant.
VENDOR = Path("vendor/engine")
UPSTREAM_MANIFEST = VENDOR / "UPSTREAM.json"


class BuildRefused(RuntimeError):
    """A build that must not proceed. Never caught to produce a fallback: the point is to stop."""


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def to_opencode_target(target: str) -> str:
    """Translate a manifest target key into the OPENCODE_TARGET value build.ts expects.

    `build.ts` renders `win32` as `windows` in its target names, so the two vocabularies differ for
    exactly the Windows targets — a build invoked with the manifest key would report "Unknown build
    target".
    """
    spec = supported_target(target)
    os_name = "windows" if spec["os"] == "win32" else spec["os"]
    parts = [os_name, spec["arch"]]
    if spec.get("abi") == "musl":
        parts.append("musl")
    return "-".join(parts)


def supported_target(target: str) -> dict[str, str]:
    try:
        return SUPPORTED_TARGETS[target]
    except KeyError:
        supported = ", ".join(sorted(SUPPORTED_TARGETS))
        raise BuildRefused(
            f"unsupported target {target!r}: not in the build matrix. Supported: {supported}. "
            "An unknown target is refused rather than built for the host."
        ) from None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def contained_path(root: Path, candidate: str | Path) -> Path:
    """Resolve `candidate` under `root`, or refuse.

    Both checks matter and neither is redundant. Refusing symlinks catches the case that defeats a
    prefix comparison — a link *inside* the root pointing *outside* it — with a message that says
    what happened. The resolved-prefix check then catches everything else, including `..`
    traversal, because `resolve()` collapses it before the comparison.
    """
    root_real = root.resolve()
    path = Path(candidate)
    if not path.is_absolute():
        path = root_real / path

    # Check each component for a symlink before resolving, so the refusal can name the link.
    probe = path
    while True:
        if probe != root_real and probe.is_symlink():
            raise BuildRefused(
                f"path {candidate} passes through the symlink {probe}, which resolves outside the "
                f"build root {root_real}. Symlinks are refused, not followed."
            )
        if probe == root_real or probe.parent == probe:
            break
        probe = probe.parent

    resolved = path.resolve()
    try:
        resolved.relative_to(root_real)
    except ValueError:
        raise BuildRefused(
            f"path {candidate} resolves to {resolved}, which is outside the build root {root_real}."
        ) from None
    return resolved


def manifest_digest(manifest: dict) -> str:
    """Digest of the manifest's meaning, not its formatting: key order must not matter."""
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _vendor_pins() -> dict:
    path = repo_root() / UPSTREAM_MANIFEST
    if not path.is_file():
        raise BuildRefused(
            f"missing {UPSTREAM_MANIFEST}: cannot establish source pins, so no build can be "
            "attributed to a source. Run scripts/import_local_engine.py first."
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        "engine": data.get("engine", {}).get("commit"),
        "ptyHelper": data.get("ptyHelper", {}).get("commit"),
    }


def _toolchain_versions(
    zig_daemon: str | None = None,
    zig_opentui: str | None = None,
    toolchain_path: str | None = None,
    engine_dir: Path | None = None,
) -> dict:
    """Record the exact tools that produced this artifact.

    Versions are resolved through an explicit list of executables first and `PATH` second. A null
    entry would mean "the build ran with a toolchain nobody recorded", which defeats the point of
    the manifest, so the caller can pass `--toolchain-path` and each tool is reported by its own
    version output rather than a constant.
    """

    def resolve(name: str) -> str | None:
        explicit = os.environ.get(f"BASHWINK_{name.upper()}")
        if explicit and Path(explicit).is_file():
            return explicit
        candidates = (f"{name}.exe", f"{name}.cmd", name) if sys.platform == "win32" else (name,)
        search = [toolchain_path] if toolchain_path else []
        search.extend(os.environ.get("PATH", "").split(os.pathsep))
        for directory in search:
            if not directory:
                continue
            for item in candidates:
                candidate = Path(directory) / item
                if candidate.is_file() and (sys.platform == "win32" or os.access(candidate, os.X_OK)):
                    return str(candidate)
        return shutil.which(name)

    def version_of(executable: str | None) -> tuple[str | None, str | None]:
        if not executable:
            return None, None
        name = Path(executable).name
        # `rustc` and `cargo` both accept `--version`; `zig` only accepts `version` (no dashes).
        # Using one form for all of them silently recorded nulls for the tools that disagree, which
        # is the opposite of what a provenance field is for.
        argv = [executable, "version"] if name.startswith("zig") else [executable, "--version"]
        try:
            out = subprocess.run(argv, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.SubprocessError):
            return executable, None
        if out.returncode != 0:
            return executable, None
        return executable, out.stdout.strip().splitlines()[0] if out.stdout.strip() else None

    rustc_path, rustc_version = version_of(resolve("rustc"))
    cargo_path, cargo_version = version_of(resolve("cargo"))

    # The PTY helper is built inside packages/process-daemon, where rust-toolchain.toml overrides
    # the host default. Probing `rustc` from the repo root reports the *host* toolchain, which is
    # not what compiled the helper — and recording it as if it were would be a false provenance
    # claim. Resolve it from that directory instead.
    daemon_dir = (engine_dir / "packages" / "process-daemon") if engine_dir else None
    daemon_rustc = None
    rustc_exe = rustc_path or "rustc"
    if daemon_dir and daemon_dir.is_dir():
        try:
            out = subprocess.run(
                [rustc_exe, "--version"], cwd=daemon_dir, capture_output=True, text=True, timeout=60
            )
            if out.returncode == 0 and out.stdout.strip():
                daemon_rustc = out.stdout.strip().splitlines()[0]
        except (OSError, subprocess.SubprocessError):
            daemon_rustc = None
    bun_path, bun_version = version_of(resolve("bun"))
    _, zig_pty_version = version_of(zig_daemon)
    _, zig_opentui_version = version_of(zig_opentui)
    return {
        "rust": rustc_version,
        "cargo": cargo_version,
        "bun": bun_version,
        "zigPtyHelper": zig_pty_version,
        "zigOpentui": zig_opentui_version,
        # What actually compiled the helper, versus the host default above.
        "ptyHelperRust": daemon_rustc,
        # Basenames only: the manifest ships inside the package, and a user's home directory is
        # neither a provenance fact nor something to publish.
        "paths": {
            "rustc": Path(rustc_path).name if rustc_path else None,
            "cargo": Path(cargo_path).name if cargo_path else None,
            "bun": Path(bun_path).name if bun_path else None,
            "zigPtyHelper": Path(zig_daemon).name if zig_daemon else None,
            "zigOpentui": Path(zig_opentui).name if zig_opentui else None,
        },
    }


# The two Zig pins. They are deliberately different versions and neither may substitute for the
# other: the daemon's build.rs was pinned against 0.16.0, OpenTUI's build.zig requires 0.17.0.
WANT_ZIG_PTY = "0.16.0"
WANT_ZIG_OPENTUI = "0.17.0"


def default_zig(wanted: str) -> str | None:
    """Find a Zig of exactly `wanted` under the known toolchain roots or PATH, or return None.

    Wrong versions are skipped rather than accepted. A build recorded against an unverified
    toolchain is not attributable, and "close enough" here silently changes what the compiler emits.
    """
    exe = "zig.exe" if sys.platform == "win32" else "zig"
    roots = [
        Path("/tmp/zig-install"),
        repo_root() / "build" / "toolchains",
        Path.home() / ".local" / "share" / "zig",
    ]
    candidates: list[Path] = []
    for root in roots:
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
        if out.stdout.strip() == wanted:
            return str(binary)
    return None


def manifest_for_target(target: str, *, zig_daemon: str | None = None, zig_opentui: str | None = None) -> dict:
    """The manifest skeleton for a target, before any artifacts exist."""
    spec = supported_target(target)
    zig_daemon = zig_daemon or default_zig(WANT_ZIG_PTY)
    zig_opentui = zig_opentui or default_zig(WANT_ZIG_OPENTUI)
    pins = _vendor_pins()
    upstream_json = repo_root() / UPSTREAM_MANIFEST
    notices = (
        {"inventory": str(UPSTREAM_MANIFEST), "sha256": sha256_file(upstream_json)}
        if upstream_json.is_file()
        else {"inventory": None, "sha256": None}
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "target": target,
        "opencodeTarget": to_opencode_target(target),
        "platform": spec,
        "sourcePins": pins,
        "engine": {"name": None, "sha256": None, "bytes": None},
        "pty": {"name": None, "sha256": None, "bytes": None, "source": "local-build"},
        "toolchains": _toolchain_versions(
            zig_daemon, zig_opentui, engine_dir=repo_root() / "vendor" / "engine"
        ),
        "notices": notices,
        "buildInputs": {},
    }


def preflight(*, engine_dir: Path, pty_dir: Path, target: str) -> dict[str, Path]:
    """Prove the inputs exist before the build runs, naming whatever is absent.

    `--skip-install` means the stock script will not fetch anything, so a missing input is not
    something the build can recover from — it has to be caught here, where the message can say what
    is missing and how to produce it.
    """
    spec = supported_target(target)
    missing: list[str] = []

    build_ts = engine_dir / "packages" / "cli" / "script" / "build.ts"
    if not build_ts.is_file():
        missing.append(f"{build_ts} (the stock build script)")

    pty_name = "opencode-pty.exe" if spec["os"] == "win32" else "opencode-pty"
    pty_binary = pty_dir / pty_name
    if not pty_binary.is_file():
        missing.append(
            f"{pty_binary} (the locally built PTY helper; build it from "
            f"{VENDOR}/packages/process-daemon with `cargo build --locked --release` and point "
            f"BASHWINK_PTY_DIR at it)"
        )

    # OpenTUI's native library for this target, which `--skip-install` will not fetch.
    #
    # This check is deliberately stricter than "a .dylib exists". The registry package ships a
    # stock libopentui that statically links FFmpeg (measured: 38 `avcodec`, 48 `libav`,
    # 15 `avformat` markers), and accepting it would silently ship the exact obligation this
    # project rebuilt the library to remove. So the library is scanned and refused if a marker is
    # present.
    opentui_dirs = sorted(
        {
            *((engine_dir / "node_modules" / "@opentui").glob(f"core-{spec['os']}-{spec['arch']}*")),
            # Bun hoists workspace dependencies into a `.bun` store, so the package may only exist
            # there. Without this, a stock FFmpeg-carrying library is invisible to the scan and the
            # refusal reads "missing" instead of naming FFmpeg — a much weaker message for a much
            # worse problem.
            *(
                (engine_dir / "node_modules" / ".bun").glob(
                    f"@opentui+core-{spec['os']}-{spec['arch']}*@*/node_modules/@opentui/core-{spec['os']}-{spec['arch']}*"
                )
            ),
        }
    )
    opentui_libs: list[Path] = []
    for directory in opentui_dirs:
        for pattern in ("*.dylib", "*.so", "*.dll"):
            opentui_libs.extend(sorted(directory.glob(pattern)))
    if not opentui_libs:
        missing.append(
            f"an OpenTUI native library for {target} under "
            f"{engine_dir}/node_modules/@opentui/core-{spec['os']}-{spec['arch']}* — built without "
            "FFmpeg per release/NOFFMPEG_RUNTIME.md"
        )
    else:
        for library in opentui_libs:
            markers = ffmpeg_markers(library)
            if markers:
                raise BuildRefused(
                    f"{library} contains FFmpeg markers {sorted(markers)}. This is the stock registry "
                    "library, not the no-FFmpeg rebuild; building with it would reintroduce the "
                    "FFmpeg obligation. Replace it with the local libopentui build "
                    "(release/NOFFMPEG_RUNTIME.md)."
                )

    if missing:
        raise BuildRefused(
            "missing build input(s); --skip-install cannot fetch them and this builder never "
            "downloads a published runtime:\n  - " + "\n  - ".join(missing)
        )

    return {"engine": engine_dir, "pty": pty_binary, "opentui": opentui_libs[0]}


# Markers that indicate FFmpeg code is linked in. `_ff_` is included because FFmpeg's internal
# symbol prefix survives stripping in some builds; the published no-FFmpeg runtime matches none of
# these, while the stock registry library matches all five.
FFMPEG_MARKERS = (b"avcodec", b"avformat", b"swscale", b"swresample", b"libavutil", b"_ff_")


def ffmpeg_markers(path: Path) -> set[str]:
    """Return the FFmpeg markers found in `path`'s bytes, without loading the whole file."""
    found: set[str] = set()
    with path.open("rb") as handle:
        while chunk := handle.read(8 << 20):
            for marker in FFMPEG_MARKERS:
                if marker in chunk and marker.decode() not in found:
                    found.add(marker.decode())
    return found



def build(
    *,
    target: str,
    engine: Path | None,
    pty_dir: Path | None,
    expect_sha256: str | None = None,
    allow_download: bool = False,
    outdir: Path | None = None,
    dry_run: bool = False,
    bun: str | None = None,
) -> dict:
    """Validate inputs, then drive the stock build script. Returns the manifest.

    `allow_download` exists only so the refusal can be tested; passing it is an error rather than a
    mode, because there is no supported path that downloads a runtime.
    """
    if allow_download:
        raise BuildRefused(
            "refusing to download a published runtime: this build must derive from the pinned "
            "vendored source. There is no download fallback."
        )
    spec = supported_target(target)

    if engine is None:
        engine = repo_root() / VENDOR
    if pty_dir is None:
        env_dir = os.environ.get("BASHWINK_PTY_DIR")
        pty_dir = Path(env_dir) if env_dir else repo_root() / "build" / "pty" / target
    engine = Path(engine)
    pty_dir = Path(pty_dir)

    if not engine.exists():
        raise BuildRefused(f"missing engine source tree: {engine} does not exist")

    # The PTY check runs before the full preflight on purpose. A wrong helper or a wrong digest is
    # the more specific fault, and reporting "an OpenTUI library is missing" when the real problem
    # is "you pointed me at the wrong helper" sends the reader to the wrong place.
    pty_name = "opencode-pty.exe" if spec["os"] == "win32" else "opencode-pty"
    pty_binary = pty_dir / pty_name
    if not pty_binary.is_file():
        raise BuildRefused(
            f"missing PTY helper at {pty_binary}; --skip-install cannot fetch it, and this builder "
            f"never resolves one from PATH or the registry. Build it from "
            f"{VENDOR}/packages/process-daemon with `cargo build --locked --release`."
        )
    pty_sha = sha256_file(pty_binary)
    if expect_sha256 is not None and pty_sha != expect_sha256:
        raise BuildRefused(
            f"digest mismatch for {pty_binary}: expected {expect_sha256}, got {pty_sha}. "
            "A digest that does not match is refused, never trusted."
        )

    inputs = preflight(engine_dir=engine, pty_dir=pty_dir, target=target)

    out_root = (outdir or (repo_root() / "build" / "engine")).resolve()
    target_out = contained_path(out_root, target)
    target_out.mkdir(parents=True, exist_ok=True)

    manifest = manifest_for_target(
        target,
        zig_daemon=os.environ.get("BASHWINK_ZIG_PTY"),
        zig_opentui=os.environ.get("BASHWINK_ZIG_OPENTUI"),
    )
    manifest["pty"].update(
        {
            "name": inputs["pty"].name,
            "sha256": pty_sha,
            "bytes": inputs["pty"].stat().st_size,
            "source": "local-build",
        }
    )
    manifest["buildInputs"]["opentui"] = str(Path(inputs["opentui"]).name)

    bun_executable = bun or os.environ.get("BASHWINK_BUN") or shutil.which("bun") or "bun"
    env = dict(os.environ)
    env["BASHWINK_BUN"] = bun_executable
    if Path(bun_executable).is_file():
        env["PATH"] = f"{Path(bun_executable).resolve().parent}{os.pathsep}{env.get('PATH', '')}"
    command = [
        bun_executable,
        "run",
        "script/build.ts",
        "--single" if _is_host_target(spec) else "--skip-install",
        "--skip-install",
        "--skip-web-ui",
        f"--outdir={target_out / 'dist'}",
    ]
    env["OPENCODE_TARGET"] = to_opencode_target(target)
    env["BASHWINK_PTY_DIR"] = str(pty_dir)
    env.setdefault("OPENCODE_VERSION", _vendor_version())

    # Deliberately records the shape of the invocation without absolute paths: the manifest ships
    # inside the package, and hard-coded home directories are both a privacy leak and a false claim
    # about reproducibility on any other machine.
    manifest["buildCommand"] = {
        "argv": [
            # Drop absolute destinations; record the shape only. The flag starts with `--`, so the
            # test must look at what follows it, not at the first character of the whole argument.
            ("--outdir=<build-outdir>" if a.startswith("--outdir=") else Path(a).name)
            if a.startswith("/") or a.startswith("--outdir=")
            else a
            for a in command
        ],
        "cwd": "vendor/engine/packages/cli",
        "env": {"OPENCODE_TARGET": env["OPENCODE_TARGET"], "BASHWINK_PTY_DIR": "<local-pty-dir>"},
    }

    if not dry_run:
        result = subprocess.run(
            command,
            cwd=engine / "packages" / "cli",
            env=env,
            capture_output=True,
            text=True,
        )
        manifest["buildResult"] = {
            "returncode": result.returncode,
            "stdoutTail": result.stdout[-4000:],
            "stderrTail": result.stderr[-4000:],
        }
        if result.returncode != 0:
            raise BuildRefused(
                f"the stock build failed with exit {result.returncode}. stderr tail:\n"
                f"{result.stderr[-2000:]}"
            )

        # Record the artifact the build actually produced, not the path it was asked to produce.
        # A manifest with a null digest would satisfy a schema check and prove nothing.
        produced = target_out / "dist" / f"cli-{OPENCODE_TARGET_SUFFIX[target]}" / "bin" / (
            "opencode.exe" if spec["os"] == "win32" else "opencode"
        )
        if not produced.is_file():
            candidates = sorted((target_out / "dist").glob("cli-*/bin/opencode*"))
            if not candidates:
                raise BuildRefused(
                    f"the build reported success but no engine binary exists under {target_out / 'dist'}. "
                    "A missing artifact is a failure, not an empty success."
                )
            produced = candidates[0]

        markers = ffmpeg_markers(produced)
        if markers:
            raise BuildRefused(
                f"the built engine {produced} contains FFmpeg markers {sorted(markers)}. The "
                "no-FFmpeg library substitution did not take effect; refusing to record this "
                "artifact as the local engine."
            )

        manifest["engine"] = {
            "name": produced.name,
            "sha256": sha256_file(produced),
            "bytes": produced.stat().st_size,
            "path": str(produced.relative_to(target_out)),
            "ffmpegMarkers": [],
        }

    (target_out / "engine-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def _is_host_target(spec: dict[str, str]) -> bool:
    host_os = {"darwin": "darwin", "linux": "linux", "win32": "win32"}.get(sys.platform, sys.platform)
    machine = platform.machine().lower()
    host_arch = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(
        machine, machine
    )
    return spec["os"] == host_os and spec["arch"] == host_arch


def _vendor_version() -> str:
    pkg = repo_root() / VENDOR / "packages" / "cli" / "package.json"
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
    except OSError:
        return "0.0.0"
    return str(data.get("version") or "0.0.0")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", required=True, help="manifest target key, e.g. darwin-arm64")
    ap.add_argument("--engine", help="engine source tree (default: vendor/engine)")
    ap.add_argument("--pty-dir", help="directory holding the locally built opencode-pty")
    ap.add_argument("--outdir", help="output root (default: build/engine)")
    ap.add_argument("--bun", help="path to the pinned Bun executable")
    ap.add_argument("--dry-run", action="store_true", help="validate and write the manifest, do not build")
    ap.add_argument("--manifest-only", action="store_true", help="print the manifest skeleton and exit")
    args = ap.parse_args(argv)

    try:
        if args.manifest_only:
            print(json.dumps(manifest_for_target(args.target), indent=2))
            return 0
        manifest = build(
            target=args.target,
            engine=Path(args.engine) if args.engine else None,
            pty_dir=Path(args.pty_dir) if args.pty_dir else None,
            outdir=Path(args.outdir) if args.outdir else None,
            dry_run=args.dry_run,
            bun=args.bun,
        )
    except BuildRefused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({k: manifest[k] for k in ("target", "opencodeTarget", "pty", "sourcePins")}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
