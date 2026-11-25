"""Offline tests through actual installed Swamp, plus outgoing boundary probes."""
import asyncio
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
import bridge
import programming
import programming_peer as peer


class ProgrammingTests(unittest.TestCase):
    @classmethod
    def command(cls, *args, scenario="valid"):
        env = {k: v for k, v in os.environ.items() if not k.startswith("SWAMP_")}
        env["TDH3_TEST_SCENARIO"] = scenario
        return subprocess.run(["swamp", *args, "--json", "--no-telemetry"],
                              cwd=BASE, env=env, text=True, capture_output=True, timeout=90)

    @classmethod
    def setUpClass(cls):
        cls.scratch = tempfile.TemporaryDirectory(dir=BASE / "private")
        cls.folder = Path(cls.scratch.name)
        cls.original_capture = cls.folder / "original"
        cls.original_capture.mkdir(mode=0o700)
        probe = peer.read_peer.probe
        raw = b"".join(peer.ORIGINAL[a:a+32] for a in probe.ADDRESSES)
        manifest = dict(status="two-matching-partial-reads", ident_hex=probe.IDENT.hex(),
                        coverage=[dict(start=a, end_exclusive=b) for a, b in probe.RANGES],
                        complete_restore_backup=False, blocks_per_pass=171, bytes_per_pass=5472,
                        sha256=[hashlib.sha256(raw).hexdigest()] * 2)
        (cls.original_capture / "manifest.json").write_text(json.dumps(manifest))
        for number in (1, 2):
            (cls.original_capture / f"pass{number}-covered-bytes.bin").write_bytes(raw)
            (cls.original_capture / f"pass{number}-blocks.jsonl").write_text("\n".join(
                json.dumps(dict(address=a, data=peer.ORIGINAL[a:a+32].hex()))
                for a in probe.ADDRESSES))
        for path in cls.original_capture.iterdir():
            path.chmod(0o600)
        launcher = cls.folder / "python"
        launcher.write_text('#!/bin/sh\nexec "%s" -B "%s" "$@"\n' % (
            PYTHON, TESTS / "programming_peer.py"))
        launcher.chmod(0o700)
        cls.name = "programming-test-" + uuid.uuid4().hex[:8]
        result = cls.command("behavior", "create", "@mgreten/tdh3-programming-experiment",
                             cls.name, "--global-arg", "pythonPath=" + str(launcher),
                             "--global-arg", "privateRoot=" + str(BASE / "private"))
        assert result.returncode == 0, result.stderr
        cls.outputs = []

    @classmethod
    def tearDownClass(cls):
        result = cls.command("behavior", "delete", cls.name, "--force")
        for path in cls.outputs:
            if path.is_symlink():
                path.unlink()
            elif path.exists():
                shutil.rmtree(path)
        cls.scratch.cleanup()
        assert result.returncode == 0, result.stderr

    def arguments(self):
        run = "test-programming-" + uuid.uuid4().hex
        self.outputs.append(BASE / "private" / run)
        raw = b"".join(peer.ORIGINAL[a:a+32] for a in peer.read_peer.probe.ADDRESSES)
        return dict(runId=run, deviceUuid=peer.read_peer.UUID,
                    expectedSha256=hashlib.sha256(raw).hexdigest(), ownerConfirmed=True,
                    inactiveChannel30Confirmed=True, radioReadyConfirmed=True,
                    programmingAuthorized=True)

    def invoke(self, args, scenario="valid", success=False):
        method = "restoreLabel" if "originalCapturePath" in args else "labelExperiment"
        result = self.command("behavior", "run", self.name, method,
                              "--literal-inputs", "--input", json.dumps(args), scenario=scenario)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        self.assertNotIn("PRIVATE-TEST-SENTINEL", result.stdout + result.stderr)
        return result

    def restore_arguments(self):
        args = self.arguments()
        changed = bytearray(peer.ORIGINAL)
        changed[0xE2D] = 0x58
        raw = b"".join(changed[a:a+32] for a in peer.read_peer.probe.ADDRESSES)
        return dict(args, originalCapturePath=str(self.original_capture),
                    originalSha256=args["expectedSha256"],
                    expectedSha256=hashlib.sha256(raw).hexdigest())

    def test_inverse_only_restoration(self):
        args = self.restore_arguments()
        result = self.invoke(args, "recovery-valid", success=True)
        receipt = json.loads(result.stdout)["dataArtifacts"][0]["attributes"]
        self.assertEqual(receipt["status"], "restoration-readback-verified")
        self.assertFalse(receipt["persistenceVerified"])
        path = BASE / "private" / args["runId"]
        transcript = json.loads((path / "protocol-transcript.json").read_text())
        self.assertEqual(len(transcript), 1)
        writes = [bytes.fromhex(r["out"]) for r in transcript[0]
                  if r.get("out", "").startswith("57")]
        self.assertEqual(len(writes), 1)
        self.assertEqual(writes[0][4:36], peer.ORIGINAL[0xE20:0xE40])
        for file in path.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        before = {p.name: p.read_bytes() for p in path.iterdir()}
        self.invoke(args, "recovery-valid")
        self.assertEqual(before, {p.name: p.read_bytes() for p in path.iterdir()})

    def test_inverse_guards_and_ambiguous_outcomes(self):
        no_write = ("already-original", "stale", "wrong-label", "stale-target",
                    "identity", "unstable", "checksum", "short-read", "mtu", "missing")
        for scenario in (*no_write, "transport", "nack", "ignored", "collateral",
                         "no-ack", "extra-ack"):
            with self.subTest(scenario=scenario):
                args = self.restore_arguments()
                self.invoke(args, "recovery-" + scenario)
                path = BASE / "private" / args["runId"]
                state = json.loads((path / "transaction.json").read_text())
                self.assertEqual(state["writesAttempted"], 0 if scenario in no_write else 1)
                self.assertFalse(state["settingsRestored"])
                diagnostics = (path / "diagnostics.jsonl").read_text()
                self.assertIn('"event": "operation-failed"', diagnostics)
                if scenario == "transport":
                    self.assertIn("PRIVATE-TEST-SENTINEL", diagnostics)

    def test_inverse_capture_trust(self):
        for key in ("originalSha256", "expectedSha256"):
            args = self.restore_arguments()
            args[key] = "0" * 64
            self.invoke(args, "recovery-valid")
            path = BASE / "private" / args["runId"]
            self.assertEqual(json.loads((path / "protocol-transcript.json").read_text()), [])

    def test_complete_transaction_and_private_no_overwrite(self):
        args = self.arguments()
        result = self.invoke(args, success=True)
        receipt = json.loads(result.stdout)["dataArtifacts"][0]["attributes"]
        self.assertTrue(receipt["settingsRestored"])
        path = BASE / "private" / args["runId"]
        transcript = json.loads((path / "protocol-transcript.json").read_text())
        frames = [bytes.fromhex(r["out"]) for s in transcript for r in s if "out" in r]
        writes = [r for r in frames if r[:1] == b"W"]
        self.assertEqual(len(writes), 2)
        self.assertEqual(writes[0][4+13], 0x58)
        self.assertEqual(writes[1][4:36], peer.ORIGINAL[0xE20:0xE40])
        self.assertEqual(len(transcript), 4)
        for file in path.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(path.stat().st_mode & 0o777, 0o700)
        before = {p.name: p.read_bytes() for p in path.iterdir()}
        self.invoke(args)
        self.assertEqual(before, {p.name: p.read_bytes() for p in path.iterdir()})

    def test_no_writes_before_all_guards(self):
        for scenario in ("identity", "mtu", "missing", "unstable", "stale",
                         "stale-target", "checksum", "short-read"):
            with self.subTest(scenario=scenario):
                args = self.arguments()
                if scenario == "stale":
                    args["expectedSha256"] = "0" * 64
                self.invoke(args, scenario)
                path = BASE / "private" / args["runId"] / "transaction.json"
                self.assertEqual(json.loads(path.read_text())["writesAttempted"], 0)

    def test_ambiguous_and_wrong_outcomes_never_restore(self):
        for scenario in ("transport", "nack", "ignored", "collateral", "lost-persistence",
                         "no-ack", "extra-ack", "restore-nack"):
            with self.subTest(scenario=scenario):
                args = self.arguments()
                self.invoke(args, scenario)
                state = json.loads((BASE / "private" / args["runId"] / "transaction.json").read_text())
                self.assertEqual(state["writesAttempted"], 2 if scenario == "restore-nack" else 1)
                self.assertFalse(state["settingsRestored"])

    def test_confirmation_path_and_lock(self):
        args = self.arguments()
        for key in ("ownerConfirmed", "inactiveChannel30Confirmed", "radioReadyConfirmed",
                    "programmingAuthorized"):
            self.invoke(dict(args, **{key: False}))
        self.invoke(dict(args, runId="../escape"))
        path = BASE / "private" / args["runId"]
        path.symlink_to(self.folder)
        self.invoke(args)
        path.unlink()
        with (BASE / "private/.bluetooth.lock").open("r+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.invoke(args)
        self.assertFalse(path.exists())

    def test_original_boundary_still_rejects_writes(self):
        probe, _ = bridge.modules()

        async def check():
            session = probe.ReadOnlySession(None)
            session.phase = "reading"
            with self.assertRaises(probe.ProtocolError):
                await session.send(b"W" + bytes(36))
            guarded = programming.session_type(probe)(None)
            guarded.phase = "reading"
            with self.assertRaises(bridge.BridgeError):
                await guarded.send(b"W" + bytes(36))
            before = peer.ORIGINAL[0xE20:0xE40]
            wrong = before[:12] + b"X" + before[13:]
            with self.assertRaises(bridge.BridgeError):
                await guarded.patch(before, wrong)

        asyncio.run(check())


if __name__ == "__main__":
    unittest.main()
