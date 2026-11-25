#!/usr/bin/env python3
"""Verify the source installer's Bun consent and error handling."""

from contextlib import ExitStack, redirect_stdout
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import build_npm_package as builder


class BunConsentTest(unittest.TestCase):
    def test_declining_or_closing_input_stops_before_installing(self):
        for answer in ("n\n", "", "\n"):
            with self.subTest(answer=answer), tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
                stdout = io.StringIO()
                with (
                    patch.dict(os.environ, {"PATH": directory, "NoDefaultCurrentDirectoryInExePath": "1"}),
                    patch("sys.stdin", io.StringIO(answer)),
                    redirect_stdout(stdout),
                    patch.object(builder, "NPM", str(Path(directory) / "npm-is-unavailable")),
                ):
                    with self.assertRaisesRegex(SystemExit, "Setup stopped"):
                        builder.resolve_bun(None, True, resources)
                self.assertIn("Install a temporary copy using npm?", stdout.getvalue())

    def test_build_only_mode_requires_bun_without_prompting(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            stdout = io.StringIO()
            with patch.dict(os.environ, {"PATH": directory, "NoDefaultCurrentDirectoryInExePath": "1"}), redirect_stdout(stdout):
                with self.assertRaisesRegex(SystemExit, "Bun 1.4.4 is required"):
                    builder.resolve_bun(None, False, resources)
            self.assertEqual(stdout.getvalue(), "")

    def test_missing_npm_reports_the_prerequisite_after_consent(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            with (
                patch.dict(os.environ, {"PATH": directory, "NoDefaultCurrentDirectoryInExePath": "1"}),
                patch("sys.stdin", io.StringIO("y\n")),
                redirect_stdout(io.StringIO()),
                patch.object(builder, "NPM", str(Path(directory) / "npm-is-unavailable")),
            ):
                with self.assertRaisesRegex(SystemExit, r"npm was not found.*Node\.js 22"):
                    builder.resolve_bun(None, True, resources)

    def test_failed_bun_download_reports_npm_exit_code(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as resources:
            with (
                patch.dict(os.environ, {"PATH": directory, "NoDefaultCurrentDirectoryInExePath": "1"}),
                patch("sys.stdin", io.StringIO("y\n")),
                redirect_stdout(io.StringIO()),
                patch.object(builder, "build_runtime_plan", return_value={
                    "bun": "@oven/bun-windows-x64", "executable": ".exe",
                }),
                patch.object(builder, "run", side_effect=subprocess.CalledProcessError(23, "npm install")),
            ):
                with self.assertRaisesRegex(SystemExit, r"npm could not install Bun 1\.4\.4 \(exit 23\)"):
                    builder.resolve_bun(None, True, resources)

    def test_main_keeps_temporary_bun_alive_until_build_package_finishes(self):
        with tempfile.TemporaryDirectory() as directory:
            out_dir = Path(directory) / "out"
            observed = {}

            def fake_resolve_bun(_override, _offer, resources):
                temp = Path(resources.enter_context(tempfile.TemporaryDirectory()))
                fake_bun = temp / "bun"
                fake_bun.write_text("#!/bin/sh\n")
                return str(fake_bun)

            def fake_build_package(_out, bun, _commit, _install, _engine_dir, _engine_target):
                observed["exists_during_build"] = Path(bun).is_file()
                return 0

            with (
                patch.object(sys, "argv", ["build_npm_package.py", "--out", str(out_dir)]),
                patch.object(builder, "check_base_prerequisites"),
                patch.object(builder, "capture", side_effect=["", "deadbeef"]),
                patch.object(builder, "resolve_bun", side_effect=fake_resolve_bun),
                patch.object(builder, "build_package", side_effect=fake_build_package),
            ):
                rc = builder.main()
            self.assertEqual(rc, 0)
            self.assertTrue(observed.get("exists_during_build"))

    def test_early_prerequisite_checks_report_missing_node_version_and_git(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"PATH": directory}), patch("shutil.which", return_value=None):
                with self.assertRaisesRegex(SystemExit, r"Git is required"):
                    builder.check_base_prerequisites()
            with (
                patch("shutil.which", side_effect=lambda name: f"/bin/{name}"),
                patch.object(builder, "node_version", return_value=(20, 11, 0)),
            ):
                with self.assertRaisesRegex(SystemExit, r"Node\.js 22\+ is required.*20\.11\.0"):
                    builder.check_base_prerequisites()


if __name__ == "__main__":
    unittest.main()
