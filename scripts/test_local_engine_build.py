#!/usr/bin/env python3
"""Manifest tests for the locally built engine (Task 3).

The plan requires these cases to be observed **failing before the build is wired**, so the module
under test starts out absent. Run this before `scripts/build_local_engine.py` exists and every case
fails with "builder not implemented"; that failure is the proof the tests are load-bearing rather
than written to match whatever the builder happened to do.

What is under test is the *manifest and its refusals*, not the lexer of a shell script:

- an unsupported target is refused by name, not silently built for the host;
- a missing input is refused rather than replaced by a download;
- a digest mismatch is refused rather than trusted;
- a PTY that is not the locally built one is refused, including one that merely sits on PATH;
- a path escaping the build root is refused **after** symlink resolution, because checking the
  string alone lets `build/engine/x/../../../etc/passwd` pass;
- a published-runtime download fallback is refused outright.

The last two are the ones worth having. A builder that resolves a symlink before checking
containment, or that falls back to downloading a published OpenCode when the local build fails,
would satisfy a naive digest check and still ship a runtime nobody built.
"""

from __future__ import annotations

import hashlib
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "scripts"))


def load_builder():
    """Import the builder, or fail with the plan's own wording when it is not written yet."""
    try:
        return importlib.import_module("build_local_engine")
    except ModuleNotFoundError as exc:
        raise AssertionError(
            "builder not implemented: scripts/build_local_engine.py does not exist. "
            "Task 3 requires the manifest tests to fail before the build is wired."
        ) from exc


class FfmpegLibraryTest(unittest.TestCase):
    """The stock registry library must be refused, and the no-FFmpeg build accepted.

    This is the licensing-adjacent check with teeth. A builder that only asked "is there a
    .dylib?" would accept the stock registry package — measured at 38 `avcodec`, 48 `libav`,
    15 `avformat` markers — and ship FFmpeg under a notice file that claims it was removed.
    """

    def test_stock_library_with_ffmpeg_markers_is_refused(self):
        mod = load_builder()
        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp) / "libopentui.dylib"
            lib.write_bytes(b"\x00\x01" + b"avcodec" + b"\x00avformat\x00swscale\x00")
            self.assertEqual(
                mod.ffmpeg_markers(lib),
                {"avcodec", "avformat", "swscale"},
            )

    def test_clean_library_reports_no_markers(self):
        mod = load_builder()
        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp) / "libopentui.dylib"
            lib.write_bytes(b"\x00\x01opentui\x00renderer\x00")
            self.assertEqual(mod.ffmpeg_markers(lib), set())

    def test_vendored_library_on_disk_is_the_clean_rebuild(self):
        """Whatever is installed in the platform package must be FFmpeg-free.

        This test used to assert the *stock* library was detectable, which was true before the
        no-FFmpeg rebuild replaced it. The durable invariant is the opposite direction: the library
        the build will actually consume must scan clean, because that is the condition Gate D
        depends on. Skipped rather than passed when the package is absent — a green result from not
        looking is the failure this whole class exists to prevent.
        """
        mod = load_builder()
        candidates = sorted(
            (REPO / "vendor" / "engine" / "node_modules" / ".bun").glob(
                "@opentui+core-darwin-arm64@*/node_modules/@opentui/core-darwin-arm64/*.dylib"
            )
        )
        if not candidates:
            self.skipTest("no vendored @opentui library installed to scan")
        for library in candidates:
            self.assertEqual(
                mod.ffmpeg_markers(library),
                set(),
                f"{library} still contains FFmpeg markers; the no-FFmpeg rebuild has not been applied",
            )

    def test_no_ffmpeg_rebuild_is_accepted(self):
        """A library with no markers passes, which is what the local rebuild must look like."""
        mod = load_builder()
        with tempfile.TemporaryDirectory() as tmp:
            lib = Path(tmp) / "libopentui.dylib"
            lib.write_bytes(b"\x00opentui\x00vt\x00renderer\x00")
            self.assertEqual(mod.ffmpeg_markers(lib), set())


class UnsupportedTargetTest(unittest.TestCase):
    def test_unknown_target_is_refused_by_name(self):
        mod = load_builder()
        with self.assertRaises(mod.BuildRefused) as caught:
            mod.manifest_for_target("plan9-mips")
        self.assertIn("plan9-mips", str(caught.exception))

    def test_host_target_is_not_substituted_for_an_unsupported_one(self):
        mod = load_builder()
        with self.assertRaises(mod.BuildRefused):
            mod.manifest_for_target("linux-riscv64")
        # The same call must never quietly return the host's target.
        with self.assertRaises(mod.BuildRefused):
            mod.manifest_for_target("")


class MissingInputTest(unittest.TestCase):
    def test_missing_engine_is_refused_not_downloaded(self):
        mod = load_builder()
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(mod.BuildRefused) as caught:
                mod.build(target="darwin-arm64", engine=Path(tmp) / "absent", pty_dir=Path(tmp) / "absent-pty")
            message = str(caught.exception).lower()
            self.assertIn("missing", message)
            # The refusal must not read as an invitation to fetch a published runtime.
            self.assertNotIn("http", message)


class DigestMismatchTest(unittest.TestCase):
    def test_engine_digest_mismatch_is_refused(self):
        mod = load_builder()
        with tempfile.TemporaryDirectory() as tmp:
            engine = Path(tmp) / "opencode"
            engine.write_bytes(b"not the built engine")
            pty = Path(tmp) / "opencode-pty"
            pty.write_bytes(b"helper")
            with self.assertRaises(mod.BuildRefused) as caught:
                mod.build(
                    target="darwin-arm64",
                    engine=engine,
                    pty_dir=Path(tmp),
                    expect_sha256="0" * 64,
                )
            self.assertIn("digest", str(caught.exception).lower())


class NonLocalPtyTest(unittest.TestCase):
    def test_helper_on_path_is_not_accepted(self):
        mod = load_builder()
        with tempfile.TemporaryDirectory() as tmp:
            # A binary called opencode-pty that is *not* the vendored build. If the builder
            # searched PATH it would find this one.
            fake_dir = Path(tmp) / "fake-bin"
            fake_dir.mkdir()
            fake = fake_dir / "opencode-pty"
            fake.write_bytes(b"#!/bin/sh\necho not-the-real-one\n")
            fake.chmod(0o755)
            engine = Path(tmp) / "opencode"
            engine.write_bytes(b"engine")
            old = os.environ.get("PATH", "")
            os.environ["PATH"] = f"{fake_dir}{os.pathsep}{old}"
            try:
                with self.assertRaises(mod.BuildRefused) as caught:
                    mod.build(target="darwin-arm64", engine=engine, pty_dir=Path(tmp) / "no-such-pty")
            finally:
                os.environ["PATH"] = old
            self.assertIn("pty", str(caught.exception).lower())

    def test_registry_pty_package_is_not_an_acceptable_source(self):
        mod = load_builder()
        # The manifest must record where the helper came from, so a reader can tell a local build
        # from a registry package without trusting the file name. The field lives inside `pty`,
        # not at the top level, so the assertion is on the produced manifest rather than on the
        # required-keys tuple.
        manifest = mod.manifest_for_target("darwin-arm64")
        self.assertIn("source", manifest["pty"])
        self.assertIn(manifest["pty"]["source"], mod.PTY_SOURCE_KINDS)
        self.assertNotIn("registry", mod.PTY_SOURCE_KINDS)
        self.assertIn("local-build", mod.PTY_SOURCE_KINDS)
        self.assertNotIn("registry", json.dumps(mod.PTY_SOURCE_KINDS))


class PathContainmentTest(unittest.TestCase):
    def test_traversal_out_of_the_build_root_is_refused(self):
        mod = load_builder()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "build" / "engine" / "darwin-arm64"
            root.mkdir(parents=True)
            (Path(tmp) / "outside.txt").write_text("secret")
            with self.assertRaises(mod.BuildRefused):
                mod.contained_path(root, "../../outside.txt")

    def test_symlink_escaping_the_root_is_refused_after_resolution(self):
        mod = load_builder()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "build" / "engine" / "darwin-arm64"
            root.mkdir(parents=True)
            outside = Path(tmp) / "outside.bin"
            outside.write_bytes(b"secret")
            link = root / "innocent.bin"
            link.symlink_to(outside)
            # The *string* is contained; the resolved path is not. A builder that only checked
            # the string would accept this and copy a file from outside the build root.
            self.assertIn(
                "innocent.bin",
                str(link),
                "precondition: the path string is inside the root",
            )
            with self.assertRaises(mod.BuildRefused) as caught:
                mod.contained_path(root, "innocent.bin")
            self.assertIn("outside", str(caught.exception).lower())

    def test_contained_path_accepts_a_real_child(self):
        mod = load_builder()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            (root / "ok.bin").write_bytes(b"fine")
            self.assertEqual(mod.contained_path(root, "ok.bin"), (root / "ok.bin").resolve())


class DownloadFallbackTest(unittest.TestCase):
    def test_published_runtime_download_is_refused(self):
        mod = load_builder()
        with self.assertRaises(mod.BuildRefused) as caught:
            mod.build(target="darwin-arm64", engine=None, pty_dir=None, allow_download=True)
        self.assertIn("download", str(caught.exception).lower())

    def test_builder_exposes_no_url_fetch_helper(self):
        mod = load_builder()
        # Guards against a future "convenience" helper that reintroduces the fallback.
        names = dir(mod)
        for suspicious in ("download", "fetch_published", "install_from_npm"):
            self.assertNotIn(suspicious, names)


class ManifestShapeTest(unittest.TestCase):
    def test_manifest_records_the_keys_the_plan_names(self):
        mod = load_builder()
        for key in (
            "schemaVersion",
            "target",
            "sourcePins",
            "engine",
            "pty",
            "toolchains",
            "notices",
        ):
            self.assertIn(key, mod.REQUIRED_MANIFEST_KEYS)

    def test_manifest_hash_is_stable_across_key_order(self):
        mod = load_builder()
        a = {"b": 1, "a": 2}
        b = {"a": 2, "b": 1}
        self.assertEqual(mod.manifest_digest(a), mod.manifest_digest(b))


class MissingEngineBeforeInstallTest(unittest.TestCase):
    """`--install` must fail before it touches npm when no usable engine exists.

    The regression this locks down: `--install` used to reach npm with no local engine at all, so it
    installed a package that exits 127 on first launch — and, worse, replaced a working install with
    one that could not start. The ordering (resolve the engine, then install) is the property.
    """

    def setUp(self):
        import build_npm_package as bnp

        self.bnp = bnp
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def _manifest(self, directory: Path, target: str = "darwin-arm64", digest: str = "0" * 64,
                  path_field: str = "opencode") -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "engine-manifest.json").write_text(json.dumps({
            "schemaVersion": 1, "target": target,
            "engine": {"path": path_field, "sha256": digest, "ffmpegMarkers": []},
        }))
        return directory

    def test_no_engine_and_no_build_is_refused(self):
        with self.assertRaises(SystemExit) as caught:
            self.bnp.resolve_engine_input(self.root / "absent", "darwin-arm64", allow_build=False)
        message = str(caught.exception)
        self.assertIn("Refusing to package an install that cannot start", message)
        # The repair command has to be actionable, not "engine missing".
        self.assertIn("build_local_engine.py --target darwin-arm64", message)

    def test_explicit_tampered_engine_dir_refuses_even_when_allow_build_true(self):
        directory = self._manifest(self.root / "bad-engine")
        (directory / "opencode").write_bytes(b"tampered")
        with self.assertRaises(SystemExit) as caught:
            self.bnp.resolve_engine_input(directory, "darwin-arm64", allow_build=True)
        self.assertIn("digest does not match", str(caught.exception))

    def test_a_wrong_target_engine_is_refused(self):
        directory = self._manifest(self.root / "engine", target="linux-x64")
        ok, why = self.bnp.engine_is_current(directory, "darwin-arm64")
        self.assertFalse(ok)
        self.assertIn("linux-x64", why)
        self.assertIn("darwin-arm64", why)

    def test_a_tampered_engine_is_refused(self):
        directory = self._manifest(self.root / "engine")
        (directory / "opencode").write_bytes(b"not the artifact that was built")
        ok, why = self.bnp.engine_is_current(directory, "darwin-arm64")
        self.assertFalse(ok)
        self.assertIn("digest does not match", why)

    def test_a_digestless_manifest_is_refused(self):
        # Unverifiable is not verified. Same rule the runtime resolver applies.
        directory = self._manifest(self.root / "engine", digest="")
        ok, why = self.bnp.engine_is_current(directory, "darwin-arm64")
        self.assertFalse(ok)
        self.assertIn("no digest", why)

    def test_a_valid_engine_is_reused_without_building(self):
        artifact = b"a real artifact"
        digest = hashlib.sha256(artifact).hexdigest()
        directory = self._manifest(self.root / "engine", digest=digest)
        (directory / "opencode").write_bytes(artifact)
        # allow_build=False proves reuse happens without invoking the builder at all.
        resolved = self.bnp.resolve_engine_input(directory, "darwin-arm64", allow_build=False)
        self.assertEqual(resolved, directory)

    def test_an_unreadable_manifest_is_refused_not_crashed(self):
        directory = self.root / "engine"
        directory.mkdir()
        (directory / "engine-manifest.json").write_text("{not json")
        ok, why = self.bnp.engine_is_current(directory, "darwin-arm64")
        self.assertFalse(ok)
        self.assertIn("unreadable manifest", why)

    def test_notices_reflect_local_no_ffmpeg_engine_not_registry_opencode(self):
        notices_file = REPO / "release" / "npm" / "THIRD_PARTY_NOTICES.txt"
        text = self.bnp.notice_text(notices_file.read_text(encoding="utf-8"), {})
        self.assertIn("without FFmpeg", text)
        self.assertIn("process-daemon", text)
        self.assertNotIn("downloads from the public registry", text)

    def test_missing_zig_version_is_detected_early_with_recovery_hint(self):
        import fetch_native_inputs as fni

        with (
            patch("shutil.which", side_effect=lambda name: f"/bin/{name}"),
            patch.object(fni, "zig_executable", side_effect=[Path("/tmp/zig-0.16"), None]),
        ):
            with self.assertRaises(fni.FetchRefused) as caught:
                fni.check_native_toolchains()
            self.assertIn("0.17.0", str(caught.exception))
            self.assertIn("ziglang.org", str(caught.exception))

    def test_is_host_target_works_without_os_uname_on_windows(self):
        mod = load_builder()
        with patch.object(sys, "platform", "win32"), patch("platform.machine", return_value="AMD64"):
            self.assertTrue(mod._is_host_target({"os": "win32", "arch": "x64"}))
            self.assertFalse(mod._is_host_target({"os": "win32", "arch": "arm64"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
