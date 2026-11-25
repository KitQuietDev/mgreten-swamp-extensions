"""Synthetic transport barriers; no real Bleak import or Bluetooth calls."""
import asyncio
import json
import os
from pathlib import Path
import runpy
import sys
import types

import allocation_peer as allocation
import programming_peer as programming

ROOT = Path(os.environ["TDH3_TEST_ROOT"])
MODE = os.environ["TDH3_CANCEL_MODE"]
BASE = programming.Client if MODE.startswith("label-") else allocation.Client
WRITES = []
CONNECTIONS = 0


async def barrier(resistant=False):
    (ROOT/"ready.json").write_text(json.dumps(dict(pid=os.getpid(), writes=WRITES,
                                                connections=CONNECTIONS)))
    while True:
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            if not resistant:
                raise


class Client(BASE):
    async def __aenter__(self):
        global CONNECTIONS
        CONNECTIONS += 1
        return await super().__aenter__()

    async def __aexit__(self, *args):
        if MODE in ("disconnect-hang", "label-stage"):
            await barrier(MODE == "disconnect-hang")
        return await super().__aexit__(*args)

    async def write_gatt_char(self, characteristic, data, response):
        if MODE == "before-write" and data[:1] == b"W":
            await barrier()
        result = await super().write_gatt_char(characteristic, data, response)
        if MODE == "read-only" and data[:1] == b"R":
            await barrier()
        if data[:1] == b"W":
            WRITES.append(int.from_bytes(data[1:3], "big"))
            (ROOT/"writes.json").write_text(json.dumps(WRITES))
            if MODE in ("after-write", "transport-hang"):
                await barrier(MODE == "transport-hang")
        return result


if __name__ == "__main__":
    sys.modules["bleak"] = types.SimpleNamespace(BleakClient=Client,
                                               BleakScanner=allocation.peer.Scanner)
    runpy.run_path(sys.argv[-1], run_name="__main__")
