#!/bin/sh
# Install Bashwink from an extracted release archive.
#
#   ./install.sh [--prefix DIR] [--bin-dir DIR]
#
# Defaults: files go to ~/.local/opt/bashwink/<version>, and a `bashwink` link goes to
# ~/.local/bin. Nothing outside those two places is written, no shell profile is edited, and
# no administrator rights are needed. Run it as yourself, never with sudo.
set -eu

here=$(cd "$(dirname "$0")" && pwd -P)
prefix="${HOME}/.local/opt/bashwink"
bin_dir="${HOME}/.local/bin"

while [ $# -gt 0 ]; do
    case "$1" in
        --prefix) prefix=$2; shift 2 ;;
        --bin-dir) bin_dir=$2; shift 2 ;;
        -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "install: unknown option $1" >&2; exit 2 ;;
    esac
done

case "$prefix" in
    */bashwink) ;;
    *) echo "install: refusing --prefix $prefix: it must end in /bashwink so that removal can never touch another directory" >&2; exit 2 ;;
esac

fail() { echo "install: $*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "do not run the installer as root; it installs for the current user"
if [ ! -f "$here/MANIFEST.sha256" ]; then
    fail "MANIFEST.sha256 is missing; this legacy archive installer only supports extracted v0.1.0-alpha.1 macOS arm64 release tarballs. For standalone v0.2.0-alpha.2 from a source checkout, run 'npm run install:local' from the repository root."
fi
[ "$(uname -s)" = Darwin ] || fail "Bashwink v@VERSION@ supports macOS only (found $(uname -s))"
[ "$(uname -m)" = arm64 ] || fail "Bashwink v@VERSION@ supports Apple Silicon only (found $(uname -m))"
version=$(cat "$here/VERSION")
os_version=$(sw_vers -productVersion)
os_build=$(sysctl -n kern.osversion)

if ! grep -q "\"version\": \"$os_version\", \"build\": \"$os_build\"" "$here/qualified-hosts.json"; then
    echo "install: WARNING: macOS $os_version ($os_build) is not a qualified host for Bashwink $version." >&2
    echo "         It will install, but 'bashwink' will refuse to start the VM here. Qualified hosts:" >&2
    sed 's/^/           /' "$here/qualified-hosts.json" >&2
fi

echo "Verifying every file in the archive against MANIFEST.sha256 ..."
(cd "$here" && shasum -a 256 -c MANIFEST.sha256 --quiet) || fail "integrity check failed; re-download the archive and check its SHA-256"

target="$prefix/$version"
staging="$prefix/.incoming-$version-$$"
mkdir -p "$prefix"
rm -rf "$staging"
trap 'rm -rf "$staging"' EXIT INT TERM
mkdir -m 700 "$staging"
for entry in bin lib libexec share VERSION MANIFEST.sha256 RELEASE_MANIFEST.json qualified-hosts.json install.sh uninstall.sh; do
    cp -Rp "$here/$entry" "$staging/$entry"
done
# The CLI refuses a VM asset directory that anyone else can write to.
chmod -R go-w "$staging"
chmod 755 "$staging"
# A browser download marks files as quarantined; the checksum above is the trust decision.
xattr -dr com.apple.quarantine "$staging" 2>/dev/null || true
(cd "$staging" && shasum -a 256 -c MANIFEST.sha256 --quiet) || fail "post-copy integrity check failed"

if [ -e "$target" ]; then
    mv "$target" "$prefix/.replaced-$version-$$"
    rm -rf "$prefix/.replaced-$version-$$"
fi
mv "$staging" "$target"
trap - EXIT INT TERM
ln -sfn "$target" "$prefix/current"
mkdir -p "$bin_dir"
ln -sfn "$prefix/current/bin/bashwink" "$bin_dir/bashwink"

echo
echo "Installed Bashwink $version"
echo "  files:   $target"
echo "  command: $bin_dir/bashwink"
case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) echo "  note:    $bin_dir is not on your PATH. Add it, for example:"
       echo "             echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.zshrc" ;;
esac
echo
echo "Next:  bashwink doctor        (checks the host, the VM image and your provider)"
echo "Remove: $target/uninstall.sh"
