"""Test-only persistent synthetic GMRS peer; no real Bleak import."""
import json
import os
from pathlib import Path
import runpy
import struct
import sys
import types

import offline_peer as peer

ROOT = Path(os.environ["TDH3_TEST_ROOT"])
MEMORY = bytearray((ROOT / "memory.bin").read_bytes())
PLAN = json.loads((ROOT / "expected-plan.json").read_text())
SCENARIO = os.environ.get("TDH3_TEST_SCENARIO", "valid")
WRITES = 0
if SCENARIO == "stale":
    MEMORY[0] ^= 1
if SCENARIO == "vox":
    MEMORY[0xCA7] |= 1


class Client(peer.Client):
    async def __aexit__(self, *_args):
        assert peer.SENT[-1] == b"E"

    def get_characteristic(self, uuid):
        return types.SimpleNamespace(properties=["notify", "write-without-response"],
                                     max_write_without_response_size=20 if SCENARIO == "mtu" else 100)

    async def write_gatt_char(self, characteristic, data, response):
        global WRITES
        if data[:1] not in (b"W", b"R"):
            return await super().write_gatt_char(characteristic, data, response)
        peer.SENT.append(data)
        if data[:1] == b"W":
            planned = PLAN["blocks"][WRITES]
            WRITES += 1
            assert len(data) == 37 and data[:4] == struct.pack(">cHB", b"W", planned["address"], 32)
            assert data[4:36] == bytes.fromhex(planned["after"])
            assert sum(data[4:36]) & 255 == data[-1]
            kind, _, number = SCENARIO.partition("-")
            fail = number == str(WRITES)
            if not (fail and kind == "ignored"):
                MEMORY[planned["address"]:planned["address"]+32] = data[4:36]
            if fail and kind == "collateral":
                MEMORY[0] ^= 1
            if fail and kind == "transport":
                raise RuntimeError("PRIVATE-TEST-SENTINEL ambiguous write")
            if fail and kind == "drop":
                return
            answer = b"\x15" if fail and kind == "nack" else b"\x06"
            if fail and kind == "extra":
                answer += b"\x06"
        else:
            _, address, size = struct.unpack(">cHB", data)
            assert address in peer.probe.ADDRESSES and size == 32
            self.reads += 1
            body = MEMORY[address:address+size]
            if SCENARIO == "stale-target" and self.reads == 343:
                body[0] ^= 1
            answer = b"W" + data[1:] + body + bytes([sum(body) & 255])
        self.callback(None, answer)


if __name__ == "__main__":
    sys.modules["bleak"] = types.SimpleNamespace(BleakClient=Client, BleakScanner=peer.Scanner)
    runpy.run_path(sys.argv[-1], run_name="__main__")
