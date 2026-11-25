"""Constrained application of a reviewed, independently regenerated slot plan.

No arbitrary addresses, rollback, retry, RF or full-image programming entrypoint.
"""
import asyncio
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
import traceback

import bridge
import profiles
import cancellation
from programming import twice


async def apply(request, output, probe, before, plan):
    from bleak import BleakClient, BleakScanner
    transcript = []
    state = dict(status="incomplete", writesAttempted=0, blocksVerified=[],
                 completeRestoreBackup=False, persistenceVerified=False)
    diagnostic = output / "diagnostics.jsonl"
    diagnostic.touch(mode=0o600, exist_ok=False)
    stage = "starting"

    def trace(event, **details):
        nonlocal stage
        stage = event
        with diagnostic.open("a") as stream:
            stream.write(json.dumps(dict(time=datetime.now(timezone.utc).isoformat(),
                event=event, **details)) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    class AllocationSession(probe.ReadOnlySession):
        def __init__(self, client):
            super().__init__(client)
            self.transcript = transcript
            self.permit = None
            self.written = set()

        async def send(self, frame):
            if frame != b"E":
                cancellation.check()
            if frame[:1] != b"W":
                return await super().send(frame)
            address = int.from_bytes(frame[1:3], "big")
            bridge.require(self.phase == "reading" and frame == self.permit and
                           address not in self.written, "write_not_permitted")
            self.permit = None
            self.written.add(address)
            state["writesAttempted"] += 1
            trace("write-start", address=address, attempt=state["writesAttempted"])
            self.transcript.append(dict(out=frame.hex()))
            await asyncio.wait_for(self.client.write_gatt_char(
                probe.COMMAND, frame, response=False), self.timeout)
            trace("write-returned", address=address)

    session = None
    try:
        trace("lookup-start")
        device = await asyncio.wait_for(BleakScanner.find_device_by_address(
            request["deviceUuid"], timeout=8), 12)
        bridge.require(device is not None and device.name in probe.NAMES, "device_unavailable")
        trace("connect-start")
        async with BleakClient(device, timeout=15) as client:
            trace("connect-returned")
            service = client.services.get_service(probe.SERVICE)
            bridge.require(service is not None, "gatt_unavailable")
            command = service.get_characteristic(probe.COMMAND)
            notify = service.get_characteristic(probe.NOTIFY)
            bridge.require(command is not None and notify is not None and
                "notify" in notify.properties and
                "write-without-response" in command.properties and
                command.max_write_without_response_size >= 37, "gatt_unavailable")
            session = AllocationSession(client)
            trace("notify-start")
            await asyncio.wait_for(client.start_notify(probe.NOTIFY, session.notification), 5)
            trace("notify-returned")
            try:
                trace("identity-start")
                await session.identify()
                trace("preimage-start")
                bridge.require(await twice(session, probe) == before, "stale_preimage")
                # VOX must remain Off; never turn it off implicitly.
                bridge.require(before[0xCA0][7] & 7 == 0, "vox_not_off")
                probe.save_json(output / "covered-preimage.json",
                                {str(a): b.hex() for a, b in before.items()})
                probe.save_json(output / "reviewed-plan.json", plan)
                for file in ("covered-preimage.json", "reviewed-plan.json"):
                    with (output / file).open("rb") as stream:
                        os.fsync(stream.fileno())
                fd = os.open(output, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
                expected = dict(before)
                for block in plan["blocks"]:
                    address, after = block["address"], bytes.fromhex(block["after"])
                    trace("target-precondition-start", address=address)
                    bridge.require(await session.read_block(address) == expected[address],
                                   "stale_target")
                    frame = struct.pack(">cHB", b"W", address, 32) + after + bytes([sum(after) & 255])
                    session.permit = frame
                    await session.send(frame)
                    trace("ack-start", address=address)
                    bridge.require(await session.receive(1) == b"\x06", "write_ack_unknown")
                    trace("target-readback-start", address=address)
                    for _ in range(2):
                        bridge.require(await session.read_block(address) == after, "readback_mismatch")
                    expected[address] = after
                    trace("covered-readback-start", address=address)
                    bridge.require(await twice(session, probe) == expected, "covered_state_mismatch")
                    state["blocksVerified"].append(address)
                    trace("block-verified", address=address)
                state["status"] = ("squelch-readback-verified" if plan.get("setting") == "squelch"
                                   else "allocation-readback-verified")
            finally:
                pending = sys.exc_info()[0] is not None
                try:
                    trace("exit-start")
                    await session.send(b"E")
                    trace("exit-returned")
                except BaseException as error:
                    trace("exit-failed", error=repr(error))
                    if not pending:
                        raise
            trace("disconnect-start")
        trace("disconnect-returned")
        cancellation.check()
        result = dict(status=state["status"], privatePath=str(output),
                    writes=state["writesAttempted"],
                    afterSha256=plan["afterSha256"], completeRestoreBackup=False,
                    persistenceVerified=False)
        if "profiles" in plan:
            result["profiles"] = len(plan["profiles"])
        return result
    except BaseException as error:
        trace("operation-failed", failedStage=stage, exceptionType=type(error).__name__,
              error=repr(error), traceback=traceback.format_exc())
        state["status"] = "incomplete"
        raise
    finally:
        probe.save_json(output / "transaction.json", state)
        probe.save_json(output / "protocol-transcript.json", transcript)


def run(request, *, squelch=False):
    # Internal selection only: no request parameter can broaden a profile plan
    # into settings writes. The separate listening entrypoint selects SQL2.
    fields = {
        "runId", "deviceUuid", "planPath", "planSha256", "capturePath", "expectedSha256",
        "trustPolicy", "ownerConfirmed", "radioReadyConfirmed", "programmingAuthorized"
    }
    if not squelch:
        fields.add("inactiveTargetSlotsConfirmed")
    bridge.require(isinstance(request, dict) and set(request) == fields, "invalid_arguments")
    bridge.require(all(request[k] is True for k in ("ownerConfirmed", "radioReadyConfirmed",
        "programmingAuthorized")) and (squelch or request["inactiveTargetSlotsConfirmed"] is True),
        "physical_confirmation_required")
    bridge.require(isinstance(request["runId"], str) and re.fullmatch(
        r"[a-z0-9][a-z0-9-]{0,63}", request["runId"]), "invalid_run_id")
    bridge.require(isinstance(request["deviceUuid"], str) and re.fullmatch(
        r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", request["deviceUuid"]),
        "device_confirmation_required")
    bridge.require(request["trustPolicy"] == bridge.POLICY and all(
        isinstance(request[k], str) and re.fullmatch(r"[a-f0-9]{64}", request[k])
        for k in ("expectedSha256", "planSha256")) and all(isinstance(request[k], str)
        for k in ("planPath", "capturePath")), "trust_policy_required")
    bridge.private_path(bridge.PRIVATE, directory=True)
    output = bridge.PRIVATE / request["runId"]
    bridge.require(not output.exists() and not output.is_symlink(), "output_exists")
    data = bridge.private_path(Path(request["planPath"])).read_bytes()
    bridge.require(hashlib.sha256(data).hexdigest() == request["planSha256"], "plan_changed")
    supplied = json.loads(data)
    probe, decoder = bridge.modules()
    memory, _ = bridge.validated_capture(Path(request["capturePath"]),
        request["expectedSha256"], probe, decoder)
    if squelch:
        from listening import plan as squelch_plan
        plan = squelch_plan(memory, probe)
    else:
        plan = profiles.plan(memory, probe, decoder, supplied["profiles"])
    bridge.require(plan == supplied, "plan_changed")
    before = {a: memory.read(a, 32) for a in probe.ADDRESSES}
    fd = os.open(bridge.PRIVATE / ".bluetooth.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise bridge.BridgeError("bluetooth_busy") from error
        output.mkdir(mode=0o700)
        return cancellation.run(apply(request, output, probe, before, plan), 600)


def main():
    os.umask(0o077)
    sys.dont_write_bytecode = True
    cancellation.install()
    try:
        request = json.loads(sys.stdin.read(16385))
        cancellation.check()
        result = run(request)
        cancellation.check()
        print(json.dumps(dict(ok=True, result=result)))
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps(dict(ok=False, code=error.code if isinstance(
            error, bridge.BridgeError) else "operation_failed")), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
