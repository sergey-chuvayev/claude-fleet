#!/usr/bin/env bash
# Running Fleet from a checkout. Installed copies use the `claude-fleet` command,
# which is this same entry point — keeping one implementation of "prefer the
# installed Claude CLI, then start the server".
set -euo pipefail
cd "$(dirname "$0")"
# A checkout serves the web app from dist/, which is never committed. Build it on every
# start (about a second), so a `git pull` can never leave a stale page behind.
npm run --silent build:frontend >/dev/null
exec node bin/claude-fleet.js "$@"
