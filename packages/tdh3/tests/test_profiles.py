"""Offline allocation contract, exact boundaries and actual Swamp preview."""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

from test_support import BASE, ENV, PYTHON
import bridge
import profiles

PROBE, DECODER = bridge.modules()
FIRST = dict(slot=31, label="TEST625", rxHz=462625000, txToneTenths=2035)


def fixture():
    raw = bytearray(b"\xa6" * 0x2000)
    # Literal independent factory records, no encoder-derived expectations.
    records = ["0050254600507546", "0075254600757546", "0000264600007646",
               "0025264600257646", "0050264600507646", "0075264600757646",
               "0000274600007746", "0025274600257746"]
    for n, head in enumerate(records, 23):
        raw[n*16:n*16+16] = bytes.fromhex(head + "ffffffff00001000")
        raw[0x1900+(n-1)//8] |= 1 << ((n-1) % 8)
    for n in range(31, 41):
        raw[n*16:n*16+16] = b"\xff" * 16
        a = 0xD40 + (n-1)*8
        raw[a:a+8] = bytes(8)
        for base in (0x1900, 0x1920):
            raw[base+(n-1)//8] &= ~(1 << ((n-1) % 8))
    return raw


def memory(raw):
    return DECODER.SparseMemory([(a, raw[a:a+32]) for a in PROBE.ADDRESSES])


class ProfileTests(unittest.TestCase):
    def test_first_allocation_exact_record_and_shared_neighbors(self):
        raw = fixture()
        result = profiles.plan(memory(raw), PROBE, DECODER, [FIRST])
        self.assertEqual([b["address"] for b in result["blocks"]],
                         [0x1E0, 0xE20, 0x1900, 0x1920])
        patched = bytearray(raw)
        for b in result["blocks"]:
            patched[b["address"]:b["address"]+32] = bytes.fromhex(b["after"])
        self.assertEqual(patched[0x1F0:0x200], bytes.fromhex(
            "0025264600257646ffff352000001000"))
        self.assertEqual(patched[0xE30:0xE38], b"TEST625\0")
        allowed = set(range(0x1F0, 0x200)) | set(range(0xE30, 0xE38)) | {0x1903, 0x1923}
        self.assertTrue(all(x == y for a, (x, y) in enumerate(zip(raw, patched)) if a not in allowed))
        self.assertEqual(patched[0x1903], raw[0x1903] | 0x40)
        self.assertEqual(patched[0x1923], raw[0x1923] | 0x40)
        self.assertEqual(patched[0xE20:0xE30], raw[0xE20:0xE30])
        self.assertEqual(patched[0x1E0:0x1F0], raw[0x1E0:0x1F0])
        self.assertFalse(result["firmwareAllocationVerified"])

    def test_bitmap_boundary_and_rx_tx_tone_direction(self):
        raw = fixture()
        request = [FIRST, dict(slot=32, label="OTHER", rxHz=462550000, txToneTenths=797),
                   dict(slot=33, label="THIRD", rxHz=462675000, txToneTenths=1413)]
        result = profiles.plan(memory(raw), PROBE, DECODER, request)
        for block in result["blocks"]:
            a = block["address"]
            raw[a:a+32] = bytes.fromhex(block["after"])
        self.assertEqual(raw[0x1903] & 0xC0, 0xC0)
        self.assertEqual(raw[0x1904] & 1, 1)
        self.assertEqual(raw[0x1923] & 0xC0, 0xC0)
        self.assertEqual(raw[0x1924] & 1, 1)
        self.assertEqual(raw[0x208:0x20C], bytes.fromhex("ffff9707"))
        self.assertEqual(raw[0x218:0x21C], bytes.fromhex("ffff1314"))
        decoded = DECODER.channel(memory(raw), 33)
        self.assertEqual((decoded["rx_hz"], decoded["tx_hz"]), (462675000, 467675000))
        self.assertEqual(decoded["rx_tone"]["kind"], "Off")
        self.assertEqual(decoded["tx_tone"]["hz"], 141.3)
        self.assertTrue(decoded["used_bitmap"] and decoded["scan_included"])

    def test_reject_occupied_inconsistent_templates_and_invalid_profiles(self):
        for address in (0x1FF, 0xE30, 0x1903, 0x1923, 0x1AC, 0x1AD, 0x1AE):
            raw = fixture()
            raw[address] ^= 0x40 if address in (0x1903, 0x1923) else 1
            with self.subTest(address=address), self.assertRaises(bridge.BridgeError):
                profiles.plan(memory(raw), PROBE, DECODER, [FIRST])
        for change in (dict(slot=30), dict(slot=41), dict(slot=True), dict(label="ninechars"),
                       dict(rxHz=462612500), dict(rxHz=467625000), dict(txToneTenths=1622),
                       dict(label="é"), dict(txHz=467625000), dict(label=" BAD")):
            with self.subTest(change=change), self.assertRaises(bridge.BridgeError):
                profiles.plan(memory(fixture()), PROBE, DECODER, [dict(FIRST, **change)])
        with self.assertRaises(bridge.BridgeError):
            profiles.plan(memory(fixture()), PROBE, DECODER, [FIRST, FIRST])

    def test_actual_swamp_preview_trust_privacy_and_no_overwrite(self):
        with tempfile.TemporaryDirectory(dir=BASE / "private") as temporary:
            root = Path(temporary)
            saved = root / "capture"
            saved.mkdir(mode=0o700)
            raw = fixture()
            covered = b"".join(raw[a:a+32] for a in PROBE.ADDRESSES)
            digest = hashlib.sha256(covered).hexdigest()
            manifest = dict(status="two-matching-partial-reads", ident_hex=PROBE.IDENT.hex(),
                complete_restore_backup=False, blocks_per_pass=171, bytes_per_pass=5472,
                coverage=[dict(start=a, end_exclusive=b) for a,b in PROBE.RANGES], sha256=[digest]*2)
            (saved / "manifest.json").write_text(json.dumps(manifest))
            for n in (1, 2):
                (saved / f"pass{n}-covered-bytes.bin").write_bytes(covered)
                (saved / f"pass{n}-blocks.jsonl").write_text("\n".join(json.dumps(
                    dict(address=a, data=raw[a:a+32].hex())) for a in PROBE.ADDRESSES))
            for file in saved.iterdir():
                file.chmod(0o600)
            name = "profile-test-" + uuid.uuid4().hex[:8]

            def command(*args):
                return subprocess.run(["swamp", *args, "--json", "--no-telemetry"],
                    cwd=BASE, env=ENV, text=True, capture_output=True, timeout=60)

            result = command("behavior", "create", "@mgreten/tdh3-profiles", name,
                "--global-arg", "pythonPath="+str(PYTHON), "--global-arg", "privateRoot="+str(root))
            self.assertEqual(result.returncode, 0, result.stderr)
            args = dict(runId="preview", capturePath=str(saved), expectedSha256=digest,
                        trustPolicy=bridge.POLICY, profiles=[FIRST])
            try:
                for expected, change in ((False, dict(expectedSha256="0"*64)),
                                         (True, {}), (False, {})):
                    result = command("behavior", "run", name, "preview", "--literal-inputs",
                                     "--input", json.dumps(dict(args, **change)))
                    self.assertEqual(result.returncode == 0, expected, result.stdout+result.stderr)
                    self.assertNotIn(FIRST["label"], result.stdout+result.stderr)
                    if expected:
                        receipt = json.loads(result.stdout)["dataArtifacts"][0]["attributes"]
                        self.assertEqual(receipt["blocks"], 4)
                        self.assertEqual(receipt["status"], "offline-preview-only")
                file = root / "preview/plan.json"
                self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            finally:
                result = command("behavior", "delete", name, "--force")
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
