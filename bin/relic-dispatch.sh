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
#
# `now` is NOT here, deliberately. Routing a whole command to the binary means the
# same command prints two different things depending on whether a binary happens to
# be built — native `now` prints three lines, the TypeScript one prints the title,
# the tree size, the live agents and an activity sparkline, and on a miss it prints
# the `--all` hint that the native one drops. The TypeScript `now` already calls the
# binary for the expensive part (the live sweep, see src/live.ts), so routing the
# command gained nothing and cost output parity.
#
# `banks` and `shards` are safe to route: both front ends implement them and are
# covered by test/native-parity.test.ts.
NATIVE_CMDS="banks shards"

cmd="${1:-help}"
if [ -x "$NATIVE" ] && printf '%s\n' $NATIVE_CMDS | grep -qx "$cmd"; then
  exec "$NATIVE" "$@"
fi
exec bun "$HERE/src/cli.ts" "$@"
