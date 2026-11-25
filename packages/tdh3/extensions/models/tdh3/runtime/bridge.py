"""Local read-only adapter with bundled independent protocol/layout sources."""

import asyncio
import csv
import fcntl
import hashlib
import importlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import cancellation

BASE = Path(__file__).resolve().parent
SOURCE = BASE
# Required operator configuration; never default evidence into the package.
PRIVATE = Path(os.environ.get("TDH3_PRIVATE_ROOT", ""))
POLICY = "owner-reviewed-sha256-exact-gmrs-coverage-v1"
PINS = {
    "probe.py": "0f680eff3524f4e4c5d5ec6350b6d9f336cf2094449053b9cc9489f9a122069a",
    "decode_capture.py": "c960e28e7f0a7bde372e7bf38a87c84e86f063b422bee90bb978ccc4b32ba8ac",
}


class BridgeError(Exception):
    def __init__(self, code):
        self.code = code


def require(condition, code):
    if not condition:
        raise BridgeError(code)


def private_path(path, directory=False):
    """Refuse symlinks, non-owner files, and group/world-readable evidence."""
    require(path.is_absolute() and path == path.resolve(), "unsafe_path")
    # Keep private evidence outside any checkout, including symlinked parents.
    require(not any((parent / ".git").exists() for parent in (path, *path.parents))
            and BASE not in (path, *path.parents), "unsafe_path")
    info = path.lstat()
    require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0,
            "unsafe_permissions")
    require(stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode),
            "unsafe_path")
    if not directory:
        require(info.st_size <= 1_000_000, "input_too_large")
    return path


def modules():
    for name, digest in PINS.items():
        require(hashlib.sha256((SOURCE / name).read_bytes()).hexdigest() == digest,
                "source_changed")
    sys.path.insert(0, str(SOURCE))
    return importlib.import_module("probe"), importlib.import_module("decode_capture")


def validated_capture(folder, digest, probe, decoder):
    private_path(folder, directory=True)
    for name in ("manifest.json", "pass1-blocks.jsonl", "pass2-blocks.jsonl",
                 "pass1-covered-bytes.bin", "pass2-covered-bytes.bin"):
        private_path(folder / name)
    manifest = json.loads((folder / "manifest.json").read_text())
    # Matching data does not make an operation successful if session exit failed.
    require("error" not in manifest, "capture_recorded_error")
    require(manifest.get("coverage") == [
        {"start": a, "end_exclusive": b} for a, b in probe.RANGES
    ] and manifest.get("complete_restore_backup") is False
        and manifest.get("blocks_per_pass") == 171
        and manifest.get("bytes_per_pass") == 5472, "coverage_mismatch")
    return decoder.load_capture(folder, digest)


def receipt(operation, path, **extra):
    return dict(operation=operation, privatePath=str(path),
                partialCapture=operation != "discover", completeRestoreBackup=False,
                firmware="Unknown", liveChannel="Unknown", **extra)


def run(request):
    require(isinstance(request, dict), "invalid_arguments")
    operation = request.get("operation")
    fields = {
        "discover": {"operation", "runId", "bluetoothAuthorized"},
        "capture": {"operation", "runId", "bluetoothAuthorized", "deviceUuid",
                    "confirmedRadioLabel", "ownerConfirmed"},
        "decode": {"operation", "runId", "capturePath", "expectedSha256", "trustPolicy"},
    }
    require(operation in fields and set(request) == fields[operation], "invalid_arguments")
    require(isinstance(request["runId"], str)
            and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", request["runId"]), "invalid_run_id")
    if operation in ("discover", "capture"):
        require(request["bluetoothAuthorized"] is True, "bluetooth_not_authorized")
    if operation == "capture":
        require(request["ownerConfirmed"] is True
                and request["confirmedRadioLabel"] == "2A4FBTD831G"
                and isinstance(request["deviceUuid"], str)
                and re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}",
                                 request["deviceUuid"]), "device_confirmation_required")
    if operation == "decode":
        require(request["trustPolicy"] == POLICY
                and isinstance(request["expectedSha256"], str)
                and re.fullmatch(r"[a-f0-9]{64}", request["expectedSha256"])
                and isinstance(request["capturePath"], str), "trust_policy_required")
    probe, decoder = modules()
    private_path(PRIVATE, directory=True)
    output = PRIVATE / request["runId"]
    require(not output.exists() and not output.is_symlink(), "output_exists")
    # All wrapper Bluetooth operations share one nonblocking process lock, even
    # across Swamp definitions. Never queue an unexpected later radio connection.
    lock = None
    try:
        if operation in ("discover", "capture"):
            fd = os.open(PRIVATE / ".bluetooth.lock",
                         os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            lock = os.fdopen(fd, "r+")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise BridgeError("bluetooth_busy") from error
        if operation == "discover":
            result = cancellation.run(probe.scan(), 20)
            output.mkdir(mode=0o700)
            probe.save_json(output / "candidates.json", result)
            return receipt(operation, output, candidateCount=len(result["td_h3_candidates"]))
        if operation == "capture":
            manifest = cancellation.run(probe.capture(request["deviceUuid"], output), 180)
            validated_capture(output, manifest["sha256"][0], probe, decoder)
            return receipt(operation, output, sha256=manifest["sha256"][0],
                           blocksPerPass=171, bytesPerPass=5472)
        memory, manifest = validated_capture(Path(request["capturePath"]),
                                              request["expectedSha256"], probe, decoder)
        result = decoder.decode(memory, manifest)
        # Raw records, settings, selectors, names and tones remain in private files.
        output.mkdir(mode=0o700)
        probe.save_json(output / "decoded.json", result)
        rows = list(decoder.csv_rows(result))
        with (output / "channels.csv").open("x", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=[
                "channel", "label", "rx_mhz", "stored_tx_mhz", "category", "stored_path",
                "tx_tone", "rx_tone", "scan", "power_code", "bandwidth_code"])
            writer.writeheader()
            writer.writerows(rows)
        return receipt(operation, output, sha256=manifest["sha256"][0],
                       populated=result["counts"]["populated"], empty=result["counts"]["empty"],
                       unknowns=result["unknowns"])
    finally:
        if lock is not None:
            lock.close()


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
        # Upstream errors can contain device IDs or configuration bytes. Keep
        # their details in the private capture manifest, not Swamp logs.
        code = error.code if isinstance(error, BridgeError) else (
            "output_exists" if isinstance(error, FileExistsError) else
            "operation_failed")
        print(json.dumps({"ok": False, "code": code}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
