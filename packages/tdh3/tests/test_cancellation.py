"""Cancellation/hard-containment contract through real TS models and fake BLE."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from test_support import BASE, ENV, PYTHON, TESTS, RUNTIME
from test_profiles import fixture, memory, FIRST, PROBE, DECODER
import profiles
import listening
import programming_peer

DENO = Path.home()/".swamp/deno/deno"


class CancellationTests(unittest.TestCase):
    def run_case(self, kind="profiles", mode="after-write", pre_abort=False, cancel_at_receipt=False):
        with tempfile.TemporaryDirectory(dir=BASE/"private") as temporary:
            root = Path(temporary)
            raw = fixture()
            raw[0xCA7], raw[0xCA9] = 0xF8, 5
            (root/"memory.bin").write_bytes(raw)
            covered = b"".join(raw[a:a+32] for a in PROBE.ADDRESSES)
            digest = hashlib.sha256(covered).hexdigest()
            capture = root/"capture"
            capture.mkdir(mode=0o700)
            (capture/"manifest.json").write_text(json.dumps(dict(
                status="two-matching-partial-reads",ident_hex=PROBE.IDENT.hex(),
                coverage=[dict(start=a,end_exclusive=b) for a,b in PROBE.RANGES],
                complete_restore_backup=False,blocks_per_pass=171,bytes_per_pass=5472,
                sha256=[digest]*2)))
            for n in (1,2):
                (capture/f"pass{n}-covered-bytes.bin").write_bytes(covered)
                (capture/f"pass{n}-blocks.jsonl").write_text("\n".join(json.dumps(dict(
                    address=a,data=raw[a:a+32].hex())) for a in PROBE.ADDRESSES))
            for file in capture.iterdir():file.chmod(0o600)
            plan = listening.plan(memory(raw),PROBE) if kind == "listening" else profiles.plan(
                memory(raw),PROBE,DECODER,[FIRST])
            planpath = root/"expected-plan.json"
            planpath.write_text(json.dumps(plan));planpath.chmod(0o600)
            launcher = root/"python"
            launcher.write_text('#!/bin/sh\nexec "%s" -B "%s" "$@"\n' % (PYTHON,TESTS/"cancellation_peer.py"))
            launcher.chmod(0o700)
            args = dict(runId="cancel",deviceUuid="11111111-2222-3333-2444-555555555555",
                planPath=str(planpath),planSha256=hashlib.sha256(planpath.read_bytes()).hexdigest(),
                capturePath=str(capture),expectedSha256=digest,
                trustPolicy="owner-reviewed-sha256-exact-gmrs-coverage-v1",ownerConfirmed=True,
                programmingAuthorized=True,radioReadyConfirmed=True)
            method = "setSquelch" if kind=="listening" else "apply"
            if kind=="profiles":args["inactiveTargetSlotsConfirmed"]=True
            if kind=="programming":
                method="labelExperiment"
                args=dict(runId="cancel",deviceUuid=args["deviceUuid"],ownerConfirmed=True,
                    programmingAuthorized=True,radioReadyConfirmed=True,inactiveChannel30Confirmed=True,
                    expectedSha256=hashlib.sha256(b"".join(programming_peer.ORIGINAL[a:a+32]
                        for a in PROBE.ADDRESSES)).hexdigest())
            if kind=="readonly":
                method="capture"
                args=dict(runId="cancel",deviceUuid=args["deviceUuid"],ownerConfirmed=True,
                    bluetoothAuthorized=True,confirmedRadioLabel="2A4FBTD831G")
            config=dict(root=str(root),python=str(launcher),runtime=str(RUNTIME),
                model=(RUNTIME.parent/f"tdh3_{kind}.ts").as_uri(),method=method,args=args,
                preAbort=pre_abort,cancelAtReceipt=cancel_at_receipt)
            path=root/"case.json";path.write_text(json.dumps(config))
            result=subprocess.run([str(DENO),"run","-A",str(TESTS/"cancellation_runner.ts"),str(path)],
                env=dict(ENV,TDH3_TEST_ROOT=str(root),TDH3_CANCEL_MODE=mode),text=True,
                capture_output=True,timeout=20)
            self.assertEqual(result.returncode,0,result.stderr)
            report=json.loads(result.stdout)
            self.assertTrue(report["rejected"],report)
            self.assertEqual(report["receipts"],1 if cancel_at_receipt else 0)
            self.assertNotIn("PRIVATE-TEST-SENTINEL",result.stdout+result.stderr)
            self.assertLess(report["elapsedMs"],12000)
            if pre_abort:
                self.assertFalse((root/"ready.json").exists())
                self.assertFalse((root/"cancel").exists())
                return
            if cancel_at_receipt:
                self.assertFalse((root/"ready.json").exists())
                return  # The verified receipt may exist; the method still rejects.
            ready=json.loads((root/"ready.json").read_text())
            with self.assertRaises(ProcessLookupError):os.kill(ready["pid"],0)
            with (root/".bluetooth.lock").open("a+") as lock:
                fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            writes=json.loads((root/"writes.json").read_text()) if (root/"writes.json").exists() else []
            expected_writes = len(plan["blocks"]) if mode=="disconnect-hang" else (
                0 if mode in ("before-write","read-only") else 1)
            self.assertEqual(len(writes),expected_writes)
            if mode=="label-stage":self.assertEqual(ready["connections"],1)
            if mode=="read-only":
                self.assertIn("error",json.loads((root/"cancel/manifest.json").read_text()))
                return
            if kind in ("profiles","listening"):
                self.assertTrue((root/"cancel/covered-preimage.json").exists())
                events=[json.loads(line)["event"] for line in (
                    root/"cancel/diagnostics.jsonl").read_text().splitlines()]
                self.assertIn("write-start",events)
                if mode=="disconnect-hang":self.assertIn("disconnect-start",events)
            if mode not in ("transport-hang","disconnect-hang"):
                state=json.loads((root/"cancel/transaction.json").read_text())
                self.assertNotIn(state["status"],("restored-and-verified","allocation-readback-verified","squelch-readback-verified"))
                self.assertTrue((root/"cancel/diagnostics.jsonl").exists())

    def test_pre_aborted_methods_do_not_spawn(self):
        for kind in ("readonly","profiles","listening","programming"):
            with self.subTest(kind=kind):self.run_case(kind,pre_abort=True)

    def test_cancellation_during_receipt_persistence_does_not_return_success(self):
        for kind in ("readonly","profiles","listening","programming"):
            with self.subTest(kind=kind):self.run_case(kind,
                mode="label-valid" if kind=="programming" else "valid",cancel_at_receipt=True)

    def test_cancellation_prevents_later_writes_and_label_stages(self):
        for kind,mode in (("profiles","before-write"),("profiles","after-write"),
                          ("listening","after-write"),("programming","label-stage"),
                          ("readonly","read-only")):
            with self.subTest(kind=kind,mode=mode):self.run_case(kind,mode)

    def test_resistant_transport_and_disconnect_are_killed_reaped_unlock(self):
        for mode in ("transport-hang","disconnect-hang"):
            with self.subTest(mode=mode):self.run_case(mode=mode)

    def test_deadline_and_stdin_failures_contain_child(self):
        for mode in ("blocked-stdin","closed-stdin","blocked-output"):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory(dir=BASE/"private") as temporary:
                root=Path(temporary)
                script=root/"stuck.py"
                script.write_text('import os,signal,time,fcntl\nfrom pathlib import Path\n'
                    'root=Path(__file__).parent\nf=open(root/"lock","w")\nfcntl.flock(f,fcntl.LOCK_EX)\n'
                    'signal.signal(signal.SIGTERM,signal.SIG_IGN)\n(root/"pid").write_text(str(os.getpid()))\n'+
                    ('os.close(0)\n' if mode=="closed-stdin" else '')+
                    ('import sys\nsys.stdin.read()\nprint("PRIVATE-TEST-SENTINEL",flush=True)\n' if mode=="blocked-output" else '')+
                    'while True:time.sleep(60)\n')
                config=dict(root=str(root),python=str(PYTHON),script=str(script),supervisor=True,
                            inputBytes=0 if mode=="blocked-output" else 4_000_000)
                path=root/"case.json";path.write_text(json.dumps(config))
                result=subprocess.run([str(DENO),"run","-A",str(TESTS/"cancellation_runner.ts"),str(path)],
                    env=ENV,text=True,capture_output=True,timeout=10)
                self.assertEqual(result.returncode,0,result.stderr)
                report=json.loads(result.stdout);self.assertTrue(report["rejected"])
                self.assertLess(report["elapsedMs"],4000)
                self.assertNotIn("PRIVATE-TEST-SENTINEL",result.stdout+result.stderr)
                with self.assertRaises(ProcessLookupError):os.kill(int((root/"pid").read_text()),0)
                with (root/"lock").open("a") as lock:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
