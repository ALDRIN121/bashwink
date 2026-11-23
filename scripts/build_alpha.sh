#!/usr/bin/env bash
# Build a self-contained Bashwink install outside the source repo (BW-091, STEP 3).
#
# What "clean install" means here, concretely: a directory that contains everything the
# wrapper needs to run a real model against a real repository, with no path back into the
# checkout and no npm registry dependency on the private `@bashwink/*` packages.
#
# Layout produced:
#
#   <out>/bin/bashwink            launcher (a tiny shim; no node_modules resolution tricks)
#   <out>/lib/bashwink.js         the CLI, bundled
#   <out>/lib/version.json        version + build id, so --version is not a hardcoded constant
#   <out>/lib/evidence/           the evidence plugin, as source the runtime can load
#   <out>/lib/evidence/node_modules/@opencode/plugin   the plugin SDK peer
#
# The evidence plugin stays source rather than being bundled into the CLI: the runtime loads
# it as a separate module from the staged plugin directory, so it must resolve its own
# imports (`@opencode/plugin`) from beside itself.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/dist/bashwink}"
BUN="${BUN:-bun}"

VERSION="$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" "$ROOT/packages/bw-cli/package.json")"
BUILD="${BASHWINK_BUILD:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo local)}"

echo "==> building bashwink $VERSION ($BUILD) into $OUT"
rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/lib"

# 1. Bundle the CLI. `--target=bun` keeps Bun builtins external (they are in the runtime).
"$BUN" build "$ROOT/packages/bw-cli/src/bin.ts" \
  --target=bun \
  --outfile "$OUT/lib/bashwink.js" >/dev/null

printf '{"version":"%s","build":"%s"}\n' "$VERSION" "$BUILD" > "$OUT/lib/version.json"

# 2. Ship the evidence plugin as source.
cp -R "$ROOT/packages/bw-evidence" "$OUT/lib/evidence"
rm -rf "$OUT/lib/evidence/node_modules" "$OUT/lib/evidence/test" "$OUT/lib/evidence/.turbo"

# 3. Give the plugin its SDK peer. Installed into the copy, so the install directory is
#    relocatable: moving it does not break the plugin's imports.
(
  cd "$OUT/lib/evidence"
  printf '%s\n' '{"name":"bashwink-evidence-runtime","private":true,"type":"module"}' > package.json.runtime
  "$BUN" add --no-save "@opencode/plugin@2.3.2" >/dev/null 2>&1 || {
    echo "error: could not install @opencode/plugin@2.3.2 (needed by the evidence plugin)" >&2
    exit 1
  }
  rm -f package.json.runtime
)

# 4. Launcher. Uses the interpreter named at build time, and resolves its own directory so
#    the installer can be moved or symlinked into a PATH.
cat > "$OUT/bin/bashwink" <<LAUNCHER
#!/usr/bin/env bash
set -euo pipefail
SELF="\${BASH_SOURCE[0]}"
while [ -L "\$SELF" ]; do SELF="\$(readlink "\$SELF")"; done
DIR="\$(cd "\$(dirname "\$SELF")/../lib" && pwd)"
exec "${BUN}" "\$DIR/bashwink.js" "\$@"
LAUNCHER
chmod +x "$OUT/bin/bashwink"

echo "==> done"
echo "    $OUT/bin/bashwink"
echo
echo "    add to PATH:  export PATH=\"$OUT/bin:\$PATH\""
echo "    check it:     bashwink --version && bashwink doctor"
