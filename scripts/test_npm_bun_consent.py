#!/usr/bin/env python3
"""Verify the source installer requires consent before it can download Bun."""

from contextlib import ExitStack, redirect_stdout
import io
import os
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
