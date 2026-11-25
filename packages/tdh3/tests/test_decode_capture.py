import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from decode_capture import DecodeError, SparseMemory, channel, globals_decode, load_capture, record, tone


class DecoderTests(unittest.TestCase):
    def test_asymmetric_rx_tx_tones_and_offset(self):
        # Literal wire bytes: RX462.625, TX467.625; RX88.5Hz, TX141.3Hz.
        decoded = record(bytes.fromhex("00252646 00257646 8508 1314 00001000"))
        self.assertEqual(decoded["rx_hz"], 462625000)
        self.assertEqual(decoded["tx_hz"], 467625000)
        self.assertEqual(decoded["stored_path"], "+5 MHz repeater")
        self.assertEqual(decoded["rx_tone"]["hz"], 88.5)
        self.assertEqual(decoded["tx_tone"]["hz"], 141.3)
        self.assertEqual(decoded["power"], "High")
        self.assertEqual(decoded["bandwidth"], "Wide")

    def test_dcs_digits_direction_and_polarity_are_independent(self):
        decoded = record(bytes.fromhex("50622546 50622546 2380 54c7 00000800"))
        self.assertEqual(decoded["rx_tone"]["display"], "DCS 023N")
        self.assertEqual(decoded["tx_tone"]["display"], "DCS 754R")
        self.assertEqual(tone(bytes.fromhex("23c0"))["display"], "DCS 023R")
        self.assertEqual(tone(bytes.fromhex("5487"))["display"], "DCS 754N")
        self.assertEqual(decoded["power"], "Low")
        self.assertEqual(decoded["bandwidth"], "Narrow")

    def test_disabled_tx_no_tone_and_invalid_encoding(self):
        decoded = record(bytes.fromhex("00205516 ffffffff 0000 ffff 00002000"))
        self.assertIsNone(decoded["tx_hz"])
        self.assertEqual(decoded["stored_path"], "RX-only (TX bytes disabled)")
        self.assertEqual(decoded["rx_tone"]["kind"], "Off")
        self.assertEqual(decoded["tx_tone"]["kind"], "Off")
        self.assertEqual(decoded["power"], "Unknown raw 2")
        self.assertEqual(tone(bytes.fromhex("8998"))["kind"], "Unknown")
        with self.assertRaises(DecodeError):
            record(bytes.fromhex("a0205516 ffffffff ffff ffff 00000000"))

    def test_slot_number_name_and_little_endian_scan_bitmap(self):
        # Slot9 must use record0x90, name0xD80 and bitmap bit0 at second byte.
        memory = SparseMemory([(0x90, bytes.fromhex("50622546 50622546 ffff ffff 00001000")),
                               (0xD80, b"NINE\x00\x00\x00\x00"),
                               (0x1900, b"\x00\x01"), (0x1920, b"\xff\x00")])
        decoded = channel(memory, 9)
        self.assertEqual(decoded["number"], 9)
        self.assertEqual(decoded["label"], "NINE")
        self.assertTrue(decoded["used_bitmap"])
        self.assertFalse(decoded["scan_included"])

    def test_empty_slot_ignores_stale_name_and_sparse_gaps_never_fill(self):
        memory = SparseMemory([(0x30, bytes([255]) * 16), (0x1900, b"\x00")])
        self.assertTrue(channel(memory, 3)["empty"])
        with self.assertRaisesRegex(DecodeError, "Uncaptured address"):
            memory.read(0x3F, 2)
        with self.assertRaisesRegex(DecodeError, "Overlapping"):
            SparseMemory([(10, b"ab"), (11, b"z")])

    def test_asymmetric_global_bits_and_unknown_enum_are_not_defaults(self):
        settings = bytes.fromhex("00 80 05 12 11 08 00 04 00 09 00 00 05 00 01 80")
        vfos = bytes.fromhex("00205516 00205516 ffff ffff 00001000") * 2
        result = globals_decode(SparseMemory([(0xCA0, settings), (0x1950, vfos)]))
        self.assertEqual(result["squelch"]["value"], 9)
        self.assertEqual(result["vox_gain"]["value"], "4")
        self.assertEqual(result["vox_delay"]["value"], "2.0 s")
        self.assertEqual(result["scan_mode"]["value"], "SE")
        self.assertEqual(result["dual_watch"]["value"], "Off")
        self.assertEqual(result["a_stored_workmode"]["value"], "VFO+CH")
        self.assertEqual(result["b_stored_workmode"]["value"], "CH Mode")
        self.assertEqual(result["a_display"]["value"], "Name")
        self.assertEqual(result["b_display"]["value"], "Name")
        self.assertEqual(result["only_channel_mode"]["value"], "On")
        changed = bytearray(settings)
        changed[1] = 0xC0
        changed[9] = 255
        result = globals_decode(SparseMemory([(0xCA0, changed), (0x1950, vfos)]))
        self.assertEqual(result["scan_mode"]["value"], "Unknown raw 3")
        self.assertEqual(result["squelch"]["value"], "Unknown raw 255")

    def test_loader_reassembles_sparse_address_logs_and_detects_tampering(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            # Concatenation offset32 is real address0x1900, NOT address32.
            first = bytes(range(32))
            last = bytes(range(100, 132))
            raw = first + last
            digest = hashlib.sha256(raw).hexdigest()
            manifest = {"status": "two-matching-partial-reads", "ident_hex": "503331313834ffff",
                        "coverage": [{"start": 0, "end_exclusive": 32},
                                     {"start": 0x1900, "end_exclusive": 0x1920}],
                        "blocks_per_pass": 2, "bytes_per_pass": 64, "sha256": [digest, digest]}
            (folder / "manifest.json").write_text(json.dumps(manifest))
            for n in (1, 2):
                (folder / ("pass%d-covered-bytes.bin" % n)).write_bytes(raw)
                records = [{"address": 0, "data": first.hex()}, {"address": 0x1900, "data": last.hex()}]
                (folder / ("pass%d-blocks.jsonl" % n)).write_text("\n".join(json.dumps(r) for r in records))
            memory, _ = load_capture(folder, digest)
            self.assertEqual(memory.read(0x1900, 3), b"def")
            with self.assertRaises(DecodeError):
                memory.read(32, 1)
            (folder / "pass2-covered-bytes.bin").write_bytes(raw[:-1] + b"\x00")
            with self.assertRaisesRegex(DecodeError, "hash mismatch"):
                load_capture(folder, digest)


if __name__ == "__main__":
    unittest.main()
