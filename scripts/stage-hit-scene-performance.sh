#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$repo_root"
npm run build:vir-widget

cp "$repo_root/player_js/hit_scene_performance.html" \
  "$repo_root/test_output/hit-scene-performance.html"
cp "$repo_root/player_js/generated/hit_scene_performance.js" \
  "$repo_root/test_output/hit-scene-performance.js"

echo "staged HitScene performance report viewer under test_output"
