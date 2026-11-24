#!/usr/bin/env bash
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="$repo/fixtures/native-offline"
exec python3 "$repo/fixtures/interactive-entry/verify.py"
