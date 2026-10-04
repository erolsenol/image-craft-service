# Dependency and license review

Reviewed 2026-10-03 against the production dependency tree in `package-lock.json`
with `npx --yes license-checker --production --summary`. The scan reported
138 MIT, 75 Apache-2.0, 15 BSD-3-Clause, 10 ISC, 5 BlueOak-1.0.0, 1
LGPL-3.0-or-later, and 1 0BSD package. Re-run the scan after dependency
updates; transitive packages and native binaries can change their terms.

`sharp` 0.35.5 is Apache-2.0. Its prebuilt `@img/sharp-libvips-*` packages
include libvips 8.18.7 under LGPL-3.0-or-later, plus third-party codecs and
libraries under their own terms. The libvips distribution documents the
component licenses in its package README. Sharp uses the native library at
runtime; the Docker image therefore includes the LGPL-covered components.
The service's MIT license applies to this repository's code and does not
replace notices or obligations for those dependencies.

The release SBOM workflow attaches SPDX metadata to each GHCR image. Review
the license files and obligations for the exact platform image you distribute,
especially when changing Sharp/libvips builds or compiling against system
libraries. This inventory is an engineering review, not legal advice.
