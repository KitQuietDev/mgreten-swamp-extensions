"""SQL5→2 only, through real isolated Swamp and synthetic read/write peer."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

from test_support import BASE, ENV, PYTHON, TESTS
from test_profiles import fixture, memory, PROBE
import bridge
import listening


class ListeningTests(unittest.TestCase):
    def test_only_squelch_byte_changes_and_vox_precondition(self):
        raw = fixture()
        raw[0xCA7] = 0xF8
        raw[0xCA9] = 5
        result = listening.plan(memory(raw), PROBE)
        self.assertEqual(len(result["blocks"]), 1)
        block = result["blocks"][0]
        self.assertEqual((block["address"], block["changedOffsets"]), (0xCA0, [9]))
        before, after = bytes.fromhex(block["before"]), bytes.fromhex(block["after"])
        self.assertEqual(after, before[:9]+b"\x02"+before[10:])
        for value in (0, 2, 4, 6, 9, 255):
            raw[0xCA9] = value
            with self.assertRaises(bridge.BridgeError):
                listening.plan(memory(raw), PROBE)
        raw[0xCA9] = 5
        raw[0xCA7] |= 1
        with self.assertRaises(bridge.BridgeError):
            listening.plan(memory(raw), PROBE)

    def test_actual_swamp_preview_apply_and_fail_stop(self):
        with tempfile.TemporaryDirectory(dir=BASE/"private") as temporary:
            root = Path(temporary)
            capture = root/"capture"
            capture.mkdir(mode=0o700)
            raw = fixture()
            raw[0xCA7] = 0xF8
            raw[0xCA9] = 5
            (root/"memory.bin").write_bytes(raw)
            covered = b"".join(raw[a:a+32] for a in PROBE.ADDRESSES)
            digest = hashlib.sha256(covered).hexdigest()
            manifest = dict(status="two-matching-partial-reads", ident_hex=PROBE.IDENT.hex(),
                coverage=[dict(start=a,end_exclusive=b) for a,b in PROBE.RANGES],
                complete_restore_backup=False,blocks_per_pass=171,bytes_per_pass=5472,sha256=[digest]*2)
            (capture/"manifest.json").write_text(json.dumps(manifest))
            for n in (1,2):
                (capture/f"pass{n}-covered-bytes.bin").write_bytes(covered)
                (capture/f"pass{n}-blocks.jsonl").write_text("\n".join(json.dumps(dict(
                    address=a,data=raw[a:a+32].hex())) for a in PROBE.ADDRESSES))
            for file in capture.iterdir():
                file.chmod(0o600)
            planpath = root/"expected-plan.json"
            planpath.write_text(json.dumps(listening.plan(memory(raw), PROBE)))
            planpath.chmod(0o600)
            launcher = root/"python"
            launcher.write_text('#!/bin/sh\nexec "%s" -B "%s" "$@"\n' % (
                PYTHON, TESTS/"allocation_peer.py"))
            launcher.chmod(0o700)

            def command(*args, scenario="valid"):
                return subprocess.run(["swamp",*args,"--json","--no-telemetry"],cwd=BASE,
                    env=dict(ENV,TDH3_TEST_ROOT=str(root),TDH3_TEST_SCENARIO=scenario),
                    text=True,capture_output=True,timeout=60)

            name = "listening-test-"+uuid.uuid4().hex[:8]
            result = command("behavior","create","@mgreten/tdh3-listening",name,
                "--global-arg","pythonPath="+str(launcher),"--global-arg","privateRoot="+str(root))
            self.assertEqual(result.returncode,0,result.stderr)
            common = dict(capturePath=str(capture),expectedSha256=digest,trustPolicy=bridge.POLICY)
            args = dict(common,deviceUuid="11111111-2222-3333-2444-555555555555",planPath=str(planpath),
                planSha256=hashlib.sha256(planpath.read_bytes()).hexdigest(),ownerConfirmed=True,
                radioReadyConfirmed=True,programmingAuthorized=True)
            try:
                r = command("behavior","run",name,"previewSquelch","--literal-inputs","--input",
                            json.dumps(dict(common,runId="preview")))
                self.assertEqual(r.returncode,0,r.stdout+r.stderr)
                for scenario in ("valid","stale","stale-target","identity","nack-1","drop-1",
                                 "extra-1","ignored-1","transport-1","collateral-1"):
                    current = dict(args,runId="sql-"+uuid.uuid4().hex)
                    r = command("behavior","run",name,"setSquelch","--literal-inputs","--input",
                        json.dumps(current),scenario=scenario)
                    self.assertEqual(r.returncode==0,scenario=="valid",r.stdout+r.stderr)
                    self.assertNotIn("PRIVATE-TEST-SENTINEL",r.stdout+r.stderr)
                    path = root/current["runId"]
                    state = json.loads((path/"transaction.json").read_text())
                    self.assertEqual(state["writesAttempted"],0 if scenario in (
                        "stale","stale-target","identity") else 1)
                    if scenario=="valid":
                        receipt = json.loads(r.stdout)["dataArtifacts"][0]["attributes"]
                        self.assertEqual(receipt["status"],"squelch-readback-verified")
                        self.assertFalse(receipt["persistenceVerified"])
                    self.assertEqual((path/"transaction.json").stat().st_mode & 0o777,0o600)
                # Regeneration rejects arbitrary other settings even with a new file hash.
                bad = json.loads(planpath.read_text());bad["blocks"][0]["after"]="00"*32
                badpath=root/"bad-plan.json";badpath.write_text(json.dumps(bad));badpath.chmod(0o600)
                r=command("behavior","run",name,"setSquelch","--literal-inputs","--input",json.dumps(
                    dict(args,runId="tampered",planPath=str(badpath),planSha256=hashlib.sha256(badpath.read_bytes()).hexdigest())))
                self.assertNotEqual(r.returncode,0)
                self.assertFalse((root/"tampered").exists())
            finally:
                r=command("behavior","delete",name,"--force")
                self.assertEqual(r.returncode,0,r.stderr)


if __name__=="__main__":
    unittest.main()
