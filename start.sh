#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# The SDK ships its own Claude runtime, which can lag the CLI you actually use and
# therefore offer an older set of models. Prefer the installed CLI when there is one,
# so Fleet's agents run the same Claude as your terminals. Set CLAUDE_FLEET_EXECUTABLE
# yourself to pin a specific binary, or to "bundled" to use the SDK's own.
if [ "${CLAUDE_FLEET_EXECUTABLE:-}" = "bundled" ]; then
  unset CLAUDE_FLEET_EXECUTABLE
elif [ -z "${CLAUDE_FLEET_EXECUTABLE:-}" ]; then
  LOCAL_CLAUDE="$(command -v claude || true)"
  if [ -n "$LOCAL_CLAUDE" ] && [ -x "$LOCAL_CLAUDE" ]; then
    export CLAUDE_FLEET_EXECUTABLE="$LOCAL_CLAUDE"
    echo "  Using your Claude CLI: $LOCAL_CLAUDE ($("$LOCAL_CLAUDE" --version 2>/dev/null || echo 'version unknown'))"
  fi
fi

exec node server.js --open
