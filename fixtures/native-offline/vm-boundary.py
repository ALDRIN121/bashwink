#!/usr/bin/env python3
"""Run a Docker-free VZ test against pre-fetched Alpine 3.23.8 arm64 fixture inputs."""
import argparse
import fcntl
import hashlib
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
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


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def wait_for(test, vm):
    for _ in range(300):
        result = test()
        if result:
            return result
        assert vm.poll() is None, f"VM owner exited with {vm.returncode}"
        time.sleep(0.1)
    raise AssertionError("timed out waiting for a guest observation")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("alpine", type=Path, help="directory containing the three pinned inputs")
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
    init = (FILES / "vm-guest.sh").read_text().replace("@CANARY@", str(protected))
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

    def marker():
        with disk.open("rb") as image:
            result = re.match(rb"[0-9]+", image.read(64))
        return int(result[0]) if result else 0

    for label, stop_signal, expected_exit in (
        ("forced-stop", signal.SIGUSR1, 0),
        ("owner-kill", signal.SIGKILL, -9),
        ("reopened-after-kill", signal.SIGUSR1, 0),
    ):
        previous = marker()
        log = root / f"{label}.log"
        started = time.monotonic()
        with log.open("wb") as output:
            with subprocess.Popen(
                [runner, image, root / "initramfs", disk],
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
                    vm.send_signal(stop_signal)
                    assert vm.wait(timeout=10) == expected_exit
                finally:
                    if vm.poll() is None:
                        vm.kill()
        if stop_signal == signal.SIGUSR1:
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
