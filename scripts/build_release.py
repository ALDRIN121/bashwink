#!/usr/bin/env python3
"""Build the Bashwink macOS arm64 release archive.

    python3 scripts/build_release.py --out build/release [--cache DIR] [--allow-dirty]

Nothing is published. The result is a local directory containing:

    bashwink-<version>-macos-arm64.tar.gz      the archive
    SHA256SUMS                                  checksum of the archive
    release-manifest.json                       components, hashes, sizes and build facts

Build host needs: macOS on Apple Silicon, Xcode command line tools (swiftc, codesign),
Bun 1.4.4, Python 3, network access for the first fetch, and the build-only Python package
PySquashfsImage==0.9.0. None of those is needed to install or run the result.

Every external input is pinned by SHA-256 in release/inputs.lock.json. The archive is written
with sorted entries and fixed timestamps, so the same tree produces the same bytes. The
Swift VM owner is compiled on the build host and is not bit-for-bit reproducible, so two
builds from one commit have different archive hashes; the checksum identifies one build.
"""

from __future__ import annotations

import argparse
import datetime
import gzip
import hashlib
import io
import json
import mmap
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / "release"
LOCK = json.loads((RELEASE / "inputs.lock.json").read_text())["inputs"]
RUNTIME_PINS = json.loads((RELEASE / "runtime-pins.json").read_text())["runtimes"]
FFMPEG_MARKERS = (b"avcodec", b"avformat", b"swscale", b"swresample", b"libavutil", b"FFmpeg")
IMAGE_SHA256 = json.loads((RELEASE / "inputs.lock.json").read_text())["derived"]["alpine/Image"]
GUEST_USER_SESSION_MS = 1_740_000  # guest ends its session here, saves, then the host deadline
HOST_VM_DEADLINE_MS = 1_800_000  # applies; the guest deadline must stay below this one
MODULE = "usr/lib/modules/6.18.60-0-virt/kernel/drivers/block/virtio_blk.ko"
VSOCK_DIR = "/modules/6.18.60-0-virt/kernel/net/vmw_vsock"
VSOCK_MODULES = {
    "vsock.ko": "07c2ad0baeffec03c653601cbd5eae0f925b1b1245e0072d8c5318fb65c0f945",
    "vmw_vsock_virtio_transport_common.ko": "0e5f16787d6aff1e62c30ecf456e7a206d397150a2d186c4de35ed8584004fea",
    "vmw_vsock_virtio_transport.ko": "a46ce5b1aa6b54d55dbc3406c6f4a38e30bce9c4b9d3ca3b21ccccd5fed8a19c",
}
SOURCE_DATE = 1_700_000_000  # fixed timestamp for archive members


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(command, **kwargs):
    return subprocess.run([str(part) for part in command], check=True, **kwargs)


def capture(command, **kwargs) -> str:
    return subprocess.check_output([str(part) for part in command], text=True, **kwargs).strip()


def fetch_inputs(cache: Path) -> dict[str, Path]:
    cache.mkdir(parents=True, exist_ok=True)
    found: dict[str, Path] = {}
    for name, spec in LOCK.items():
        target = cache / name.replace("/", "__")
        if not target.exists() or sha256_file(target) != spec["sha256"]:
            print(f"fetching {name}", flush=True)
            partial = target.with_suffix(target.suffix + ".partial")
            with urllib.request.urlopen(spec["url"], timeout=300) as response, partial.open("wb") as out:
                shutil.copyfileobj(response, out)
            partial.replace(target)
        actual = sha256_file(target)
        if actual != spec["sha256"]:
            raise SystemExit(f"input {name} has SHA-256 {actual}, expected {spec['sha256']}")
        found[name] = target
    return found


def npm_member(tarball: Path, member: str, destination: Path, expected: str | None) -> None:
    with tarfile.open(tarball) as archive:
        source = archive.extractfile(member)
        if source is None:
            raise SystemExit(f"{tarball.name} has no member {member}")
        with destination.open("wb") as out:
            shutil.copyfileobj(source, out)
    destination.chmod(0o755)
    if expected is not None and sha256_file(destination) != expected:
        raise SystemExit(f"{member} from {tarball.name} does not match its pinned digest")


def runtime_binary(runtime_dir: Path, name: str, destination: Path) -> str:
    """Copy a rebuilt OpenCode runtime after proving it is the pinned one and has no FFmpeg."""
    source = runtime_dir / name
    if not source.is_file():
        raise SystemExit(f"{source} is missing; build it with release/NOFFMPEG_RUNTIME.md or pass --runtime-dir")
    digest = sha256_file(source)
    if digest != RUNTIME_PINS[name]:
        raise SystemExit(f"{name} has SHA-256 {digest}, expected {RUNTIME_PINS[name]} (release/runtime-pins.json)")
    # A pin is not a licence check: look inside the bytes, so a stock binary can never ship by accident.
    with source.open("rb") as handle, mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ) as data:
        for marker in FFMPEG_MARKERS:
            if data.find(marker) != -1:
                raise SystemExit(f"{name} contains the FFmpeg marker {marker!r}; refusing to package it")
    shutil.copyfile(source, destination)
    destination.chmod(0o755)
    return digest


def check_clean_tree(allow_dirty: bool) -> str:
    status = capture(["git", "status", "--porcelain"], cwd=ROOT)
    if status and not allow_dirty:
        raise SystemExit("the working tree has uncommitted changes; commit them or pass --allow-dirty")
    return capture(["git", "rev-parse", "HEAD"], cwd=ROOT) + ("+dirty" if status else "")


def build_guest(work: Path, inputs: dict[str, Path], bundle_dir: Path, runtime_dir: Path) -> tuple[Path, Path]:
    """Return the kernel Image and the initramfs."""
    guest = work / "guest"
    guest.mkdir()
    wrapped = inputs["alpine/vmlinuz-virt"].read_bytes()
    image = work / "Image"
    image.write_bytes(zlib.decompress(wrapped[51832:], wbits=31))
    if sha256_file(image) != IMAGE_SHA256:
        raise SystemExit("the extracted kernel Image does not match its pinned digest")
    run(["/usr/bin/bsdtar", "-xf", inputs["alpine/minirootfs"], "-C", guest])
    (guest / "virtio_blk.ko").write_bytes(
        subprocess.check_output(["/usr/bin/bsdtar", "-xOf", str(inputs["alpine/initramfs-virt"]), MODULE])
    )
    for name in ("libgcc", "libstdc++", "ncurses-terminfo-base", "readline", "libncursesw"):
        run(["/usr/bin/bsdtar", "-xf", inputs[f"alpine/{name}.apk"], "-C", guest,
             "--exclude", ".SIGN.*", "--exclude", ".PKGINFO"])
    run(["/usr/bin/bsdtar", "-xf", inputs["alpine/socat.apk"], "-C", guest, "usr/bin/socat", "usr/bin/socat1"])

    opt = guest / "opt"
    opt.mkdir(exist_ok=True)
    runtime_binary(runtime_dir, "opencode-linux-arm64-musl", opt / "opencode")
    npm_member(inputs["guest/bun.tgz"], LOCK["guest/bun.tgz"]["member"], opt / "bun",
               LOCK["guest/bun.tgz"]["member_sha256"])

    # The vsock modules come from the pinned modloop SquashFS.
    try:
        from PySquashfsImage import SquashFsImage
    except ImportError as error:
        raise SystemExit("build needs PySquashfsImage==0.9.0 (pip install PySquashfsImage==0.9.0)") from error
    extracted = opt / "bw-vsock"
    extracted.mkdir()
    with SquashFsImage.from_file(inputs["alpine/modloop-virt"]) as modloop:
        for entry in modloop:
            if entry.name not in VSOCK_MODULES or entry.path != f"{VSOCK_DIR}/{entry.name}":
                continue
            data = entry.read_bytes()
            if hashlib.sha256(data).hexdigest() != VSOCK_MODULES[entry.name]:
                raise SystemExit(f"unexpected guest vsock module {entry.name}")
            (extracted / entry.name).write_bytes(data)
    if {module.name for module in extracted.iterdir()} != set(VSOCK_MODULES):
        raise SystemExit("incomplete guest vsock module set")

    # Guest copy of Bashwink: the same CLI, built as a guest so its banner says so.
    shutil.copytree(bundle_dir, opt / "bashwink")
    shutil.copyfile(ROOT / "fixtures/native-offline/vm-project-guest.ts", opt / "vm-project-guest.ts")
    run_user = (RELEASE / "guest/run-user.sh").read_text().replace("@SESSION_GUEST_MS@", str(GUEST_USER_SESSION_MS))
    (opt / "run-user").write_text(run_user)
    shutil.copyfile(RELEASE / "guest/project-heartbeat.sh", opt / "project-heartbeat")
    shutil.copyfile(RELEASE / "guest/init.sh", guest / "init")
    for executable in ("run-user", "project-heartbeat"):
        (opt / executable).chmod(0o755)
    (guest / "init").chmod(0o755)

    # Deterministic cpio: sorted names, sequential inodes, root-owned, fixed times.
    initramfs = work / "initramfs"
    write_newc(guest, initramfs)
    return image, initramfs


def write_newc(root: Path, destination: Path) -> None:
    """Deterministic cpio "newc" archive of `root`: sorted names, sequential inodes, root-owned, fixed times.

    The system cpio records the build directory's inode numbers, so two builds of the same tree
    differ. Nothing here depends on the filesystem except names, modes, sizes and contents.
    """
    def field(value: int) -> bytes:
        return b"%08X" % value

    def pad(length: int) -> bytes:
        return b"\0" * (-length % 4)

    entries = [root] + sorted(root.rglob("*"), key=lambda p: str(p.relative_to(root)))
    with destination.open("wb") as out:
        for inode, path in enumerate(entries, start=1):
            name = b"." if path == root else str(path.relative_to(root)).encode()
            status = path.lstat()
            if path.is_symlink():
                data = os.readlink(path).encode()
            elif path.is_file():
                data = path.read_bytes()
            else:
                data = b""
            mode = status.st_mode & 0o170777
            header = (b"070701" + field(inode) + field(mode) + field(0) + field(0) + field(1) + field(SOURCE_DATE)
                      + field(len(data)) + field(0) + field(0) + field(0) + field(0) + field(len(name) + 1) + field(0))
            out.write(header + name + b"\0" + pad(110 + len(name) + 1) + data + pad(len(data)))
        trailer = b"TRAILER!!!"
        out.write(b"070701" + field(0) * 4 + field(1) + field(0) * 8 + field(len(trailer) + 1) + field(0)
                  + trailer + b"\0" + pad(110 + len(trailer) + 1))


def build_cli_bundle(out_file: Path, defines: dict[str, str], bun: str) -> None:
    command = [bun, "build", ROOT / "packages/bw-cli/src/bin.ts", "--target=bun", "--outfile", out_file]
    for key, value in defines.items():
        command += ["--define", f"{key}={value}"]
    run(command, stdout=subprocess.DEVNULL)


def stage_evidence_plugin(destination: Path) -> None:
    shutil.copytree(ROOT / "packages/bw-evidence", destination,
                    ignore=shutil.ignore_patterns("node_modules", "test", ".turbo"))
    peer = (ROOT / "node_modules/@opencode/plugin").resolve()
    target = destination / "node_modules/@opencode/plugin"
    target.parent.mkdir(parents=True)
    shutil.copytree(peer, target, symlinks=False)


def write_archive(tree: Path, archive: Path, top: str) -> None:
    """Gzip tar with sorted entries and normalized metadata."""
    entries = sorted(tree.rglob("*"), key=lambda p: str(p.relative_to(tree)))
    with archive.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as tar:
                def add(path: Path, arcname: str) -> None:
                    info = tar.gettarinfo(str(path), arcname)
                    info.uid = info.gid = 0
                    info.uname = info.gname = ""
                    info.mtime = SOURCE_DATE
                    if info.isdir():
                        info.mode = 0o755
                        tar.addfile(info)
                    elif info.issym():
                        tar.addfile(info)
                    else:
                        info.mode = 0o755 if (path.stat().st_mode & 0o111) else 0o644
                        with path.open("rb") as handle:
                            tar.addfile(info, handle)
                add(tree, top)
                for path in entries:
                    add(path, f"{top}/{path.relative_to(tree)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--cache", type=Path, default=Path.home() / ".cache/bashwink-release-inputs")
    parser.add_argument("--bun", default=shutil.which("bun") or "bun")
    parser.add_argument("--allow-dirty", action="store_true")
    parser.add_argument("--runtime-dir", type=Path, default=Path.home() / ".cache/bashwink-release-inputs/runtime-nofmpeg",
                        help="directory holding the no-FFmpeg OpenCode builds named in release/runtime-pins.json")
    args = parser.parse_args()

    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise SystemExit("the release is built on macOS Apple Silicon")
    bun_version = capture([args.bun, "--version"])
    if bun_version != "1.4.4":
        raise SystemExit(f"Bun 1.4.4 is pinned; found {bun_version}")
    version = json.loads((ROOT / "packages/bw-cli/package.json").read_text())["version"]
    commit = check_clean_tree(args.allow_dirty)
    top = f"bashwink-{version}-macos-arm64"
    out = args.out.resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    started = datetime.datetime.now(datetime.timezone.utc)
    # The manifest inside the archive carries the commit's time, not the wall clock, so that the same
    # commit and inputs produce the same archive.
    committed = datetime.datetime.fromtimestamp(
        int(capture(["git", "show", "-s", "--format=%ct", "HEAD"], cwd=ROOT)), datetime.timezone.utc)

    inputs = fetch_inputs(args.cache)
    work = Path(tempfile.mkdtemp(prefix="bw-release-build-"))
    tree = work / top
    try:
        # 1. Guest CLI bundle (runs inside the VM; never a release host bundle).
        guest_bundle = work / "guest-bundle"
        guest_bundle.mkdir()
        build_cli_bundle(guest_bundle / "bashwink.js", {"__BASHWINK_GUEST__": "true"}, args.bun)
        (guest_bundle / "version.json").write_text(json.dumps({"version": version, "build": commit[:12]}) + "\n")
        stage_evidence_plugin(guest_bundle / "evidence")

        # 2. Guest image.
        image, initramfs = build_guest(work, inputs, guest_bundle, args.runtime_dir.resolve())

        # 3. VM owner: compiled here, signed ad hoc with only the virtualization entitlement.
        owner = work / "vm-owner"
        entitlements = work / "entitlements.plist"
        entitlements.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>'
            "<key>com.apple.security.virtualization</key><true/></dict></plist>\n")
        run(["swiftc", "-module-cache-path", work / "swift-cache",
             ROOT / "packages/bw-cli/native/macos-vm-owner.swift", "-o", owner])
        run(["codesign", "--force", "--sign", "-", "--entitlements", entitlements, owner])

        # 4. Lay out the tree.
        for directory in ("bin", "lib/offline-vm", "libexec", "share/doc", "share/licenses"):
            (tree / directory).mkdir(parents=True)
        for name, source in (("vm-owner", owner), ("Image", image), ("initramfs", initramfs)):
            shutil.copyfile(source, tree / "lib/offline-vm" / name)
            (tree / "lib/offline-vm" / name).chmod(0o755 if name == "vm-owner" else 0o644)
        manifest_bytes = (json.dumps({
            "version": 2,
            "relay": True,
            "sha256": {name: sha256_file(tree / "lib/offline-vm" / name) for name in ("vm-owner", "Image", "initramfs")},
        }, sort_keys=True) + "\n").encode()
        (tree / "lib/offline-vm.json").write_bytes(manifest_bytes)
        manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()

        # 5. Host release bundle, pinned to exactly those assets and to the qualified hosts.
        qualified = json.loads((RELEASE / "qualified-hosts.json").read_text())
        qualified_json = json.dumps([{"version": h["version"], "build": h["build"]} for h in qualified])
        build_cli_bundle(tree / "lib/bashwink.js", {
            "__BASHWINK_RELEASE__": "true",
            "__BASHWINK_ASSET_MANIFEST_SHA256__": json.dumps(manifest_digest),
            "__BASHWINK_QUALIFIED_HOSTS__": json.dumps(qualified_json),
        }, args.bun)
        (tree / "lib/version.json").write_text(json.dumps({"version": version, "build": commit[:12]}) + "\n")
        stage_evidence_plugin(tree / "lib/evidence")

        # 6. Host runtimes (Bun for the CLI; OpenCode only for the explicit unrestricted mode).
        npm_member(inputs["host/bun.tgz"], LOCK["host/bun.tgz"]["member"], tree / "libexec/bun", None)
        runtime_binary(args.runtime_dir.resolve(), "opencode-darwin-arm64", tree / "libexec/opencode")

        # 7. Launcher, installers, metadata.
        shutil.copyfile(RELEASE / "launcher.sh", tree / "bin/bashwink")
        (tree / "bin/bashwink").chmod(0o755)
        for script in ("install.sh", "uninstall.sh"):
            text = (RELEASE / script).read_text().replace("@VERSION@", version)
            (tree / script).write_text(text)
            (tree / script).chmod(0o755)
        (tree / "VERSION").write_text(version + "\n")
        (tree / "qualified-hosts.json").write_text(
            "[\n" + ",\n".join(
                f'  {{ "version": "{h["version"]}", "build": "{h["build"]}", "arch": "{h["arch"]}", "tier": "{h["tier"]}" }}'
                for h in qualified) + "\n]\n")
        # install.sh greps for the exact "version": "x", "build": "y" spelling above.
        shutil.copyfile(RELEASE / "runtime-pins.json", tree / "share/doc/runtime-pins.json")
        shutil.copyfile(RELEASE / "NOFFMPEG_RUNTIME.md", tree / "share/doc/NOFFMPEG_RUNTIME.md")
        for doc in ("README.md", "ALPHA_TESTER_GUIDE.md", "RELEASE_NOTES.md", "KNOWN_LIMITATIONS.md", "SECURITY.md"):
            source = RELEASE / "docs" / doc
            if source.exists():
                shutil.copyfile(source, tree / "share/doc" / doc)
        shutil.copyfile(ROOT / "LICENSE", tree / "share/licenses/BASHWINK-LICENSE")
        notices = RELEASE / "THIRD_PARTY_NOTICES.txt"
        guest_notices = RELEASE / "NOTICES_GUEST.txt"
        if not notices.exists() or not guest_notices.exists():
            raise SystemExit("release/THIRD_PARTY_NOTICES.txt and release/NOTICES_GUEST.txt are required")
        (tree / "share/licenses/THIRD_PARTY_NOTICES.txt").write_text(notices.read_text() + guest_notices.read_text())
        shutil.copyfile(RELEASE / "inputs.lock.json", tree / "share/doc/inputs.lock.json")

        sizes = {name: (tree / "lib/offline-vm" / name).stat().st_size for name in ("vm-owner", "Image", "initramfs")}
        release_manifest = {
            "schema": 1,
            "version": version,
            "candidate_commit": commit,
            "target": "macos-arm64",
            "built_at": committed.isoformat(),
            "build_host": {
                "macos": capture(["sw_vers", "-productVersion"]),
                "build": capture(["sysctl", "-n", "kern.osversion"]),
                "arch": platform.machine(),
                "swiftc": capture(["swiftc", "--version"]).splitlines()[0],
                "bun": bun_version,
            },
            "vm_assets": {"manifest_sha256": manifest_digest, "sizes": sizes,
                          "sha256": json.loads(manifest_bytes)["sha256"]},
            "runtime_hashes": {
                "guest_opencode": RUNTIME_PINS["opencode-linux-arm64-musl"],
                "guest_bun": LOCK["guest/bun.tgz"]["member_sha256"],
                "host_bun": sha256_file(tree / "libexec/bun"),
                "host_opencode": sha256_file(tree / "libexec/opencode"),
                "cli_bundle": sha256_file(tree / "lib/bashwink.js"),
            },
            "qualified_hosts": qualified,
            "vm_deadlines_ms": {"host": HOST_VM_DEADLINE_MS, "guest": GUEST_USER_SESSION_MS},
            "inputs": {name: {"url": spec["url"], "sha256": spec["sha256"], "license": spec["license"]}
                       for name, spec in LOCK.items()},
        }
        (tree / "RELEASE_MANIFEST.json").write_text(json.dumps(release_manifest, indent=2, sort_keys=True) + "\n")

        # 8. Per-file checksums, then the archive.
        lines = []
        for path in sorted(p for p in tree.rglob("*") if p.is_file() and not p.is_symlink()):
            relative = path.relative_to(tree)
            if str(relative) == "MANIFEST.sha256":
                continue
            lines.append(f"{sha256_file(path)}  {relative}")
        (tree / "MANIFEST.sha256").write_text("\n".join(lines) + "\n")

        archive = out / f"{top}.tar.gz"
        write_archive(tree, archive, top)
        digest = sha256_file(archive)
        (out / "SHA256SUMS").write_text(f"{digest}  {archive.name}\n")
        installed = sum(p.stat().st_size for p in tree.rglob("*") if p.is_file())
        release_manifest["archive"] = {"name": archive.name, "sha256": digest, "bytes": archive.stat().st_size,
                                       "installed_bytes": installed}
        (out / "release-manifest.json").write_text(json.dumps(release_manifest, indent=2, sort_keys=True) + "\n")
        print(f"archive   {archive}")
        print(f"sha256    {digest}")
        print(f"size      {archive.stat().st_size} bytes (installed ~{installed} bytes)")
        print(f"commit    {commit}")
        print(f"manifest  {manifest_digest}")
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
