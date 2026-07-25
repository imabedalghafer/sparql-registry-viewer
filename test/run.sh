#!/usr/bin/env sh
# Run the unit tests. Uses a local node if present, otherwise docker.
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
if command -v node >/dev/null 2>&1; then
  exec node "$DIR/test/rdf.test.mjs"
fi
exec docker run --rm -v "$DIR:/w:ro" -w /w node:22-alpine node test/rdf.test.mjs
