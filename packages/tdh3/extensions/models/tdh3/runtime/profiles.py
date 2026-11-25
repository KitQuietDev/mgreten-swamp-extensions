"""Offline, GMRS-only allocation preview. No Bluetooth or write transport.

H3 layout facts were independently implemented after reference inspection.
Erased FF records are allocation sentinels, not occupied-record reserved bits.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

import bridge
import cancellation

TONES = (797, 825, 1000, 1072, 1413, 2035)


def bcd(value, size):
    return bytes.fromhex(str(value).zfill(size * 2))[::-1]


def plan(memory, probe, decoder, profiles):
    bridge.require(isinstance(profiles, list) and 1 <= len(profiles) <= 10,
                   "invalid_profiles")
    before = {a: memory.read(a, 32) for a in probe.ADDRESSES}
    after = dict(before)
    slots = set()
    labels = set()

    def put(address, data):
        base, offset = address & ~31, address & 31
        bridge.require(base in after and offset + len(data) <= 32, "coverage_mismatch")
        block = after[base]
        after[base] = block[:offset] + data + block[offset + len(data):]

    def activate(base, slot):
        address, bit = base + (slot - 1) // 8, 1 << ((slot - 1) % 8)
        block = after[address & ~31]
        put(address, bytes([block[address & 31] | bit]))

    for profile in profiles:
        bridge.require(isinstance(profile, dict) and set(profile) == {
            "slot", "label", "rxHz", "txToneTenths"}, "invalid_profiles")
        slot, label = profile["slot"], profile["label"]
        rx, tone = profile["rxHz"], profile["txToneTenths"]
        bridge.require(type(slot) is int and 31 <= slot <= 40 and slot not in slots
                       and isinstance(label, str) and re.fullmatch(r"[A-Z0-9 -]{1,8}", label)
                       and label.strip() == label and label not in labels
                       and type(rx) is int and 462_550_000 <= rx <= 462_725_000
                       and (rx - 462_550_000) % 25_000 == 0
                       and type(tone) is int and tone in TONES, "invalid_profiles")
        slots.add(slot)
        labels.add(label)
        # Allocate only a completely erased record and empty label/flags. Never
        # treat a partially populated/inconsistent record as safe scratch space.
        name_address = 0xD40 + (slot - 1) * 8
        bridge.require(memory.read(slot * 16, 16) == b"\xff" * 16 and
                       memory.read(name_address, 8) == bytes(8) and
                       not memory.bit(0x1900, slot - 1) and
                       not memory.bit(0x1920, slot - 1), "slot_not_unused")
        source_slot = 23 + (rx - 462_550_000) // 25_000
        template = memory.read(source_slot * 16, 16)
        decoded = decoder.record(template)
        # Match stock legal repeater semantics, not measured RF output. Reject
        # customized/unknown extras rather than silently cloning signaling.
        bridge.require(memory.bit(0x1900, source_slot - 1) and
                       decoded["rx_hz"] == rx and decoded["tx_hz"] == rx + 5_000_000
                       and decoded["rx_tone"]["kind"] == "Off" and
                       decoded["tx_tone"]["kind"] == "Off" and
                       template[12:] == bytes([0, 0, 0x10, 0]), "template_not_standard")
        # New-slot initialization follows the zero-initialized allocation facts
        # and the fresh matching factory record. No GPL encoder is imported.
        record = (bcd(rx // 10, 4) + bcd((rx + 5_000_000) // 10, 4) +
                  b"\xff\xff" + bcd(tone, 2) + template[12:])
        put(slot * 16, record)
        put(name_address, label.encode("ascii").ljust(8, b"\0"))
        activate(0x1900, slot)
        activate(0x1920, slot)

    blocks = []
    # Dependency order is a proposed fail-stop sequence, not firmware-proven
    # atomicity. Records and names precede used/scan activation. No rollback.
    for kind, addresses in (
        ("record", range(0x1E0, 0x2A0, 32)),
        ("name", range(0xE20, 0xE80, 32)),
        ("used", (0x1900,)), ("scan", (0x1920,)),
    ):
        for address in addresses:
            if before[address] != after[address]:
                blocks.append(dict(kind=kind, address=address,
                    before=before[address].hex(), after=after[address].hex(),
                    changedOffsets=[i for i, (a, b) in enumerate(zip(
                        before[address], after[address])) if a != b]))
    bridge.require({b["address"] for b in blocks} == {
        a for a in before if before[a] != after[a]}, "unplanned_change")
    sha = lambda blocks: hashlib.sha256(b"".join(blocks.values())).hexdigest()
    return dict(status="offline-preview-only", profiles=profiles, blocks=blocks,
                beforeSha256=sha(before), afterSha256=sha(after),
                partialCapture=True, completeRestoreBackup=False,
                firmwareAllocationVerified=False, scanIncluded=True,
                rxFilter="Off", powerCode=1, bandwidthCode="Wide",
                unknowns=["Firmware allocation/commit behavior", "Uncaptured regions",
                          "Live channel and physical state", "RF power and repeater access"])


def run(request):
    bridge.require(isinstance(request, dict) and set(request) == {
        "runId", "capturePath", "expectedSha256", "trustPolicy", "profiles"
    }, "invalid_arguments")
    bridge.require(isinstance(request["runId"], str) and re.fullmatch(
        r"[a-z0-9][a-z0-9-]{0,63}", request["runId"]), "invalid_run_id")
    bridge.require(request["trustPolicy"] == bridge.POLICY and
                   isinstance(request["expectedSha256"], str) and re.fullmatch(
                       r"[a-f0-9]{64}", request["expectedSha256"]) and
                   isinstance(request["capturePath"], str), "trust_policy_required")
    bridge.private_path(bridge.PRIVATE, directory=True)
    output = bridge.PRIVATE / request["runId"]
    bridge.require(not output.exists() and not output.is_symlink(), "output_exists")
    probe, decoder = bridge.modules()
    memory, _ = bridge.validated_capture(Path(request["capturePath"]),
        request["expectedSha256"], probe, decoder)
    result = plan(memory, probe, decoder, request["profiles"])
    output.mkdir(mode=0o700)
    probe.save_json(output / "plan.json", result)
    return dict(status="offline-preview-only", privatePath=str(output),
                profiles=len(request["profiles"]), blocks=len(result["blocks"]),
                partialCapture=True, completeRestoreBackup=False,
                firmwareAllocationVerified=False)


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
