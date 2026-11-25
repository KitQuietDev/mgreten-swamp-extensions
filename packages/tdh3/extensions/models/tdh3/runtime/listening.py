"""Separate listening stage: exactly squelch5→2, preserve VOX and all else."""
import hashlib
import json
import os
from pathlib import Path
import re
import sys

import bridge
import cancellation


def plan(memory, probe):
    before = {a: memory.read(a, 32) for a in probe.ADDRESSES}
    block = before[0xCA0]
    bridge.require(block[9] == 5, "unexpected_squelch_preimage")
    bridge.require(block[7] & 7 == 0, "vox_not_off")
    after = dict(before)
    after[0xCA0] = block[:9] + b"\x02" + block[10:]
    return dict(status="offline-squelch-preview-only", setting="squelch", before=5, after=2,
                beforeSha256=hashlib.sha256(b"".join(before.values())).hexdigest(),
                afterSha256=hashlib.sha256(b"".join(after.values())).hexdigest(),
                blocks=[dict(kind="squelch", address=0xCA0, before=block.hex(),
                             after=after[0xCA0].hex(), changedOffsets=[9])],
                partialCapture=True, completeRestoreBackup=False)


def run(request):
    bridge.require(isinstance(request, dict), "invalid_arguments")
    operation = request.get("operation")
    bridge.require(operation in ("previewSquelch", "setSquelch"), "invalid_arguments")
    request = {k:v for k,v in request.items() if k != "operation"}
    if operation == "setSquelch":
        import allocation
        return allocation.run(request, squelch=True)
    bridge.require(set(request) == {"runId", "capturePath", "expectedSha256", "trustPolicy"},
                   "invalid_arguments")
    bridge.require(isinstance(request["runId"], str) and re.fullmatch(
        r"[a-z0-9][a-z0-9-]{0,63}", request["runId"]), "invalid_run_id")
    bridge.require(request["trustPolicy"] == bridge.POLICY and
        isinstance(request["capturePath"], str) and isinstance(request["expectedSha256"], str)
        and re.fullmatch(r"[a-f0-9]{64}", request["expectedSha256"]), "trust_policy_required")
    bridge.private_path(bridge.PRIVATE, directory=True)
    output = bridge.PRIVATE / request["runId"]
    bridge.require(not output.exists() and not output.is_symlink(), "output_exists")
    probe, decoder = bridge.modules()
    memory, _ = bridge.validated_capture(Path(request["capturePath"]),
        request["expectedSha256"], probe, decoder)
    result = plan(memory, probe)
    output.mkdir(mode=0o700)
    probe.save_json(output / "plan.json", result)
    return dict(status="offline-squelch-preview-only", privatePath=str(output),
                completeRestoreBackup=False)


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
