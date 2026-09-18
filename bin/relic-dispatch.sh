#!/usr/bin/env bash
# Prefer the native binary for the commands it implements; fall back to the
# TypeScript CLI for everything else.
#
# The native binary is OPTIONAL by design — `bunx github:Soul-Brews-Studio/agents-relic`
# must keep working with no Rust toolchain, no build step, nothing installed.
# This script only shortcuts a path when the binary happens to be present.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE="$HERE/rust/target/release/relic-native"

# Keep in sync with main.rs's match arms. A command listed here but not actually
# implemented natively exits 2 and does NOT fall through — so only add a name
# here after its arm exists.
NATIVE_CMDS="now"

cmd="${1:-help}"
if [ -x "$NATIVE" ] && printf '%s\n' $NATIVE_CMDS | grep -qx "$cmd"; then
  exec "$NATIVE" "$@"
fi
exec bun "$HERE/src/cli.ts" "$@"
