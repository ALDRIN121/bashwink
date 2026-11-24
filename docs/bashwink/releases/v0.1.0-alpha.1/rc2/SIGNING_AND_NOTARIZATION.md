# Signing and notarization: what exists and what is missing

## What the archive contains today (inspected with `codesign` and `spctl`)

| Binary | Signature | Notes |
| --- | --- | --- |
| `lib/offline-vm/vm-owner` (built here) | ad hoc, entitlement `com.apple.security.virtualization` | `spctl --assess`: rejected. Works locally because the virtualization entitlement is not a restricted one |
| `libexec/bun` | Developer ID Application (Bun's author), hardened runtime | Upstream's signature; re-signing would replace it |
| `libexec/opencode` (rebuilt here) | ad hoc, linker-signed | The rebuild has no upstream signature |

## Distribution method and what each implies

| Method | Gatekeeper behaviour | Work needed |
| --- | --- | --- |
| `curl`/`scp` of the `.tar.gz`, then `./install.sh` (what this alpha documents) | Files extracted by `tar` carry no quarantine flag, so first launch is not assessed. The installer also clears the flag after verifying checksums. | None beyond what exists; the trust decision is the checksum |
| Browser download of the `.tar.gz` | Archive Utility propagates quarantine to extracted files; unnotarized binaries are blocked on first launch ("cannot be verified") until the flag is removed. The installer removes it, but a user running a binary before installing is blocked | Notarization |
| Signed, notarized `.pkg` or `.dmg` (recommended for external testers) | Passes Gatekeeper on a clean Mac | Items below |

## Remaining work for a notarized distribution (none of it done, none possible without an Apple Developer account)

1. Developer ID Application certificate; sign `vm-owner` (keep only the virtualization entitlement) and the rebuilt `opencode` with `--options runtime --timestamp`.
2. Decide whether to re-sign `bun` (replacing upstream's signature) or leave it; either way it must be notarized as part of the container.
3. Build a `.pkg` (Developer ID Installer) or `.dmg`; a bare `.tar.gz` cannot carry a stapled notarization ticket.
4. `xcrun notarytool submit … --wait`, `xcrun stapler staple`.
5. Test on a clean Mac, downloaded through a browser, that the VM helper starts with the virtualization entitlement under hardened runtime, and re-qualify the archive bytes (the signatures change the archive).
6. Keep the installer's checksum verification; notarization does not replace it.

The clean-host question and this one are linked: only a clean Mac that downloaded the archive the way a tester will can show Gatekeeper behaviour.
