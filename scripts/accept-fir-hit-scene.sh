#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
history_path="${ILLUMINATE_HIT_SCENE_HISTORY:-$repo_root/test_output/hit-scene-performance-history.jsonl}"

cd "$repo_root"
lake test --wfail
npm run stage:fir-hit-scene
npm run test:fir-hit-scene-host
npm run test:hit-scene-benchmark
npm run test:hit-scene-history
npm run measure:hit-scene -- \
  --suite \
  --require-fir \
  --history="$history_path" \
  --label=fir-v2-acceptance
npm run stage:hit-scene-performance

echo "accepted FIR HitScene v2 package and recorded $history_path"
