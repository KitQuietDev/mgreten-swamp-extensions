"""TD-H3 GMRS identification and partial-memory reads only; no config writes."""

import argparse
import asyncio
import hashlib
import json
import os
import platform
import struct
from datetime import datetime, timezone
from pathlib import Path

MAGIC = bytes.fromhex("50564f4a485c14")
IDENT = b"P31184\xff\xff"
NAME = "TD-H3"
NAMES = (NAME, "TIDRADIO TD-H3")
SERVICE = "0000ff00-0000-1000-8000-00805f9b34fb"
NOTIFY = "0000ff01-0000-1000-8000-00805f9b34fb"
COMMAND = "0000ff02-0000-1000-8000-00805f9b34fb"
BLOCK = 32
# Candidate vendor-read ranges, plus CHIRP's firmware-version read block.
# These are intentionally partial. Never fill gaps and call it a full backup.
RANGES = ((0, 0x1380), (0x1800, 0x18E0), (0x1900, 0x1980),
          (0x1B40, 0x1B60), (0x1C00, 0x1C40), (0x1F20, 0x1F40))
ADDRESSES = tuple(a for start, end in RANGES for a in range(start, end, BLOCK))


class ProtocolError(Exception):
    pass


class ReadOnlySession:
    """The sole GATT output boundary enforces both byte and phase allowlists."""

    def __init__(self, client, timeout=3.0):
        self.client = client
        self.timeout = timeout
        self.phase = "new"
        self.buffer = bytearray()
        self.ready = asyncio.Event()
        self.transcript = []

    def notification(self, _characteristic, data):
        if len(self.buffer) + len(data) > 128:
            self.phase = "failed"
        else:
            self.buffer.extend(data)
        self.ready.set()

    async def send(self, frame):
        permitted = frame == b"E" and self.phase != "closed"
        permitted |= self.phase == "new" and frame == MAGIC
        permitted |= self.phase == "magic-ack" and frame == b"\x02"
        permitted |= self.phase == "identified" and frame == b"\x06"
        if self.phase == "reading" and len(frame) == 4 and frame[:1] == b"R":
            _, address, size = struct.unpack(">cHB", frame)
            permitted |= address in ADDRESSES and size == BLOCK
        if not permitted:
            raise ProtocolError("Outgoing command rejected by read-only allowlist")
        self.transcript.append({"out": frame.hex()})
        await asyncio.wait_for(
            self.client.write_gatt_char(COMMAND, frame, response=False), self.timeout)
        if frame == b"E":
            self.phase = "closed"

    async def receive(self, size):
        async def collect():
            while len(self.buffer) < size:
                if self.phase == "failed":
                    raise ProtocolError("Notification buffer overflow")
                self.ready.clear()
                await self.ready.wait()
            if self.phase == "failed" or len(self.buffer) != size:
                raise ProtocolError("Unexpected response length")
            result = bytes(self.buffer)
            self.buffer.clear()
            self.transcript.append({"in": result.hex()})
            return result
        try:
            return await asyncio.wait_for(collect(), self.timeout)
        except BaseException:
            self.phase = "failed"
            raise

    async def identify(self):
        await self.send(MAGIC)
        if await self.receive(1) != b"\x06":
            raise ProtocolError("Programming handshake rejected")
        self.phase = "magic-ack"
        await self.send(b"\x02")
        identity = await self.receive(8)
        if identity != IDENT:
            self.phase = "failed"
            raise ProtocolError("Identity is not known TD-H3 GMRS: " + identity.hex())
        self.phase = "identified"
        await self.send(b"\x06")
        if await self.receive(1) != b"\x06":
            self.phase = "failed"
            raise ProtocolError("Clone acknowledgement rejected")
        self.phase = "reading"
        return identity

    async def read_block(self, address):
        request = struct.pack(">cHB", b"R", address, BLOCK)
        await self.send(request)
        reply = await self.receive(BLOCK + 5)
        if reply[:4] != b"W" + request[1:]:
            self.phase = "failed"
            raise ProtocolError("Read address/length/header mismatch")
        data = reply[4:-1]
        if sum(data) & 255 != reply[-1]:
            self.phase = "failed"
            raise ProtocolError("Read checksum mismatch")
        return data


def save_json(path, data):
    # Never overwrite a prior run. Output may contain private radio configuration.
    with path.open("x") as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")


async def scan():
    from bleak import BleakScanner
    devices = await asyncio.wait_for(
        BleakScanner.discover(timeout=8, return_adv=True), 12)
    candidates = []
    for device, advertisement in devices.values():
        name = advertisement.local_name or device.name
        if name in NAMES:
            candidates.append({"name": name, "uuid": device.address,
                               "rssi": advertisement.rssi})
    return {"td_h3_candidates": candidates,
            "other_devices_count": len(devices) - len(candidates),
            "connected": False}


async def capture(device_uuid, output):
    from bleak import BleakClient, BleakScanner
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    metadata = {"started_utc": datetime.now(timezone.utc).isoformat(),
                "device_uuid": device_uuid, "label_expected": "TD-H3 / 2A4FBTD831G",
                "expected_ident_hex": IDENT.hex(), "os": platform.platform(),
                "coverage": [{"start": start, "end_exclusive": end}
                             for start, end in RANGES],
                "complete_restore_backup": False, "status": "incomplete"}
    session = None
    try:
        device = await asyncio.wait_for(
            BleakScanner.find_device_by_address(device_uuid, timeout=8), 12)
        if device is None or device.name not in NAMES:
            raise ProtocolError("Selected UUID not found with exact TD-H3 name")
        metadata["advertised_name"] = device.name
        async with BleakClient(device, timeout=15) as client:
            service = client.services.get_service(SERVICE)
            if service is None:
                raise ProtocolError("Expected BLE service absent")
            notify = service.get_characteristic(NOTIFY)
            command = service.get_characteristic(COMMAND)
            metadata["gatt"] = {"service": SERVICE,
                                "notify_properties": notify.properties if notify else None,
                                "command_properties": command.properties if command else None}
            if (notify is None or command is None or "notify" not in notify.properties
                    or "write-without-response" not in command.properties):
                raise ProtocolError("Expected BLE characteristics/properties absent")
            session = ReadOnlySession(client)
            await asyncio.wait_for(client.start_notify(NOTIFY, session.notification), 5)
            try:
                metadata["ident_hex"] = (await session.identify()).hex()
                captures = []
                for pass_number in (1, 2):
                    blocks = []
                    for address in ADDRESSES:
                        data = await session.read_block(address)
                        blocks.append(data)
                        # Persist each validated reply, even if a later read fails.
                        with (output / ("pass%d-blocks.jsonl" % pass_number)).open("a") as log:
                            log.write(json.dumps({"address": address, "data": data.hex()}) + "\n")
                    raw = b"".join(blocks)
                    with (output / ("pass%d-covered-bytes.bin" % pass_number)).open("xb") as file:
                        file.write(raw)
                    captures.append(raw)
                metadata["sha256"] = [hashlib.sha256(raw).hexdigest() for raw in captures]
                if captures[0] != captures[1]:
                    raise ProtocolError("Two memory reads differ; no verified capture")
                metadata.update(status="two-matching-partial-reads", bytes_per_pass=len(captures[0]),
                                blocks_per_pass=len(ADDRESSES))
            finally:
                await session.send(b"E")
    except BaseException as error:
        metadata["error"] = type(error).__name__ + ": " + str(error)
        raise
    finally:
        if session is not None:
            save_json(output / "protocol-transcript.json", session.transcript)
        save_json(output / "manifest.json", metadata)
    return metadata


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("scan")
    read = commands.add_parser("read")
    read.add_argument("--device", required=True, help="User-confirmed Mac peripheral UUID")
    read.add_argument("--confirmed-radio-label", required=True, choices=["2A4FBTD831G"])
    read.add_argument("--output", type=Path, required=True, help="New private output directory")
    args = parser.parse_args()
    try:
        if args.command == "scan":
            result = asyncio.run(scan())
        else:
            result = asyncio.run(asyncio.wait_for(capture(args.device, args.output), 180))
        print(json.dumps(result, indent=2))
    except (Exception, KeyboardInterrupt) as error:
        parser.exit(1, type(error).__name__ + ": " + str(error) + "\n")


if __name__ == "__main__":
    main()
