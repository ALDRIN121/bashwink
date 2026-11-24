# Installation

Developer installation is blocked pending the verified release archive.

The planned archive is `bashwink-v0.1.0-alpha-macos-arm64.tar.gz` with a published
SHA-256 checksum. The acceptance procedure verifies the checksum, extracts to a
user-owned installation directory, adds its `bin` directory to PATH, and runs
`bashwink --version` and `bashwink doctor` from a fresh shell outside the checkout.
The archive must include or document every required runtime input. Docker,
repository cloning, npm global installation, and privileged installation are
outside the intended path.

For an upgrade, keep the previous installation until the new candidate passes
`doctor` and reopens a disposable test session. For uninstall acceptance, remove
the installed application directory and its PATH entry, then verify the command
is absent. The final archive instructions must name the separate user state and
explicitly document how to retain or remove it.

[Supported platforms](SUPPORTED_PLATFORMS.md) · [Acceptance results](ACCEPTANCE_RESULTS.md)
