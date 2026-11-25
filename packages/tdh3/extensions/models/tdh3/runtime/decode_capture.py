"""Offline decoder for the two validated, sparsely addressed TD-H3 captures.

Independent implementation of protocol/layout facts documented in CHIRP's
tdh8.py, revision d99bb227093a0191a973ab9aa17276a0bee7b00a. No CHIRP code
is imported or copied; no Bluetooth dependency is imported or used.
"""

import hashlib
import json
from collections import Counter

SOURCE = "https://github.com/kk7ds/chirp/blob/d99bb227093a0191a973ab9aa17276a0bee7b00a/chirp/drivers/tdh8.py"


class DecodeError(ValueError):
    pass


class SparseMemory:
    def __init__(self, blocks):
        self.data = {}
        for address, payload in blocks:
            for offset, byte in enumerate(payload):
                if address + offset in self.data:
                    raise DecodeError("Overlapping captured blocks")
                self.data[address + offset] = byte

    def read(self, address, length):
        try:
            return bytes(self.data[a] for a in range(address, address + length))
        except KeyError as error:
            raise DecodeError("Uncaptured address 0x%04X" % error.args[0]) from error

    def byte(self, address):
        return self.read(address, 1)[0]

    def bit(self, base, index):
        return bool(self.byte(base + index // 8) & (1 << (index % 8)))


def load_capture(folder, expected_digest):
    manifest = json.loads((folder / "manifest.json").read_text())
    if (manifest["status"] != "two-matching-partial-reads"
            or manifest["ident_hex"] != "503331313834ffff"):
        raise DecodeError("Capture status or GMRS identity mismatch")
    addresses = []
    for region in manifest["coverage"]:
        start, end = region["start"], region["end_exclusive"]
        if start < 0 or end <= start or start % 32 or end % 32:
            raise DecodeError("Invalid coverage bounds")
        addresses.extend(range(start, end, 32))
    if addresses != sorted(set(addresses)):
        raise DecodeError("Coverage overlaps or is not ordered")
    passes = []
    logs = []
    for number in (1, 2):
        records = [json.loads(line) for line in
                   (folder / ("pass%d-blocks.jsonl" % number)).read_text().splitlines()]
        blocks = [(r["address"], bytes.fromhex(r["data"])) for r in records]
        if ([a for a, _ in blocks] != addresses or any(len(b) != 32 for _, b in blocks)
                or len(blocks) != manifest["blocks_per_pass"]):
            raise DecodeError("Block log does not match coverage")
        raw = (folder / ("pass%d-covered-bytes.bin" % number)).read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if (raw != b"".join(b for _, b in blocks)
                or len(raw) != manifest["bytes_per_pass"]
                or digest != manifest["sha256"][number - 1]
                or digest != expected_digest):
            raise DecodeError("Captured bytes/log/hash mismatch")
        passes.append(raw)
        logs.append(blocks)
    if passes[0] != passes[1] or logs[0] != logs[1]:
        raise DecodeError("Capture passes differ")
    return SparseMemory(logs[0]), manifest


def bcd(raw):
    value = 0
    for index, byte in enumerate(raw):
        high, low = byte >> 4, byte & 15
        if high > 9 or low > 9:
            raise DecodeError("Invalid BCD: " + raw.hex())
        value += (high * 10 + low) * 100 ** index
    return value


def tone(raw):
    result = {"raw_hex": raw.hex()}
    if raw in (b"\xff\xff", b"\x00\x00"):
        return dict(result, kind="Off", display="Off")
    high = raw[1]
    if high & 0x80:
        polarity = "R" if high & 0x40 else "N"
        try:
            code = bcd(bytes([raw[0], high & 0x3F]))
        except DecodeError:
            return dict(result, kind="Unknown", display="Unknown " + raw.hex())
        if code > 777 or any(c not in "01234567" for c in "%03d" % code):
            return dict(result, kind="Unknown", display="Unknown " + raw.hex())
        return dict(result, kind="DCS", code="%03d" % code, polarity=polarity,
                    display="DCS %03d%s" % (code, polarity))
    try:
        frequency = bcd(raw) / 10
    except DecodeError:
        return dict(result, kind="Unknown", display="Unknown " + raw.hex())
    return dict(result, kind="CTCSS", hz=frequency, display="CTCSS %.1f Hz" % frequency)


def record(raw):
    rx_hz = bcd(raw[:4]) * 10
    tx_hz = None if raw[4:8] == b"\xff" * 4 else bcd(raw[4:8]) * 10
    path = ("RX-only (TX bytes disabled)" if tx_hz is None else
            "Simplex" if tx_hz == rx_hz else
            "+5 MHz repeater" if tx_hz - rx_hz == 5_000_000 else "Other split")
    power_code = (raw[14] >> 4) & 3
    return {"rx_hz": rx_hz, "tx_hz": tx_hz, "stored_path": path,
            "rx_tone": tone(raw[8:10]), "tx_tone": tone(raw[10:12]),
            "power_code": power_code,
            "power": {0: "Low", 1: "High"}.get(power_code, "Unknown raw %d" % power_code),
            "bandwidth": "Narrow" if raw[14] & 8 else "Wide",
            "record_hex": raw.hex()}


def channel(memory, number):
    # CHIRP image includes an 8-byte prefix; captured radio addresses do not.
    # memory[number] has index zero reserved. Names/bitmaps use number minus 1.
    raw = memory.read(number * 16, 16)
    used = memory.bit(0x1900, number - 1)
    if raw[:4] == b"\xff" * 4:
        return {"number": number, "empty": True, "used_bitmap": used,
                "warning": "Used bit conflicts with empty record" if used else None}
    result = record(raw)
    name_bytes = memory.read(0x0D40 + (number - 1) * 8, 8)
    label = "".join(chr(x) if 32 <= x < 127 else "�" for x in name_bytes if x not in (0, 255))
    result.update(number=number, empty=False, used_bitmap=used, label=label.strip(),
                  label_raw_hex=name_bytes.hex(), scan_included=memory.bit(0x1920, number - 1),
                  warning=None if used else "Populated record has unused bitmap flag")
    # NOAA-labelled presets contain RX=TX in raw memory; that does NOT authorize
    # or prove TX outside GMRS. Do not mislabel these as legal simplex channels.
    result["category"] = ("GMRS" if 1 <= number <= 30 else
                          "Weather-labelled preset (TX eligibility unverified)"
                          if result["label"].startswith("NOAA") else "Other")
    return result


def globals_decode(memory):
    def value(address, shift=0, mask=255, labels=None):
        raw = (memory.byte(address) >> shift) & mask
        meaning = labels[raw] if labels is not None and raw < len(labels) else raw
        if labels is not None and raw >= len(labels):
            meaning = "Unknown raw %d" % raw
        return {"value": meaning, "raw": raw, "address_hex": "0x%04X" % address}
    fields = {
        "squelch": value(0x0CA9, labels=list(range(10))),
        "vox_gain": value(0x0CA7, 0, 7, ["Off", "1", "2", "3", "4", "5"]),
        "vox_delay": value(0x0CAE, labels=["1.05 s", "2.0 s", "3.0 s"]),
        "dual_watch": value(0x0CA3, 2, 1, ["Off", "On"]),
        "scan_mode": value(0x0CA1, 6, 3, ["TO", "CO", "SE"]),
        "a_stored_workmode": value(0x0CA2, 0, 3, ["VFO", "VFO+CH", "CH Mode"]),
        "b_stored_workmode": value(0x0CA3, 0, 3, ["VFO", "VFO+CH", "CH Mode"]),
        "a_channel_selector_unverified": value(0x0CA4),
        "b_channel_selector_unverified": value(0x0CA5),
        "a_display": value(0x0CA2, 2, 1, ["Frequency", "Name"]),
        "b_display": value(0x0CA3, 4, 1, ["Frequency", "Name"]),
        "only_channel_mode": value(0x0CAF, 7, 1, ["Off", "On"]),
        "power_save": value(0x0CAC, labels=["Off", "1:1", "1:2", "1:3", "1:4", "1:8"]),
    }
    for side, address in (("a", 0x1950), ("b", 0x1960)):
        fields[side + "_stored_vfo"] = record(memory.read(address, 16))
    return fields


def decode(memory, manifest):
    channels = [channel(memory, n) for n in range(1, 200)]
    populated = [c for c in channels if not c["empty"]]
    return {"source": SOURCE, "capture_sha256": manifest["sha256"][0],
            "coverage": manifest["coverage"], "identity_hex": manifest["ident_hex"],
            "firmware": "Unknown", "partial_capture": True,
            "counts": {"populated": len(populated), "empty": len(channels) - len(populated),
                       "gmrs_simplex": sum(c["category"] == "GMRS" and c["stored_path"] == "Simplex" for c in populated),
                       "gmrs_repeaters": sum(c["category"] == "GMRS" and c["stored_path"] == "+5 MHz repeater" for c in populated),
                       "weather_presets": sum(c["category"].startswith("Weather") for c in populated),
                       "scan_included": sum(c["scan_included"] for c in populated),
                       "tx_tone_kinds": dict(Counter(c["tx_tone"]["kind"] for c in populated)),
                       "rx_tone_kinds": dict(Counter(c["rx_tone"]["kind"] for c in populated))},
            "globals": globals_decode(memory), "channels": channels,
            "unknowns": ["Firmware revision", "Currently live selected A/B line/channel or VFO",
                         "Whether scanning is currently running", "Actual RF output power/bandwidth",
                         "Firmware TX enforcement on weather/VFO records", "Uncaptured memory gaps",
                         "NOAA mode availability/behavior and Bluetooth setting field"]}


def csv_rows(result):
    for c in result["channels"]:
        if not c["empty"]:
            yield {"channel": c["number"], "label": c["label"],
                   "rx_mhz": "%.5f" % (c["rx_hz"] / 1e6),
                   "stored_tx_mhz": "Disabled" if c["tx_hz"] is None else "%.5f" % (c["tx_hz"] / 1e6),
                   "category": c["category"], "stored_path": c["stored_path"],
                   "tx_tone": c["tx_tone"]["display"], "rx_tone": c["rx_tone"]["display"],
                   "scan": "Yes" if c["scan_included"] else "No",
                   "power_code": c["power"], "bandwidth_code": c["bandwidth"]}


# The bridge owns CLI validation, including exact fixed coverage, private paths
# and an explicit independently reviewed digest. No snapshot-specific CLI pin
# or validation-disable entry point is shipped.
