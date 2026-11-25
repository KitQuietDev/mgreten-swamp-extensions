"""TEST ONLY: inject an in-memory Bleak peer before executing the real bridge.

No real Bleak import is possible in this process. Not referenced by the model
or production behavior; test_swamp.py creates a disposable launcher for it.
"""
import json
import os
from pathlib import Path
import runpy
import struct
import sys
import types

SCENARIO = os.environ.get("TDH3_TEST_SCENARIO", "valid")
UUID = "11111111-2222-3333-2444-555555555555"
OTHER_UUID = "aaaaaaaa-bbbb-3ccc-8ddd-eeeeeeeeeeee"
SENT = []
SOURCE = Path(__file__).resolve().parent.parent / "extensions/models/tdh3/runtime"
sys.path.insert(0, str(SOURCE))
import probe


def memory_bytes():
    memory = bytearray(0x2000)
    if SCENARIO == "fixture":
        memory[0] = 99
    memory[16:200 * 16] = bytes([255]) * (199 * 16)
    # Slot 9: asymmetric RX/TX tones, +5MHz split, high/wide; no other used slots.
    memory[0x90:0xA0] = bytes.fromhex("00252646 00257646 8508 1314 00001000")
    memory[0xD80:0xD88] = b"NINE\0\0\0\0"
    memory[0x1901] = 1
    memory[0x1920] = 255  # Wrong bit indexing would incorrectly include slot 9.
    memory[0xCA9] = 7
    memory[0xCA1] = 0x80  # SE, not the real saved snapshot's CO.
    for address in (0x1950, 0x1960):
        memory[address:address + 16] = bytes.fromhex("00205516 ffffffff ffff ffff 00002000")
    return memory


class Scanner:
    @staticmethod
    async def discover(timeout, return_adv):
        assert timeout == 8 and return_adv is True
        count = 0 if SCENARIO == "zero" else 2
        return {uuid: (types.SimpleNamespace(name="TD-H3", address=uuid),
                       types.SimpleNamespace(local_name="TD-H3", rssi=-40 - n))
                for n, uuid in enumerate((UUID, OTHER_UUID)[:count])}

    @staticmethod
    async def find_device_by_address(uuid, timeout):
        assert uuid == UUID and timeout == 8
        if SCENARIO == "missing":
            return None
        return types.SimpleNamespace(name="TD-H3")


class Client:
    def __init__(self, *_args, **_kwargs):
        self.services = self
        self.reads = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        assert SENT[-1] == b"E"
        assert not any(frame.startswith(b"W") for frame in SENT)

    def get_service(self, uuid):
        assert uuid == probe.SERVICE
        return self

    def get_characteristic(self, uuid):
        assert uuid in (probe.NOTIFY, probe.COMMAND)
        return types.SimpleNamespace(properties=["notify", "write-without-response"])

    async def start_notify(self, uuid, callback):
        assert uuid == probe.NOTIFY
        self.callback = callback

    async def write_gatt_char(self, characteristic, data, response):
        assert characteristic == probe.COMMAND and response is False
        SENT.append(data)
        if data in (probe.MAGIC, b"\x06"):
            answer = b"\x06"
        elif data == b"\x02":
            answer = b"P31185\xff\xff" if SCENARIO == "identity" else probe.IDENT
        elif data[:1] == b"R":
            _, address, size = struct.unpack(">cHB", data)
            assert address in probe.ADDRESSES and size == 32
            self.reads += 1
            body = memory_bytes()[address:address + 32]
            if SCENARIO == "different" and self.reads > 171:
                body[0] ^= 1
            answer = b"W" + data[1:] + body + bytes([sum(body) & 255])
        elif data == b"E":
            return
        else:
            raise AssertionError("Non-allowlisted command")
        self.callback(None, answer[:3])
        self.callback(None, answer[3:])


if __name__ == "__main__":
    sys.modules["bleak"] = types.SimpleNamespace(BleakClient=Client, BleakScanner=Scanner)
    if SCENARIO == "stderr":
        print("PRIVATE-TEST-SENTINEL: device/config must not leak", file=sys.stderr)
        sys.exit(1)
    if SCENARIO == "malformed":
        print('{"ok":true,"result":{"private":"PRIVATE-TEST-SENTINEL"}}')
        sys.exit(0)
    if SCENARIO == "invalid-json":
        print("PRIVATE-TEST-SENTINEL invalid JSON")
        sys.exit(0)
    if SCENARIO == "private-key":
        print('{"ok":true,"PRIVATE-TEST-SENTINEL":true}')
        sys.exit(0)
    if SCENARIO == "missing-digest":
        print(json.dumps({"ok": True, "result": {
            "operation": "decode", "privatePath": "/private/test", "partialCapture": True,
            "completeRestoreBackup": False, "firmware": "Unknown", "liveChannel": "Unknown",
            "populated": 1, "empty": 198, "unknowns": []}}))
        sys.exit(0)
    runpy.run_path(sys.argv[-1], run_name="__main__")
