"""Local experimental label transaction; deliberately not a general writer.

Protocol/layout facts independently implemented after source inspection. The
original probe and its read-only output boundary are never modified.
"""
import asyncio
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
from datetime import datetime, timezone

import bridge
import cancellation

ADDRESS = 0x0E20
OFFSET = 13


def digest(blocks):
    return hashlib.sha256(b"".join(blocks.values())).hexdigest()


def postimage(blocks):
    block = blocks[ADDRESS]
    bridge.require(len(block) == 32 and block[OFFSET] == 0x38, "unexpected_preimage")
    # Refuse an empty or inconsistent channel; names alone are insufficient.
    record = blocks[0x1E0][:16]
    bridge.require(record[:4] != b"\xff" * 4 and
                   blocks[0x1900][3] & 0x20, "unexpected_preimage")
    result = dict(blocks)
    result[ADDRESS] = block[:OFFSET] + b"X" + block[OFFSET + 1:]
    return result


def session_type(probe):
    class LabelSession(probe.ReadOnlySession):
        def __init__(self, client, timeout=3):
            super().__init__(client, timeout)
            self.permit = None
            self.writes = 0

        async def send(self, frame):
            if frame != b"E":
                cancellation.check()
            if frame[:1] != b"W":
                return await super().send(frame)
            bridge.require(self.phase == "reading" and self.permit == frame
                           and self.writes == 0, "write_not_permitted")
            # Consume permission BEFORE the ambiguous transport operation.
            self.permit = None
            self.writes += 1
            self.transcript.append({"out": frame.hex()})
            try:
                await asyncio.wait_for(self.client.write_gatt_char(
                    probe.COMMAND, frame, response=False), self.timeout)
            except BaseException:
                self.phase = "failed"
                raise

        async def patch(self, before, after):
            bridge.require(len(before) == len(after) == 32 and
                           [(i, a, b) for i, (a, b) in enumerate(zip(before, after))
                            if a != b] in ([(OFFSET, 0x38, 0x58)],
                                           [(OFFSET, 0x58, 0x38)]), "write_not_permitted")
            bridge.require(await self.read_block(ADDRESS) == before, "stale_preimage")
            frame = struct.pack(">cHB", b"W", ADDRESS, 32) + after + bytes([sum(after) & 255])
            self.permit = frame
            await self.send(frame)
            if await self.receive(1) != b"\x06":
                self.phase = "failed"
                raise bridge.BridgeError("write_ack_unknown")
            for _ in range(2):
                bridge.require(await self.read_block(ADDRESS) == after, "readback_mismatch")

    return LabelSession


async def twice(session, probe):
    passes = []
    for _ in range(2):
        passes.append({a: await session.read_block(a) for a in probe.ADDRESSES})
    bridge.require(passes[0] == passes[1], "unstable_capture")
    return passes[0]


async def experiment(request, output, probe):
    from bleak import BleakClient, BleakScanner
    Session = session_type(probe)
    sessions = []
    state = {"status": "incomplete", "completeRestoreBackup": False,
             "settingsRestored": False, "firmware": "Unknown"}

    # Private, durable stage/error records survive a failed subprocess. Never
    # emit exception text (which may contain device identifiers) in receipts.
    diagnostics = output / "diagnostics.jsonl"
    diagnostics.touch(mode=0o600, exist_ok=False)

    def trace(event, **details):
        with diagnostics.open("a") as stream:
            stream.write(json.dumps(dict(time=datetime.now(timezone.utc).isoformat(),
                                         event=event, **details)) + "\n")
            stream.flush()
            os.fsync(stream.fileno())

    class TracedSession(Session):
        async def send(self, frame):
            trace("send-start", session=len(sessions), command=frame[:1].hex())
            try:
                result = await super().send(frame)
            except BaseException as error:
                trace("send-failed", error=repr(error))
                raise
            trace("send-returned")
            return result

        async def receive(self, size):
            trace("receive-start", session=len(sessions), size=size)
            try:
                result = await super().receive(size)
            except BaseException as error:
                trace("receive-failed", error=repr(error), buffered=len(self.buffer))
                raise
            trace("receive-returned", size=len(result))
            return result

    async def stage(expected, patch=None):
        # Explicit address only, never implicit single-candidate selection.
        cancellation.check()
        trace("lookup-start")
        device = await asyncio.wait_for(BleakScanner.find_device_by_address(
            request["deviceUuid"], timeout=8), 12)
        bridge.require(device is not None and device.name in probe.NAMES, "device_unavailable")
        trace("connect-start")
        async with BleakClient(device, timeout=15) as client:
            trace("connect-returned")
            service = client.services.get_service(probe.SERVICE)
            bridge.require(service is not None, "gatt_unavailable")
            notify = service.get_characteristic(probe.NOTIFY)
            command = service.get_characteristic(probe.COMMAND)
            bridge.require(notify is not None and command is not None and
                           "notify" in notify.properties and
                           "write-without-response" in command.properties and
                           command.max_write_without_response_size >= 37, "gatt_unavailable")
            session = TracedSession(client)
            sessions.append(session)
            trace("notify-start")
            await asyncio.wait_for(client.start_notify(probe.NOTIFY, session.notification), 5)
            trace("notify-returned")
            try:
                await session.identify()
                trace("identity-verified")
                live = await twice(session, probe)
                if isinstance(expected, str):
                    bridge.require(digest(live) == expected, "stale_preimage")
                else:
                    bridge.require(live == expected, "covered_state_mismatch")
                trace("precondition-verified")
                if patch is None:
                    return live
                target = postimage(live) if patch == "forward" else patch
                # Persist all covered preimages before any write, including a
                # durable checkpoint useful when transport outcome is unknown.
                checkpoint = output / ("forward-preimage.json" if patch == "forward"
                                       else "restore-preimage.json")
                probe.save_json(checkpoint, {str(a): b.hex() for a, b in live.items()})
                with checkpoint.open("rb") as stream:
                    os.fsync(stream.fileno())
                await session.patch(live[ADDRESS], target[ADDRESS])
                bridge.require(await twice(session, probe) == target, "covered_state_mismatch")
                trace("full-readback-verified")
                return live, target
            finally:
                pending_error = sys.exc_info()[0] is not None
                try:
                    await session.send(b"E")
                    trace("exit-returned")
                except BaseException as error:
                    trace("exit-failed", error=repr(error))
                    if not pending_error:
                        raise

    try:
        if request.get("operation") == "restoreLabel":
            _, decoder = bridge.modules()
            memory, _ = bridge.validated_capture(Path(request["originalCapturePath"]),
                request["originalSha256"], probe, decoder)
            original = {a: memory.read(a, 32) for a in probe.ADDRESSES}
            expected = postimage(original)
            bridge.require(digest(expected) == request["expectedSha256"], "stale_preimage")
            # One session, inverse only; exact full poststate is freshly read
            # twice before permission, plus target block checked immediately.
            await stage(expected, original)
            cancellation.check()
            state.update(status="restoration-readback-verified", settingsRestored=True,
                         persistenceVerified=False, originalSha256=digest(original),
                         testSha256=digest(expected))
            return dict(state, privatePath=str(output), writes=1)
        before, after = await stage(request["expectedSha256"], "forward")
        state["status"] = "forward-readback-verified"
        await stage(after)  # New connection proves persistence, not just cached ACK.
        state["status"] = "forward-persistence-verified"
        await stage(after, before)  # No restoration from an ambiguous state.
        await stage(before)
        cancellation.check()
        state.update(status="restored-and-verified", settingsRestored=True,
                     originalSha256=digest(before), testSha256=digest(after))
        return dict(state, privatePath=str(output), writes=2)
    except BaseException as error:
        trace("operation-failed", error=repr(error), exceptionType=type(error).__name__)
        raise
    finally:
        state["writesAttempted"] = sum(s.writes for s in sessions)
        probe.save_json(output / "transaction.json", state)
        probe.save_json(output / "protocol-transcript.json", [s.transcript for s in sessions])


def run(request):
    fields = {
        "runId", "deviceUuid", "expectedSha256", "ownerConfirmed",
        "inactiveChannel30Confirmed", "radioReadyConfirmed", "programmingAuthorized"
    }
    bridge.require(isinstance(request, dict), "invalid_arguments")
    if "operation" in request:
        bridge.require(request["operation"] == "restoreLabel", "invalid_arguments")
        fields |= {"operation", "originalCapturePath", "originalSha256"}
        bridge.require(isinstance(request.get("originalCapturePath"), str) and
                       isinstance(request.get("originalSha256"), str) and re.fullmatch(
                           r"[a-f0-9]{64}", request["originalSha256"]), "trust_policy_required")
    bridge.require(set(request) == fields, "invalid_arguments")
    bridge.require(all(request[k] is True for k in (
        "ownerConfirmed", "inactiveChannel30Confirmed", "radioReadyConfirmed",
        "programmingAuthorized")), "physical_confirmation_required")
    bridge.require(isinstance(request["runId"], str) and re.fullmatch(
        r"[a-z0-9][a-z0-9-]{0,63}", request["runId"]), "invalid_run_id")
    bridge.require(isinstance(request["deviceUuid"], str) and re.fullmatch(
        r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}",
        request["deviceUuid"]), "device_confirmation_required")
    bridge.require(isinstance(request["expectedSha256"], str) and re.fullmatch(
        r"[a-f0-9]{64}", request["expectedSha256"]), "trust_policy_required")
    probe, _ = bridge.modules()
    bridge.private_path(bridge.PRIVATE, directory=True)
    output = bridge.PRIVATE / request["runId"]
    bridge.require(not output.exists() and not output.is_symlink(), "output_exists")
    fd = os.open(bridge.PRIVATE / ".bluetooth.lock",
                 os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "r+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise bridge.BridgeError("bluetooth_busy") from error
        output.mkdir(mode=0o700)
        return cancellation.run(experiment(request, output, probe), 240)


def main():
    os.umask(0o077)
    sys.dont_write_bytecode = True
    cancellation.install()
    try:
        request = json.loads(sys.stdin.read(16385))
        cancellation.check()
        result = run(request)
        cancellation.check()
        print(json.dumps({"ok": True, "result": result}))
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({"ok": False, "code": error.code if isinstance(
            error, bridge.BridgeError) else "operation_failed",
            "recovery": "Stop; inspect private evidence. Do not blindly retry."}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
