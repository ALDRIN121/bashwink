#!/usr/bin/env python3
"""Run a Docker-free VZ test against pre-fetched Alpine 3.23.8 arm64 fixture inputs."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import zlib


FILES = Path(__file__).resolve().parent
MODULE = "usr/lib/modules/6.18.60-0-virt/kernel/drivers/block/virtio_blk.ko"
CHECKSUMS = {
    "vmlinuz": "4ac63d06e6cf5820905ffa7741292cfbe90fb0cf1edba4c42e871f6daf699437",
    "root.tar.gz": "3f1bd6811370264cc363bb991ff15ac67621b239ea6e25ff2eb22af3d0641473",
    "initramfs-official": "a497b544282f1e0558e03529ce99d515aabdf3cea06011fbbcc48604f482cacc",
}
OPENCODE_INPUTS = {
    "opencode": "0e214ccebc6f0dd8775be65104b8a9de0585427b8911ad838c9fd83d1c812e2d",
    "bun": "a6a3d99a48600b59597070d2d2ff8d37b65975b8aab247ee3479b1eb33d000a6",
    "libgcc.apk": "eaaafda78fde1c904e1741680ddea91649f051e29a343152c8a4327605704b0f",
    "libstdc++.apk": "10d72e25f6fcc0f3d9fdd801c9bdaed81d6e836aa2b65b63f25d2d97f860a7d1",
    "ncurses-terminfo-base.apk": "6952a6b39abaf7bbc498cb085f0f59bf23619b53b3f7328b08fe50c0198a2bd4",
}


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def wait_for(test, vm):
    for _ in range(300):
        result = test()
        if result:
            return result
        assert vm.poll() is None, f"VM owner exited with {vm.returncode}"
        time.sleep(0.1)
    raise AssertionError("timed out waiting for a guest observation")


LAUNCH_WITH_LEASE = """
import os, subprocess, sys
readable, writable = os.pipe()
try:
    owner = subprocess.Popen([*sys.argv[1:], str(readable)], pass_fds=(readable,))
    os.close(readable)
    raise SystemExit(owner.wait())
finally:
    os.close(writable)
"""


def prepare_opencode(root, guest, inputs):
    for name, expected in OPENCODE_INPUTS.items():
        assert digest(inputs / name) == expected, f"unexpected guest runtime input {name}"
        if name.endswith(".apk"):
            subprocess.run(["bsdtar", "-xf", inputs / name, "-C", guest,
                            "--exclude", ".SIGN.*", "--exclude", ".PKGINFO"], check=True)
    opt = guest / "opt"
    opt.mkdir(exist_ok=True)
    for name in ("bun", "opencode"):
        shutil.copyfile(inputs / name, opt / name)
        (opt / name).chmod(0o755)
    build = root / "bashwink"
    subprocess.run([FILES.parents[1] / "scripts/build_alpha.sh", build], check=True)
    shutil.copytree(build / "lib", opt / "bashwink")
    config = json.loads((FILES.parent / "opencode.json").read_text())
    config["model"] = "bashwink-mock/mock-tool-model"
    (opt / "opencode-fixture.json").write_text(json.dumps(config))
    shutil.copyfile(FILES / "vm-opencode-mock.ts", opt / "mock.ts")
    shutil.copyfile(FILES / "vm-opencode-user.sh", opt / "run-user")
    (opt / "run-user").chmod(0o755)
    return (FILES / "vm-opencode-init.sh").read_text()


def read_fixture_stage(sector):
    def unique(pairs):
        result = dict(pairs)
        if len(result) != len(pairs):
            raise ValueError("duplicate VM fixture stage key")
        return result

    if len(sector) != 512:
        raise ValueError("unexpected VM fixture stage size")
    record = json.loads(sector.rstrip(b"\0"), object_pairs_hook=unique)
    expected = {"task.txt", "shell-result.txt"}
    if not isinstance(record, dict) or set(record) != {"version", "files"} or record["version"] != 1:
        raise ValueError("invalid VM fixture stage record")
    files = record["files"]
    if not isinstance(files, dict) or set(files) != expected:
        raise ValueError("unexpected VM fixture stage inventory")
    contents = {}
    for name, entry in files.items():
        if (not isinstance(entry, dict) or set(entry) != {"data", "sha256"}
                or not isinstance(entry["data"], str)):
            raise ValueError("invalid VM fixture stage entry")
        data = base64.b64decode(entry["data"], validate=True)
        if hashlib.sha256(data).hexdigest() != entry["sha256"]:
            raise ValueError("VM fixture stage digest mismatch")
        contents[name] = data
    return contents


def exercise_opencode(root, arguments, disk):
    log = root / "opencode-pty.log"
    disk_id = (disk.stat().st_dev, disk.stat().st_ino)
    with log.open("wb") as output:
        with subprocess.Popen([*arguments, "--serial-input"], stdin=subprocess.PIPE,
                              stdout=output, stderr=subprocess.STDOUT) as vm:
            def observed(text):
                output = log.read_bytes()
                assert b"Kernel panic" not in output, f"guest init failed, see {log}"
                return text in output

            def send(data):
                vm.stdin.write(data)
                vm.stdin.flush()

            try:
                wait_for(lambda: observed(b"Ask anything"), vm)
                send(b"Fix the disposable VM task")
                time.sleep(0.15)
                send(b"\r")
                approved = set()

                def completed():
                    assert b"Kernel panic" not in log.read_bytes(), f"guest init failed, see {log}"
                    console = log.read_bytes()
                    for step in (0, 1):
                        marker = f"BW_VM_TOOL_{step}".encode()
                        if step not in approved and marker in console:
                            if b"Allow once" in console.rsplit(marker, 1)[1]:
                                send(b"\r")
                                approved.add(step)
                    return b"VM fixture tool sequence completed" in console

                wait_for(completed, vm)
                assert 1 in approved, "the shell request did not get an interactive approval"
                send(b"\x04")
                wait_for(lambda: observed(b"BW_VM_OPENCODE_PASS"), vm)
                vm.send_signal(signal.SIGUSR1)
                assert vm.wait(timeout=10) == 0
            finally:
                if vm.poll() is None:
                    vm.kill()
    assert b"HOST_VM_STOPPED" in log.read_bytes()
    with disk.with_suffix(".raw.lock").open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with disk.open("rb") as stage:
            info = os.fstat(stage.fileno())
            assert (info.st_dev, info.st_ino) == disk_id
            sector = stage.read(512)
    assert read_fixture_stage(sector) == {
        "task.txt": b"VM fixture edit\n",
        "shell-result.txt": b"VM shell ran\n",
    }
    bad_digest = hashlib.sha256(b"VM fixture edit\n").hexdigest().encode()
    for corrupted in (sector.replace(b'"task.txt"', b'"../other"'),
                      sector.replace(bad_digest, b"0" * 64)):
        assert corrupted != sector
        try:
            read_fixture_stage(corrupted)
        except ValueError:
            pass
        else:
            raise AssertionError("fixture stage reader accepted an invalid inventory or digest")
    print("PASS: pinned OpenCode rendered, streamed, edited and ran an approved shell tool in the NIC-free VM")
    print("PASS: host inspected the exact result on the retired disk without mounting it")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("alpine", type=Path, help="directory containing the three pinned inputs")
    parser.add_argument("--opencode-inputs", type=Path, help="run the separate pinned OpenCode PTY fixture")
    args = parser.parse_args()
    alpine = args.alpine.resolve()
    for name, expected in CHECKSUMS.items():
        assert digest(alpine / name) == expected, f"unexpected test input {name}"
    root = Path(tempfile.mkdtemp(prefix="bw-vm-boundary-")).resolve()
    print(f"VM fixture output: {root}", flush=True)
    protected = root / "protected.txt"
    protected.write_text("Unrelated host fixture\n")
    protected_hash = digest(protected)
    localhost = socket.socket()
    localhost.bind(("127.0.0.1", 0))
    localhost.listen()
    localhost.settimeout(0.2)
    with socket.create_connection(localhost.getsockname()), localhost.accept()[0]:
        pass

    guest = root / "guest"
    # Alpine's arm64 EFI wrapper embeds the raw Linux Image in a gzip member.
    wrapped = (alpine / "vmlinuz").read_bytes()
    image = root / "Image"
    image.write_bytes(zlib.decompress(wrapped[51832:], wbits=31))
    assert digest(image) == "acb635444e1e736363865c903225e739010ad79e1db51caa17b8f6aa363124a6"
    guest.mkdir()
    subprocess.run(["bsdtar", "-xf", alpine / "root.tar.gz", "-C", guest], check=True)
    (guest / "virtio_blk.ko").write_bytes(subprocess.check_output(
        ["bsdtar", "-xOf", alpine / "initramfs-official", MODULE]
    ))
    init = (prepare_opencode(root, guest, args.opencode_inputs.resolve())
            if args.opencode_inputs else (FILES / "vm-guest.sh").read_text())
    init = init.replace("@CANARY@", str(protected))
    init = init.replace("@PORT@", str(localhost.getsockname()[1]))
    (guest / "init").write_text(init)
    (guest / "init").chmod(0o755)
    with (root / "initramfs").open("wb") as output:
        names = b".\0" + b"".join(os.fsencode(str(p.relative_to(guest))) + b"\0"
                                    for p in guest.rglob("*"))
        subprocess.run(
            ["/usr/bin/cpio", "-0", "-o", "-H", "newc"], cwd=guest, input=names,
            stdout=output, check=True,
        )
    runner = root / "vm-boundary"
    entitlements = root / "entitlements.plist"
    entitlements.write_text('''<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>com.apple.security.virtualization</key><true/></dict></plist>''')
    subprocess.run(["swiftc", "-module-cache-path", root / "swift-cache",
                    FILES / "vm-boundary.swift", "-o", runner], check=True)
    subprocess.run(["codesign", "--force", "--sign", "-", "--entitlements", entitlements,
                    runner], check=True)
    disk = root / "stage.raw"
    with disk.open("wb") as output:
        output.truncate(8 * 1024 * 1024)
    disk_id = (disk.stat().st_dev, disk.stat().st_ino)
    lock = disk.with_suffix(".raw.lock")
    lock.touch(mode=0o600, exist_ok=False)
    arguments = [runner, image, root / "initramfs", disk]
    if args.opencode_inputs:
        exercise_opencode(root, arguments, disk)
        assert protected_hash == digest(protected)
        localhost.close()
        return

    def marker():
        with disk.open("rb") as image:
            result = re.match(rb"[0-9]+", image.read(64))
        return int(result[0]) if result else 0

    for label, stop_signal, expected_exit in (
        ("forced-stop", signal.SIGUSR1, 0),
        ("owner-kill", signal.SIGKILL, -9),
        ("reopened-after-kill", signal.SIGUSR1, 0),
        ("launcher-kill", signal.SIGKILL, -9),
        ("reopened-after-launcher-kill", signal.SIGUSR1, 0),
        ("interrupt", signal.SIGINT, 130),
        ("timeout", None, 124),
    ):
        previous = marker()
        log = root / f"{label}.log"
        started = time.monotonic()
        separate_launcher = label == "launcher-kill"
        launch = [sys.executable, "-c", LAUNCH_WITH_LEASE, *arguments] if separate_launcher else arguments
        if stop_signal is None:
            launch = [*arguments, "--timeout-ms=4000"]
        with log.open("wb") as output:
            with subprocess.Popen(
                launch,
                stdout=output, stderr=subprocess.STDOUT,
            ) as vm:
                try:
                    wait_for(lambda: b"DETACHED_OK" in log.read_bytes(), vm)
                    wait_for(lambda: marker() >= previous + 3, vm)
                    assert f"APPROVED previous={previous}".encode() in log.read_bytes()
                    assert b"HOST_WRITE_DENIED" in log.read_bytes()
                    assert b"NETWORK_DENIED" in log.read_bytes()
                    second = subprocess.run([runner, image, root / "initramfs", disk], timeout=10)
                    assert second.returncode == 8, "another VM could open the live fixture disk"
                    print(f"Guest detached-writer control ready after {time.monotonic() - started:.2f}s")
                    if stop_signal is not None:
                        vm.send_signal(stop_signal)
                    assert vm.wait(timeout=10) == expected_exit
                finally:
                    if vm.poll() is None:
                        vm.kill()
        if separate_launcher:
            for _ in range(100):
                if b"HOST_VM_STOPPED" in log.read_bytes():
                    break
                time.sleep(0.05)
            else:
                raise AssertionError("VM owner did not confirm stop after launcher death")
        elif stop_signal != signal.SIGKILL:
            assert b"HOST_VM_STOPPED" in log.read_bytes()
        with lock.open("rb") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert (disk.stat().st_dev, disk.stat().st_ino) == disk_id
        closed = marker()
        assert closed >= previous + 3
        for _ in range(8):
            time.sleep(0.25)
            assert marker() == closed
        assert protected_hash == digest(protected)
        try:
            localhost.accept()[0].close()
        except TimeoutError:
            pass
        else:
            raise AssertionError("guest reached the host listener")
        print(f"PASS: {label} exit {expected_exit}, detached writer stopped at {closed}", flush=True)
    localhost.close()


if __name__ == "__main__":
    main()
