#!/usr/bin/env python3
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from verify_alpha_release import CHECKS, VERIFY_JOBS, validate
from verify_native_release import REQUIRED

SHA = "a" * 40
POLICY = "b" * 64


class AlphaReleaseGateTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        (self.root / "evidence.txt").write_text("fixture evidence")
        self.platform = {
            "platform": "macos-arm64", "osVersion": "27.0.1", "osBuild": "26A434",
            "architecture": "arm64", "backend": "apple-virtualization", "runtime": "2.3.2",
        }
        jobs = [{"name": name, "run_id": 7, "head_sha": SHA, "status": "completed",
                 "conclusion": "success"} for name in VERIFY_JOBS]
        (self.root / "jobs.json").write_text(json.dumps({"jobs": jobs}))
        (self.root / "run.json").write_text(json.dumps({
            "id": 7, "name": "verify", "head_sha": SHA, "status": "completed",
            "conclusion": "success", "repository": {"full_name": "ALDRIN121/bashwink"},
            "html_url": "https://github.com/ALDRIN121/bashwink/actions/runs/7",
        }))
        artifact = "bashwink-0.1.0-alpha.1-macos-arm64.tar.gz"
        (self.root / artifact).write_bytes(b"test stand-in for verified artifact")
        checksum = hashlib.sha256((self.root / artifact).read_bytes()).hexdigest()
        self.manifest = {
            "schema": 1, "version": "v0.1.0-alpha.1", "candidate": SHA,
            "supported": [self.platform], "artifact": {
                "path": artifact,
                "sha256": checksum,
            },
            "ci": {"runReport": "run.json", "jobsReport": "jobs.json"},
            "checks": [{"id": check, "commit": SHA, "verdict": "PASS", "evidence": "evidence.txt",
                        "artifactSha256": checksum}
                       for check in CHECKS],
        }
        self.qualification = {
            "schema": 1, "advertised": ["macos-arm64"],
            "qualification": [
                {**self.platform, "id": check, "commit": SHA, "verdict": "PASS",
                 "policyDigest": POLICY, "command": "fixture command", "expected": "fixture",
                 "observed": "observed", "evidence": "evidence.txt", "hostObservation": "observed",
                 "exitCode": 0}
                for check in REQUIRED
            ],
        }

    def check(self, manifest=None, matrix=None, revision=SHA):
        return validate(manifest or self.manifest, matrix or self.qualification, revision,
                        self.root, self.root)

    def test_macos_alone_can_pass_release_without_linux_qualification(self):
        self.assertEqual(self.check(), [])

    def test_checks_cannot_be_omitted_or_unexecuted(self):
        for verdict in ("FAIL", "BLOCKED", "NOT_RUN"):
            with self.subTest(verdict=verdict):
                manifest = copy.deepcopy(self.manifest)
                manifest["checks"][0].update(verdict=verdict, reason="failure")
                self.assertTrue(self.check(manifest))
        self.manifest["checks"].pop()
        self.assertTrue(self.check())

    def test_probe_or_other_macos_build_cannot_qualify_the_candidate(self):
        self.qualification["qualification"][0]["osBuild"] = "26B123"
        self.assertTrue(self.check())
        self.qualification["observations"] = self.qualification["qualification"]
        self.qualification["qualification"] = []
        self.assertTrue(self.check())

    def test_ci_cancellation_or_staleness_fails_even_if_the_run_conclusion_says_success(self):
        path = self.root / "jobs.json"
        original = json.loads(path.read_text())
        for key, value in (("conclusion", "cancelled"), ("conclusion", "skipped"),
                           ("head_sha", "c" * 40)):
            report = copy.deepcopy(original)
            report["jobs"][0][key] = value
            path.write_text(json.dumps(report))
            self.assertTrue(self.check())

    def test_changed_artifact_and_wrong_candidate_fail(self):
        self.assertTrue(self.check(revision="c" * 40))
        self.manifest["checks"][0]["artifactSha256"] = "d" * 64
        self.assertTrue(self.check())
        self.manifest["checks"][0]["artifactSha256"] = self.manifest["artifact"]["sha256"]
        (self.root / self.manifest["artifact"]["path"]).write_bytes(b"changed")
        self.assertTrue(self.check())


if __name__ == "__main__":
    unittest.main()
