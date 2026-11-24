# v0.1.0-alpha.1 artifact manifest

Machine-readable copy: [ARTIFACT_MANIFEST.json](ARTIFACT_MANIFEST.json) (written by
`scripts/build_release.py`). The archive itself is build output and is not committed; it was
built locally from the candidate commit and has not been published.

| Item | Value |
| --- | --- |
| Candidate commit | `13f003de321977d13bfac3839b8b721a01a95cef` |
| Archive | `bashwink-0.1.0-alpha.1-macos-arm64.tar.gz` |
| Archive SHA-256 | `f55db1940f917a7c41c91d12e9a2d1478ea91200a0c1bbee1fd65537cde486b2` (also in [SHA256SUMS](SHA256SUMS)) |
| Archive size | 333,567,141 bytes (318 MiB) |
| Installed size | 713,992,249 bytes (681 MiB) before any session state |
| Build host | macOS 27.0.1 (26A434), arm64, Bun 1.4.4, Swift 6.4.2 |
| VM asset manifest SHA-256 (pinned into the CLI) | `b58936fe1fca3bd5ec676ce9bfa14b02cc9c36e6f48f88890d69e312c32ffa9d` |
| Kernel `Image` | 36,306,944 bytes, `acb63544…24a6` (Alpine 3.23.8 `linux-virt` 6.18.60) |
| `initramfs` (guest root, Bun, OpenCode, relay, init) | 361,801,216 bytes, `bdd1b370…db4a` |
| `vm-owner` (VM helper, ad-hoc signed, virtualization entitlement only) | 199,184 bytes, `ca5eb6fe…0973` |
| Guest OpenCode 2.3.2 (linux arm64 musl) | `0e214cce…2e2d` |
| Guest Bun 1.4.4 (linux aarch64 musl) | `a6a3d99a…00a6` |
| Host Bun 1.4.4 (darwin arm64) | `0a2237cd…65cc` |
| Host OpenCode 2.3.2 (darwin arm64, unrestricted mode only) | `635c5230…f934` |
| CLI bundle (release flavor) | `a75ff191…443c` |
| Deadlines | host VM 1,800,000 ms; guest 1,740,000 ms |

Every external input, with URL and SHA-256, is in `release/inputs.lock.json` and is copied to
`share/doc/inputs.lock.json` inside the archive. Every file in the archive has a line in
`MANIFEST.sha256`, which `install.sh` verifies before and after copying.

## Where the size comes from

| Part | Installed bytes (approx.) |
| --- | ---: |
| Guest `initramfs` (includes guest OpenCode ~248 MB and Bun ~100 MB, uncompressed) | 362 MB |
| Host OpenCode (unrestricted mode) | 226 MB |
| Host Bun | 89 MB |
| Kernel `Image` | 36 MB |
| Everything else (CLI bundle 0.7 MB, plugin and SDK, notices, scripts, VM helper) | < 3 MB |

External dependencies at install and run time: none to fetch. The host needs macOS arm64,
`/usr/bin/git`, and the standard system tools (`shasum`, `tar`, `sw_vers`, `sysctl`, `stty`).
Build-time only: Xcode command line tools (`swiftc`, `codesign`), Bun 1.4.4, Python 3 with
PySquashfsImage 0.9.0, network access for the first fetch.
