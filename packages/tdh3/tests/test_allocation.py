"""Actual isolated Swamp allocation, with synthetic fail-stop write outcomes."""
import fcntl
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

from test_support import BASE, ENV, PYTHON, TESTS
from test_profiles import fixture, memory, PROBE, DECODER, FIRST
import bridge
import profiles


class AllocationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(dir=BASE / "private")
        cls.root = Path(cls.temporary.name)
        cls.capture = cls.root / "capture"
        cls.capture.mkdir(mode=0o700)
        raw = fixture()
        raw[0xCA7] &= 0xF8
        (cls.root / "memory.bin").write_bytes(raw)
        covered = b"".join(raw[a:a+32] for a in PROBE.ADDRESSES)
        cls.digest = hashlib.sha256(covered).hexdigest()
        manifest = dict(status="two-matching-partial-reads", ident_hex=PROBE.IDENT.hex(),
            coverage=[dict(start=a,end_exclusive=b) for a,b in PROBE.RANGES],
            complete_restore_backup=False, blocks_per_pass=171, bytes_per_pass=5472,
            sha256=[cls.digest]*2)
        (cls.capture / "manifest.json").write_text(json.dumps(manifest))
        for n in (1, 2):
            (cls.capture / f"pass{n}-covered-bytes.bin").write_bytes(covered)
            (cls.capture / f"pass{n}-blocks.jsonl").write_text("\n".join(json.dumps(dict(
                address=a, data=raw[a:a+32].hex())) for a in PROBE.ADDRESSES))
        for file in cls.capture.iterdir():
            file.chmod(0o600)
        plan = profiles.plan(memory(raw), PROBE, DECODER, [FIRST])
        cls.planpath = cls.root / "expected-plan.json"
        cls.planpath.write_text(json.dumps(plan))
        cls.planpath.chmod(0o600)
        launcher = cls.root / "python"
        launcher.write_text('#!/bin/sh\nexec "%s" -B "%s" "$@"\n' % (
            PYTHON, TESTS / "allocation_peer.py"))
        launcher.chmod(0o700)
        cls.name = "allocation-test-" + uuid.uuid4().hex[:8]
        result = cls.command("behavior", "create", "@mgreten/tdh3-profiles", cls.name,
            "--global-arg", "pythonPath="+str(launcher), "--global-arg", "privateRoot="+str(cls.root))
        assert result.returncode == 0, result.stderr

    @classmethod
    def tearDownClass(cls):
        result = cls.command("behavior", "delete", cls.name, "--force")
        cls.temporary.cleanup()
        assert result.returncode == 0, result.stderr

    @classmethod
    def command(cls, *args, scenario="valid"):
        return subprocess.run(["swamp", *args, "--json", "--no-telemetry"], cwd=BASE,
            env=dict(ENV, TDH3_TEST_ROOT=str(cls.root), TDH3_TEST_SCENARIO=scenario),
            text=True, capture_output=True, timeout=60)

    def arguments(self):
        return dict(runId="allocation-"+uuid.uuid4().hex, deviceUuid="11111111-2222-3333-2444-555555555555",
            planPath=str(self.planpath), planSha256=hashlib.sha256(self.planpath.read_bytes()).hexdigest(),
            capturePath=str(self.capture), expectedSha256=self.digest, trustPolicy=bridge.POLICY,
            ownerConfirmed=True, radioReadyConfirmed=True, inactiveTargetSlotsConfirmed=True,
            programmingAuthorized=True)

    def invoke(self, args, scenario="valid", success=False):
        result = self.command("behavior", "run", self.name, "apply", "--literal-inputs",
                              "--input", json.dumps(args), scenario=scenario)
        self.assertEqual(result.returncode == 0, success, result.stdout+result.stderr)
        self.assertNotIn("PRIVATE-TEST-SENTINEL", result.stdout+result.stderr)
        return result

    def test_exact_ordered_application_and_private_no_overwrite(self):
        args = self.arguments()
        result = self.invoke(args, success=True)
        receipt = json.loads(result.stdout)["dataArtifacts"][0]["attributes"]
        self.assertEqual(receipt["writes"], 4)
        self.assertFalse(receipt["persistenceVerified"])
        output = self.root / args["runId"]
        state = json.loads((output / "transaction.json").read_text())
        self.assertEqual(state["blocksVerified"], [0x1E0,0xE20,0x1900,0x1920])
        transcript = json.loads((output / "protocol-transcript.json").read_text())
        writes = [bytes.fromhex(r["out"]) for r in transcript if r.get("out", "").startswith("57")]
        self.assertEqual([int.from_bytes(w[1:3], "big") for w in writes], state["blocksVerified"])
        for file in output.iterdir():
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
        saved = {p.name:p.read_bytes() for p in output.iterdir()}
        self.invoke(args)
        self.assertEqual(saved, {p.name:p.read_bytes() for p in output.iterdir()})

    def test_stale_identity_and_partial_outcomes_stop_at_first_unknown(self):
        for scenario in ("stale", "stale-target", "identity", "mtu", "missing", "vox"):
            args = self.arguments()
            self.invoke(args, scenario)
            state = json.loads((self.root/args["runId"]/"transaction.json").read_text())
            self.assertEqual(state["writesAttempted"], 0)
        for index in range(1, 5):
            for kind in ("nack", "drop", "extra", "ignored", "transport", "collateral"):
                with self.subTest(index=index, kind=kind):
                    args = self.arguments()
                    self.invoke(args, f"{kind}-{index}")
                    output = self.root/args["runId"]
                    state = json.loads((output/"transaction.json").read_text())
                    self.assertEqual(state["writesAttempted"], index)
                    self.assertEqual(len(state["blocksVerified"]), index-1)
                    self.assertEqual(state["status"], "incomplete")
                    self.assertIn('"event": "operation-failed"', (output/"diagnostics.jsonl").read_text())

    def test_plan_tampering_hashes_confirmation_and_lock(self):
        args = self.arguments()
        for key in ("planSha256", "expectedSha256"):
            self.invoke(dict(args, **{key:"0"*64}))
            self.assertFalse((self.root/args["runId"]).exists())
        tampered = json.loads(self.planpath.read_text())
        tampered["blocks"][0]["after"] = "00"*32
        path = self.root/"tampered.json"
        path.write_text(json.dumps(tampered)); path.chmod(0o600)
        self.invoke(dict(args, planPath=str(path), planSha256=hashlib.sha256(path.read_bytes()).hexdigest()))
        self.assertFalse((self.root/args["runId"]).exists())
        for key in ("ownerConfirmed", "radioReadyConfirmed", "inactiveTargetSlotsConfirmed", "programmingAuthorized"):
            self.invoke(dict(args, **{key:False}))
        with (self.root/".bluetooth.lock").open("a+") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.invoke(args)
        self.assertFalse((self.root/args["runId"]).exists())


if __name__ == "__main__":
    unittest.main()
