# Provenance and release boundary

These Python sources independently implement inspected protocol and layout
facts. No CHIRP or radioble implementation is imported, copied, or vendored. The
original standalone probe, decoder, private captures and radio-specific review
evidence were not modified or imported as evidence files.

- CHIRP `chirp/drivers/tdh8.py`: inspected revision
  `d99bb227093a0191a973ab9aa17276a0bee7b00a`, current file hash
  `6cc013c387f4728df4db826cd758fad805fd855e43bc44e70e2004aac845cc6c`. Its file
  header is GPLv2-or-later; repository COPYING is GPLv3. Used as layout/framing
  reference only, not a dependency.
- radioble revision `cb6d34750f91dd8f695256328e95632f2a70e87b`: MIT upstream,
  inspected for protocol corroboration; H3 was marked untested.
- Bleak 1.1.1: MIT dependency. PyObjC 11.1: MIT dependency. async-timeout 5.0.1:
  Apache-2.0; typing_extensions 4.16.0: PSF-2.0. Zod 4.1.12: MIT. Dependencies
  retain their own licenses.

The bundled probe matches the independently tested original byte-for-byte. The
decoder's pure decoding/validation functions are unchanged; the historical
snapshot-pinned CLI and private snapshot digest are omitted. The bridge still
requires explicit reviewed SHA-256, exact GMRS identity and exact fixed
coverage. Runtime files are resolved through Swamp `extensionFile`, not a
sibling checkout.

The owner explicitly approved MIT licensing on November 14, 2026 for the
independently authored sources in `packages/tdh3/`, including tests and runtime.
The package-root and bundled `LICENSE` files carry Copyright (c) 2026 @mgreten.
This grant does not relicense CHIRP/radioble references or third-party
dependencies; their separate licenses above remain applicable. No third-party
implementation is included. Scoped memory allocation and squelch persistence
were validated on one TD-H3 GMRS, without RF tests or general reliability proof.
Publication remains on hold for qualifying points-window coordination; this package is excluded
from the release catalog. MIT licensing does not imply hardware-programming
validation or permission to transmit.
