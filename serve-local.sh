#!/usr/bin/env bash
# Build the site and serve it locally. Re-run any time to rebuild + restart.
# `jekyll serve` itself crashes under Ruby 3.2 (a separate incompatibility in
# its --watch code path), so this builds statically and serves the output
# with a plain HTTP server instead.
set -e
cd "$(dirname "$0")"

PORT="${1:-4444}"

BUNDLE_BIN=""
for candidate in bundle bundle3.2; do
  if command -v "$candidate" >/dev/null 2>&1; then
    BUNDLE_BIN="$candidate"
    break
  fi
done
if [ -z "$BUNDLE_BIN" ]; then
  echo "Could not find a 'bundle' executable (tried: bundle, bundle3.2)." >&2
  exit 1
fi

echo "Building site..."
"$BUNDLE_BIN" exec ruby bin/local-jekyll.rb build

# free up the port in case a previous run is still bound to it
fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true

echo ""
echo "Serving http://127.0.0.1:${PORT}/  (Ctrl+C to stop)"
cd _site
exec python3 -m http.server "$PORT"
