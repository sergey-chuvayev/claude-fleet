#!/usr/bin/env bash
# Running Fleet from a checkout. Installed copies use the `claude-fleet` command,
# which is this same entry point — keeping one implementation of "prefer the
# installed Claude CLI, then start the server".
set -euo pipefail
cd "$(dirname "$0")"
exec node bin/claude-fleet.js "$@"
