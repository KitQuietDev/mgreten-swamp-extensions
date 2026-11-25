"""Test-only persistent in-memory radio; never imports real Bleak."""
import os
import runpy
import struct
import sys
import types

import offline_peer as read_peer

SCENARIO = os.environ.get("TDH3_TEST_SCENARIO", "valid")
MEMORY = read_peer.memory_bytes()
MEMORY[0x1E0:0x1F0] = MEMORY[0x90:0xA0]
MEMORY[0x1903] = 0x20
MEMORY[0xE20:0xE40] = b"NEIGHBOR  TST8 \0" + bytes(range(16))
ORIGINAL = bytes(MEMORY)
WRITES = []
CONNECTIONS = 0
if SCENARIO.startswith("recovery-"):
    SCENARIO = SCENARIO.removeprefix("recovery-")
    read_peer.SCENARIO = SCENARIO
    MEMORY[0xE2D] = 0x38 if SCENARIO == "already-original" else 0x58
    if SCENARIO == "stale":
        MEMORY[0x90] ^= 1
    if SCENARIO == "wrong-label":
        MEMORY[0xE2D] = 0x59


class Client(read_peer.Client):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        global CONNECTIONS
        CONNECTIONS += 1
        if SCENARIO == "lost-persistence" and CONNECTIONS == 2:
            MEMORY[:] = ORIGINAL

    async def __aexit__(self, *_args):
        assert read_peer.SENT[-1] == b"E"

    def get_characteristic(self, uuid):
        return types.SimpleNamespace(properties=["notify", "write-without-response"],
                                     max_write_without_response_size=(20 if SCENARIO == "mtu" else 100))

    async def write_gatt_char(self, characteristic, data, response):
        if data[:1] not in (b"W", b"R"):
            return await super().write_gatt_char(characteristic, data, response)
        read_peer.SENT.append(data)
        if data[:1] == b"W":
            assert len(data) == 37 and data[:4] == bytes.fromhex("570e2020")
            assert sum(data[4:36]) & 255 == data[36]
            assert [(i, a, b) for i, (a, b) in enumerate(zip(
                MEMORY[0xE20:0xE40], data[4:36])) if a != b] in (
                    [(13, 0x38, 0x58)], [(13, 0x58, 0x38)])
            WRITES.append(data)
            if SCENARIO != "ignored":
                MEMORY[0xE20:0xE40] = data[4:36]
            if SCENARIO == "collateral":
                MEMORY[0x90] ^= 1
            if SCENARIO == "transport":
                raise RuntimeError("PRIVATE-TEST-SENTINEL ambiguous transport")
            answer = b"\x15" if SCENARIO == "nack" else b"\x06"
            if SCENARIO == "no-ack":
                return
            if SCENARIO == "extra-ack":
                answer += b"\x06"
            if SCENARIO == "restore-nack" and len(WRITES) == 2:
                answer = b"\x15"
        else:
            _, address, size = struct.unpack(">cHB", data)
            assert size == 32 and address in read_peer.probe.ADDRESSES
            body = MEMORY[address:address + size]
            self.reads += 1
            if SCENARIO == "unstable" and self.reads > 171:
                body[0] ^= 1
            if SCENARIO == "stale-target" and self.reads == 343:
                body[0] ^= 1
            answer = b"W" + data[1:] + body + bytes([sum(body) & 255])
            if SCENARIO == "checksum":
                answer = answer[:-1] + bytes([answer[-1] ^ 1])
            if SCENARIO == "short-read":
                answer = answer[:-1]
        self.callback(None, answer)


if __name__ == "__main__":
    sys.modules["bleak"] = types.SimpleNamespace(
        BleakClient=Client, BleakScanner=read_peer.Scanner)
    runpy.run_path(sys.argv[-1], run_name="__main__")
