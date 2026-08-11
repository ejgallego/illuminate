#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
demo_port="${ILLUMINATE_DEMO_PORT:-8765}"

cd "$repo_root"
lake test --wfail
npm run stage:vir-hit-scene
if [ -n "${ILLUMINATE_FIR_HIT_SCENE_DIR:-}" ]; then
  npm run stage:fir-hit-scene
fi
npm run measure:hit-scene
npm run measure:hit-scene -- --suite --quick
npm run profile:vir-hit-scene -- --quick
npm run stage:hit-scene-performance

echo "Illuminate VIR / FIR HitScene performance:"
echo "http://127.0.0.1:$demo_port/hit-scene-performance.html"
python3 -m http.server "$demo_port" --bind 127.0.0.1 --directory "$repo_root/test_output"
