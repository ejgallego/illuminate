#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
demo_port="${ILLUMINATE_DEMO_PORT:-8765}"

cd "$repo_root"
lake test --wfail
npm run stage:players
npm run test:player-traces
if [ -n "${ILLUMINATE_FIR_LIVE_PLAYER_DIR:-}" ]; then
  npm run stage:fir-live
fi
if [ -n "${ILLUMINATE_LLVM_PLAYER_DIR:-}" ]; then
  npm run stage:llvm-live
fi

echo "Illuminate JavaScript / VIR / FIR runtime comparison:"
echo "http://127.0.0.1:$demo_port/anim-comparison.html"
python3 -m http.server "$demo_port" --bind 127.0.0.1 --directory "$repo_root/test_output"
