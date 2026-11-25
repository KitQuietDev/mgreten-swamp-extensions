# TIDRADIO GMRS (TD-H3)

Local partial reads and offline decode are separate from the experimental
one-byte label transaction. **Partial capture is not a complete/restorable
backup.** Package `@mgreten/tidradio-gmrs` is excluded from the release catalog.
Publication is held for the owner's coordinated qualifying points window;
this package does not create a watcher or publish itself.

## Contracts

- `@mgreten/tdh3-readonly`: `discover`, `capture`, `decode`. Explicit device
  selection/owner confirmation, exact GMRS identity, outgoing read-only
  allowlist, matching two-pass 171-block/5,472-byte coverage and explicit
  trusted digest. No write method. Names/RSSI do not authenticate ownership.
  Zero/multiple discovery candidates do not select a device.
- `@mgreten/tdh3-programming-experiment`: `labelExperiment`. Changes byte
  0x0E2D from 0x38 to 0x58 in aligned block0x0E20, then restores it only from
  exactly verified poststate. Fresh double reads, full-covered comparisons,
  exact ACK/readback and reconnect checks surround both writes. At most one W
  per connection; ambiguity stops without blind resend or rollback. Not a
  generic profile programmer. Separate `restoreLabel` permits only inverse
  0x58 to0x38 from an exact validated postimage. Its receipt proves in-session
  readback only; a new-process read-only capture must establish persistence.
- `@mgreten/tdh3-profiles`: `preview` is offline only. `apply` accepts a reviewed
  private plan digest, regenerates it from a trusted capture, freshly checks
  exact identity and double full-covered state, and allocates only completely
  erased slots31–40 with empty names/clear used and scan bits. Matching stock
  repeater templates must have standard +5MHz pairs, tonesOff and known
  High/Wide stored codes with no extras. Records/names precede used/scan flags;
  this order is not firmware atomicity. Each planned block can be attempted
  once; exact ACK, double target and double full-covered comparison follow
  every write. Any failure stops without retry or rollback. No arbitrary frame,
  occupied-record edit, global settings or full-image write method exists.
- `@mgreten/tdh3-listening`: offline `previewSquelch` and guarded `setSquelch` for the
  single fixed squelch5→2 transition at0x0CA9. Requires VOXOff and preserves
  all other covered bytes. Uses the same fresh-state, one-attempt-per-block,
  ACK/readback and fail-stop contract as allocation. No general settings writer.

Package and all four models are v2026.11.14.4. All require absolute `pythonPath` and
`privateRoot` globals. Runtime scripts resolve through Swamp `extensionFile`;
there is no sibling-checkout dependency. Evidence root must already exist,
owner-only0700, outside any Git checkout. New run directories/files
are0700/0600; existing paths/symlinks are never overwritten. Receipts exclude
raw config and nearby-device identifiers. Subprocess diagnostics are redacted
in Swamp; write-stage timestamps, exceptions and checkpoints stay private.

On the tested unit, forward label ACK/readback succeeded but its immediate
same-process reconnect handshake failed before restoration. A later guarded
inverse-only operation and separate-process capture restored all covered bytes
exactly. The reconnect cause remains unresolved; this is not a successful
unattended four-stage transaction or general reliability claim. On the tested
unit, ten newly allocated repeater memories and the separate squelch2 change
subsequently passed ACK/readback, full-covered comparisons and independent
new-process capture/decode. Stock1–30, weather and unrelated covered bytes were
preserved. This proves stored memory persistence only, not RF transmission,
repeater access, coverage or behavior on other firmware. A receipt with
`persistenceVerified:false` must not be described as a persistent success.

New-slot initialization is intentional: CHIRP's inspected allocation contract
zero-initializes nonempty records, while FF denotes deletion. Fresh standard
factory records supply known initialization inside the allocated16-byte slot.
Do not preserve erased FF reserved bits as if they belonged to an occupied
record. All bytes outside selected records/names/bitmap masks are preserved,
including shared stock-record/name neighbors and weather/global settings.

Discover/capture require fresh Bluetooth authorization. Experiment additionally
requires programming authorization and physical confirmation: charged/on radio
with Bluetooth, channel30 inactive on both A/B, scanning stopped, VOX off, other
radios off and phone apps disconnected. Profile writes require the same ready
state plus inactive target slots; erased/unused flags do not prove live state.
Unknown or contradictory physical state means stop. No
RF/PTT/VOX tests, firmware/unlock/mode/calibration/weather writes or full
clones. Missing ACK or failed restoration can leave the label changed: preserve
evidence and inspect before recovery. No retry or full recovery claim.

### Cancellation and resource containment

All methods reject a pre-aborted caller signal before launching Python. Caller
cancellation or a parent deadline sends cooperative SIGTERM: Python records the
stop request, cancels the active async operation and checks before subsequent
writer frames/stages. Session exit/disconnect and private diagnostics are
attempted, not guaranteed. Read-only/decode/preview deadlines are200seconds,
label transactions250seconds and profile/squelch application610seconds. These
parent bounds cover input/output and cleanup, independently of Python's shorter
cooperative timeouts. After5seconds of cleanup grace the parent sends SIGKILL,
waits for its direct Python child to exit, drains output and removes listeners.
Pipe errors use the same containment. The configured executable must directly
execute Python, not detach or spawn a separately owned process tree.

Canceled or timed-out children never produce a success receipt. Cancellation
racing an already-started receipt write may leave that verified-readback receipt
in Swamp even though the method rejects; receipt persistence is not cancellable
or an atomic transaction with the caller signal. **Hard termination is not radio
restoration.** It may interrupt a write or checkpoint, leave changed
settings/partial evidence and prevent BLE's orderly disconnect. An existing
receipt does not become a rollback instruction. Inspect durable private evidence
and obtain fresh verified state before any independently authorized recovery;
never automatically retry, resume later writes, or replay historical preimages.
The process lock is released on exit for the same privateRoot; this is not a
cross-root or same-OS-user security boundary. Synthetic tests establish child
reaping/lock release and fail-stop behavior, not a firmware disconnect guarantee
or a solution to the previously observed reconnect failure. This revision's
lifecycle correction has not been retested on hardware; the radio remains off.

## Dependencies and offline checks

Tested host: macOS arm64, Python3.9 with the exact versions in
`requirements-macos.txt`; Swamp with `extensionFile`, Deno and npm Zod4.1.12.
Create the Python virtualenv and private root outside your source checkout.
Dependency installation is an operator step, never an extension side effect.
Offline decode/unit tests need only Python's standard library. No Bleak import
occurs during decode. Other hardware/OS/firmware combinations are unverified.

From the manifest directory, prepare operator-owned local dependencies and an
evidence root outside any checkout (this does not contact the radio):

```sh
python3 -m venv "$HOME/.local/share/tdh3-venv"
"$HOME/.local/share/tdh3-venv/bin/python" -m pip install -r requirements-macos.txt
mkdir -m 700 "$HOME/.local/share/tdh3-evidence"
```

Both model globals must point to that Python executable and private evidence
root. Never configure a shared/remote Swamp datastore for radio inputs/history.
Each method requires a new runId. Decode additionally requires an absolute
private capturePath, independently reviewed expectedSha256, and literal
trustPolicy `owner-reviewed-sha256-exact-gmrs-coverage-v1`. A manifest's own
hash is not an independent trust decision. There is no validation-disable
switch. Capture's confirmedRadioLabel is the public model identifier
`2A4FBTD831G`, not a serial number or ownership authentication.

From the package root:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=extensions/models/tdh3/runtime python3 -B -m unittest discover -s tests -v
```

The integration tests create a disposable local Swamp repository and inject a
test-only in-memory peer; they never access Bluetooth. Optional external saved
capture validation is separate and no captures/private profiles ship here.
Normal success/failure coverage runs through actual installed Swamp. Dedicated
cancellation tests additionally invoke real model methods with an AbortSignal
and synthetic transport barriers, plus parent-deadline/pipe-failure fixtures;
they do not contact hardware. Swamp's testing-completeness advisory does not
recognize these Python integration tests. Its subprocess advisory is relevant:
the executable is trusted operator configuration, arguments are schema-checked,
JSON crosses stdin without a shell, and upstream diagnostics are never echoed.
Python is required for Bleak's CoreBluetooth integration and the inspected
independent decoder. These are local tools, not a sandbox from the same OS user.

Stored High/Low and Wide/Narrow values are codes, not RF measurements. Firmware,
live active A/B/channel, scan activity, uncaptured regions and transmit
enforcement remain unknown. Programming does not grant a license or repeater
permission. Independently authored package sources are MIT licensed; see
`LICENSE` and `PROVENANCE.md` for scope and separate dependency/reference
licenses. The owner's license approval does not lift the publication hold or
validate hardware programming.

## Tested limits and operator guide

The radio is now off; previous physical readiness is no longer current.
Future hardware operations need fresh authorization/readiness, exact identity,
explicit device selection and reviewed capture trust. No hardware is contacted
by installation or offline tests. The second radio was not programmed or tested.

The human operating guide and owner-specific channel list are deliberately
outside this public payload. FCC family coverage includes an authorized spouse
(47CFR95.1705); both use the grant's callsign and comply with95.1751. No license
grant was verified, and programming is not permission to transmit. Tones do
not provide privacy. **Memories31–40 are saved repeater presets; ability to
transmit from them on this firmware is NOT verified.** An older generic
[TIDRADIO GMRS manual](https://www.manualslib.com/manual/2991855/Tidradio-Gmrs.html?page=22#manual),
printed p.18/viewer p.22, says: “Channels other than CH01-CH30 can only be
scanned and received, and transmission is prohibited.” That manual has not
been established as matching this TD-H3's unknown firmware. CHIRP layout or
successful memory readback cannot resolve the contradiction. Factory1–22 are
direct memories and23–30 repeater memories. No restriction bypass is provided;
model-specific confirmation and later lawful licensed testing are separate
from this package's demonstrated memory-persistence scope. Firmware/live active
channel remain unknown. There is no emergency-response or911 guarantee.
