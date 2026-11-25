"""Offline integration tests through installed Swamp methods, never live BLE."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid

from test_support import BASE, PYTHON, TESTS
import offline_peer

SAVED = BASE / "private/synthetic-fixture"
fixture = offline_peer.memory_bytes()
fixture[0] = 99
DIGEST = hashlib.sha256(b"".join(fixture[a:a+32] for a in offline_peer.probe.ADDRESSES)).hexdigest()
# Mac peripheral identifiers need not have RFC 4122 variant bits.
DEVICE = "11111111-2222-3333-2444-555555555555"
POLICY = "owner-reviewed-sha256-exact-gmrs-coverage-v1"


class SwampTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(prefix="tdh3-swamp-", dir=BASE / "private")
        cls.folder = Path(cls.scratch.name)
        cls.launcher = cls.folder / "offline-python"
        cls.launcher.write_text('#!/bin/sh\nexec "%s" -B "%s" "$@"\n' %
                                (PYTHON, TESTS / "offline_peer.py"))
        cls.launcher.chmod(0o700)
        cls.name = "offline-test-" + uuid.uuid4().hex[:10]
        result = cls.command("behavior", "create", "@mgreten/tdh3-readonly", cls.name,
                             "--global-arg", "pythonPath=" + str(cls.launcher),
                             "--global-arg", "privateRoot=" + str(BASE / "private"))
        assert result.returncode == 0, result.stderr
        cls.outputs = []
        fixture_result = cls.command("behavior", "run", cls.name, "capture", "--literal-inputs",
            "--input", json.dumps(dict(runId="synthetic-fixture", bluetoothAuthorized=True,
            deviceUuid=DEVICE, confirmedRadioLabel="2A4FBTD831G", ownerConfirmed=True)),
            scenario="fixture")
        assert fixture_result.returncode == 0, fixture_result.stdout + fixture_result.stderr

    @classmethod
    def tearDownClass(cls):
        # Only this test's disposable definition, histories, synthetic outputs.
        result = cls.command("behavior", "delete", cls.name, "--force")
        for folder in cls.outputs:
            if folder.is_symlink():
                folder.unlink()
            elif folder.exists():
                shutil.rmtree(folder)
        cls.scratch.cleanup()
        assert result.returncode == 0, result.stderr

    @classmethod
    def command(cls, *args, scenario="valid"):
        env = dict(os.environ, TDH3_TEST_SCENARIO=scenario)
        # Ensure these tests cannot be redirected to a shared/remote service.
        for key in list(env):
            if key.startswith("SWAMP_"):
                del env[key]
        return subprocess.run(["swamp", *args, "--json", "--no-telemetry"],
                              cwd=BASE, env=env, text=True, capture_output=True, timeout=90)

    def run_method(self, method, args, scenario="valid", success=True):
        result = self.command("behavior", "run", self.name, method,
                              "--literal-inputs", "--input", json.dumps(args), scenario=scenario)
        if success:
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            artifacts = json.loads(result.stdout)["dataArtifacts"]
            self.assertEqual(len(artifacts), 1)
            receipt = artifacts[0]["attributes"]
            common = {"operation", "privatePath", "partialCapture", "completeRestoreBackup",
                      "firmware", "liveChannel"}
            specific = {"discover": {"candidateCount"},
                        "capture": {"sha256", "blocksPerPass", "bytesPerPass"},
                        "decode": {"sha256", "populated", "empty", "unknowns"}}[method]
            self.assertEqual(set(receipt), common | specific)
            self.assertEqual(receipt["operation"], method)
            self.assertEqual(receipt["partialCapture"], method != "discover")
            self.assertIs(receipt["completeRestoreBackup"], False)
            self.assertEqual(receipt["firmware"], "Unknown")
            self.assertEqual(receipt["liveChannel"], "Unknown")
        else:
            self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("PRIVATE-TEST-SENTINEL", result.stderr + result.stdout)
        return result

    def new_id(self):
        run_id = "test-" + uuid.uuid4().hex
        self.outputs.append(BASE / "private" / run_id)
        return run_id

    def decode_args(self, path=SAVED, digest=DIGEST):
        return dict(runId=self.new_id(), capturePath=str(path), expectedSha256=digest,
                    trustPolicy=POLICY)

    def capture_args(self):
        return dict(runId=self.new_id(), bluetoothAuthorized=True, deviceUuid=DEVICE,
                    confirmedRadioLabel="2A4FBTD831G", ownerConfirmed=True)

    def test_saved_decode_and_no_overwrite(self):
        before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in SAVED.iterdir()}
        args = self.decode_args()
        self.run_method("decode", args)
        output = BASE / "private" / args["runId"]
        decoded = json.loads((output / "decoded.json").read_text())
        self.assertEqual(decoded["counts"]["populated"], 1)
        self.assertEqual(decoded["counts"]["empty"], 198)
        self.assertEqual(decoded["globals"]["squelch"]["value"], 7)
        self.assertTrue(decoded["partial_capture"])
        self.assertEqual(decoded["firmware"], "Unknown")
        export_before = (output / "decoded.json").read_bytes()
        self.run_method("decode", args, success=False)
        self.assertEqual((output / "decoded.json").read_bytes(), export_before)
        self.assertEqual(output.stat().st_mode & 0o777, 0o700)
        for p in output.iterdir():
            self.assertEqual(p.stat().st_mode & 0o777, 0o600)
        self.assertEqual(before, {p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                                  for p in SAVED.iterdir()})

    def test_capture_and_decode_new_digest_asymmetric_data(self):
        invalid = self.capture_args()
        invalid["deviceUuid"] = "../not-a-peripheral"
        self.run_method("capture", invalid, success=False)
        self.assertFalse((BASE / "private" / invalid["runId"]).exists())
        args = self.capture_args()
        self.run_method("capture", args)
        folder = BASE / "private" / args["runId"]
        manifest = json.loads((folder / "manifest.json").read_text())
        self.assertEqual(manifest["status"], "two-matching-partial-reads")
        self.assertEqual(manifest["blocks_per_pass"], 171)
        self.assertEqual(manifest["bytes_per_pass"], 5472)
        self.assertNotEqual(manifest["sha256"][0], DIGEST)
        transcript = json.loads((folder / "protocol-transcript.json").read_text())
        outgoing = [bytes.fromhex(r["out"]) for r in transcript if "out" in r]
        self.assertEqual(len(outgoing), 346)
        self.assertEqual(sum(frame.startswith(b"R") for frame in outgoing), 342)
        self.assertFalse(any(frame.startswith(b"W") for frame in outgoing))
        args = self.decode_args(folder, manifest["sha256"][0])
        self.run_method("decode", args)
        decoded = json.loads((BASE / "private" / args["runId"] / "decoded.json").read_text())
        self.assertEqual(decoded["counts"]["populated"], 1)
        channel = decoded["channels"][8]
        self.assertEqual(channel["rx_hz"], 462625000)
        self.assertEqual(channel["tx_hz"], 467625000)
        self.assertEqual(channel["rx_tone"]["hz"], 88.5)
        self.assertEqual(channel["tx_tone"]["hz"], 141.3)
        self.assertFalse(channel["scan_included"])
        self.assertEqual(decoded["globals"]["scan_mode"]["value"], "SE")

    def test_hash_identity_coverage_and_raw_log_tampering(self):
        self.run_method("decode", self.decode_args(digest="0" * 64), success=False)
        for damage in ("identity", "coverage", "raw", "log", "status", "exit-error"):
            folder = self.folder / damage
            shutil.copytree(SAVED, folder)
            manifest = json.loads((folder / "manifest.json").read_text())
            if damage == "identity":
                manifest["ident_hex"] = "503331313835ffff"
            elif damage == "coverage":
                manifest["coverage"][-1]["end_exclusive"] += 32
            elif damage == "status":
                manifest["status"] = "incomplete"
            elif damage == "exit-error":
                # The probe records matching data before sending E. If E fails,
                # its manifest can retain that status alongside an error.
                manifest["error"] = "ProtocolError: exit failed after matching reads"
            elif damage == "raw":
                raw = bytearray((folder / "pass2-covered-bytes.bin").read_bytes())
                raw[40] ^= 1
                (folder / "pass2-covered-bytes.bin").write_bytes(raw)
            else:
                lines = (folder / "pass1-blocks.jsonl").read_text().splitlines()
                first = json.loads(lines[0])
                first["address"] += 32
                lines[0] = json.dumps(first)
                (folder / "pass1-blocks.jsonl").write_text("\n".join(lines))
            (folder / "manifest.json").write_text(json.dumps(manifest))
            args = self.decode_args(folder)
            self.run_method("decode", args, success=False)
            self.assertFalse((BASE / "private" / args["runId"]).exists())

    def test_private_paths_traversal_permissions_and_symlinks(self):
        checkout = self.folder / "checkout"
        checkout.mkdir(mode=0o700)
        (checkout / ".git").mkdir()
        captured = checkout / "capture"
        shutil.copytree(SAVED, captured)
        self.run_method("decode", self.decode_args(captured), success=False)
        folder = self.folder / "unsafe"
        shutil.copytree(SAVED, folder)
        (folder / "manifest.json").chmod(0o644)
        self.run_method("decode", self.decode_args(folder), success=False)
        link = self.folder / "linked"
        link.symlink_to(SAVED, target_is_directory=True)
        self.run_method("decode", self.decode_args(link), success=False)
        args = self.decode_args()
        args["runId"] = "../escape"
        self.run_method("decode", args, success=False)
        run_id = self.new_id()
        (BASE / "private" / run_id).symlink_to(SAVED, target_is_directory=True)
        args = self.decode_args()
        args["runId"] = run_id
        self.run_method("decode", args, success=False)

    def test_discovery_zero_and_multiple_never_select_or_connect(self):
        for scenario, count in (("zero", 0), ("valid", 2)):
            run_id = self.new_id()
            self.run_method("discover", dict(runId=run_id, bluetoothAuthorized=True), scenario)
            candidates = json.loads((BASE / "private" / run_id / "candidates.json").read_text())
            self.assertEqual(len(candidates["td_h3_candidates"]), count)
            self.assertFalse(candidates["connected"])
        args = self.capture_args()
        del args["deviceUuid"]
        self.run_method("capture", args, success=False)
        self.run_method("capture", self.capture_args(), "missing", success=False)

    def test_identity_and_different_pass_failures_preserve_incomplete_evidence(self):
        for scenario in ("identity", "different"):
            args = self.capture_args()
            self.run_method("capture", args, scenario, success=False)
            folder = BASE / "private" / args["runId"]
            manifest = json.loads((folder / "manifest.json").read_text())
            self.assertEqual(manifest["status"], "incomplete")
            transcript = json.loads((folder / "protocol-transcript.json").read_text())
            outgoing = [bytes.fromhex(r["out"]) for r in transcript if "out" in r]
            self.assertEqual(outgoing[-1], b"E")
            self.assertFalse(any(frame.startswith(b"W") for frame in outgoing))
            if scenario == "identity":
                self.assertFalse(any(frame.startswith(b"R") for frame in outgoing))

    def test_lock_contention_denies_scan_and_capture(self):
        with (BASE / "private/.bluetooth.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for method, args in (("discover", dict(runId=self.new_id(), bluetoothAuthorized=True)),
                                 ("capture", self.capture_args())):
                result = self.run_method(method, args, success=False)
                self.assertIn("bluetooth_busy", result.stdout + result.stderr)
                self.assertFalse((BASE / "private" / args["runId"]).exists())

    def test_subprocess_failure_and_malformed_response_are_redacted(self):
        for scenario in ("stderr", "malformed", "invalid-json", "private-key", "missing-digest"):
            result = self.run_method("decode", self.decode_args(), scenario, success=False)
            self.assertIn("operation_failed" if scenario == "stderr" else "invalid_bridge_response",
                          result.stdout + result.stderr)

    def test_authorization_and_trust_policy_are_required(self):
        for method, args, key in (
                ("discover", dict(runId=self.new_id(), bluetoothAuthorized=False), None),
                ("capture", self.capture_args(), "ownerConfirmed"),
                ("decode", self.decode_args(), "expectedSha256"),
                ("decode", self.decode_args(), "trustPolicy")):
            if key:
                del args[key]
            self.run_method(method, args, success=False)
            self.assertFalse((BASE / "private" / args["runId"]).exists())


if __name__ == "__main__":
    os.umask(0o077)
    unittest.main()
