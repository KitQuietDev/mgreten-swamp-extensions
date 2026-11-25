import asyncio
import hashlib
import json
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from probe import ADDRESSES, COMMAND, IDENT, MAGIC, NAME, ProtocolError, ReadOnlySession, capture


class Radio:
    """In-memory protocol peer; never imports or accesses Bluetooth."""

    def __init__(self, identity=IDENT, damage=None):
        self.identity = identity
        self.damage = damage
        self.sent = []
        self.session = ReadOnlySession(self, timeout=0.02)

    async def write_gatt_char(self, characteristic, data, response):
        assert characteristic == COMMAND and response is False
        self.sent.append(data)
        if data == MAGIC or data == b"\x06":
            answer = b"\x06"
        elif data == b"\x02":
            answer = self.identity
        elif data[:1] == b"R":
            # Asymmetric data catches checksums over wrong slices/addresses.
            body = bytes((i * 7 + data[2] + 13) % 256 for i in range(32))
            answer = b"W" + data[1:] + body + bytes([sum(body) & 255])
            if self.damage == "checksum":
                answer = answer[:-1] + bytes([answer[-1] ^ 0x80])
            elif self.damage == "address":
                answer = answer[:2] + bytes([answer[2] ^ 0x20]) + answer[3:]
            elif self.damage == "length":
                answer = answer[:3] + b"\x1f" + answer[4:]
            elif self.damage == "truncated":
                answer = answer[:-2]
            elif self.damage == "extra":
                answer += b"\x00"
        elif data == b"E":
            return
        else:
            raise AssertionError("Unexpected outgoing command")
        # Fragment packets to exercise reassembly independently of BLE MTU.
        self.session.notification(None, answer[:3])
        self.session.notification(None, answer[3:])


class SafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_valid_identity_reads_and_exact_outgoing_commands(self):
        radio = Radio()
        self.assertEqual(await radio.session.identify(), b"P31184\xff\xff")
        for address in (0x20, 0x1B40, ADDRESSES[-1]):
            result = await radio.session.read_block(address)
            self.assertEqual(result, bytes((i * 7 + (address & 255) + 13) % 256
                                           for i in range(32)))
        await radio.session.send(b"E")
        self.assertEqual(radio.sent, [bytes.fromhex("50564f4a485c14"), b"\x02", b"\x06",
                                     b"R\x00\x20\x20", b"R\x1b\x40\x20",
                                     b"R\x1f\x20\x20", b"E"])

    async def test_wrong_or_truncated_identity_never_reads(self):
        for identity in (b"P31185\xff\xff", b"P31183\xff\xff", b"P31184\xff",
                         b"P31184\xff\xff\x00"):
            with self.subTest(identity=identity):
                radio = Radio(identity=identity)
                with self.assertRaises((ProtocolError, asyncio.TimeoutError)):
                    await radio.session.identify()
                self.assertEqual(radio.sent, [MAGIC, b"\x02"])

    async def test_bad_checksum_header_size_and_truncation_fail_closed(self):
        for damage in ("checksum", "address", "length", "truncated", "extra"):
            with self.subTest(damage=damage):
                radio = Radio(damage=damage)
                await radio.session.identify()
                with self.assertRaises((ProtocolError, asyncio.TimeoutError)):
                    await radio.session.read_block(0x20)
                await radio.session.send(b"E")
                self.assertEqual(radio.sent[-1], b"E")

    async def test_all_phases_reject_writes_mode_unknown_and_out_of_bounds(self):
        radio = Radio()
        for phase in ("new", "magic-ack", "identified", "reading", "failed", "closed"):
            radio.session.phase = phase
            # Reject even checksum-valid write frames and near-boundary reads.
            for frame in (b"W\x00\x20\x20" + bytes(33), b"RESET", b"\x00",
                          b"R\x13\x80\x20", b"R\x00\x01\x20",
                          b"R\x1f\x40\x20", b"R\x00\x20\x1f"):
                with self.subTest(phase=phase, frame=frame):
                    with self.assertRaises(ProtocolError):
                        await radio.session.send(frame)
        self.assertEqual(radio.sent, [])

    async def test_reads_forbidden_before_gmrs_identification(self):
        radio = Radio()
        with self.assertRaises(ProtocolError):
            await radio.session.read_block(0)
        self.assertEqual(radio.sent, [])

    async def test_silent_peer_and_overflow_are_bounded(self):
        session = Radio().session
        with self.assertRaises(asyncio.TimeoutError):
            await session.receive(8)
        with self.assertRaises(ProtocolError):
            await session.read_block(0)
        session.notification(None, bytes(129))
        with self.assertRaises(ProtocolError):
            await session.receive(8)

    async def test_two_pass_capture_persists_verified_data_and_rejects_difference(self):
        for change_second_pass in (False, True):
            with self.subTest(change_second_pass=change_second_pass):
                radio = Radio()
                class Client:
                    def __init__(self, *_args, **_kwargs):
                        self.services = self
                        self.reads = 0

                    async def __aenter__(self):
                        return self

                    async def __aexit__(self, *_args):
                        pass

                    def get_service(self, _uuid):
                        return self

                    def get_characteristic(self, _uuid):
                        return types.SimpleNamespace(properties=["notify", "write-without-response"])

                    async def start_notify(self, _uuid, callback):
                        radio.session.notification = callback

                    async def write_gatt_char(self, characteristic, data, response):
                        if data[:1] == b"R":
                            self.reads += 1
                        if change_second_pass and self.reads == len(ADDRESSES) + 1:
                            # A different but checksum-valid reply on pass two.
                            original = radio.session.notification
                            def changed(_characteristic, chunk):
                                if len(chunk) > 3:
                                    chunk = bytearray(chunk)
                                    chunk[1] = (chunk[1] + 1) & 255
                                    chunk[-1] = (chunk[-1] + 1) & 255
                                original(_characteristic, chunk)
                            radio.session.notification = changed
                        await radio.write_gatt_char(characteristic, data, response)

                class Scanner:
                    @staticmethod
                    async def find_device_by_address(_uuid, timeout):
                        return types.SimpleNamespace(name=NAME)

                fake = types.SimpleNamespace(BleakClient=Client, BleakScanner=Scanner)
                with tempfile.TemporaryDirectory() as directory:
                    output = Path(directory) / "capture"
                    with patch.dict("sys.modules", {"bleak": fake}):
                        if change_second_pass:
                            with self.assertRaisesRegex(ProtocolError, "Two memory reads differ"):
                                await capture("explicit-test-device", output)
                        else:
                            await capture("explicit-test-device", output)
                    manifest = json.loads((output / "manifest.json").read_text())
                    self.assertFalse(manifest["complete_restore_backup"])
                    first = (output / "pass1-covered-bytes.bin").read_bytes()
                    self.assertEqual(manifest["sha256"][0], hashlib.sha256(first).hexdigest())
                    self.assertEqual(len(first), 5472)
                    self.assertEqual(manifest["status"], "incomplete" if change_second_pass
                                     else "two-matching-partial-reads")
                    self.assertEqual(radio.sent[-1], b"E")
                    self.assertFalse(any(frame[:1] == b"W" for frame in radio.sent))


if __name__ == "__main__":
    unittest.main()
