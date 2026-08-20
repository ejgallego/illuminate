#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$repo_root"

lake test --wfail
npm run stage:vir-all

if [ -n "${ILLUMINATE_NATIVE_PLAYER_DIR:-}" ]; then
  npm run stage:native
elif [ -f "$repo_root/test_output/native/illuminate-player.wasm" ]; then
  echo "reusing staged FIR full-action player under test_output/native"
else
  echo "FIR full-action player not staged; set ILLUMINATE_NATIVE_PLAYER_DIR to include it"
fi

if [ -n "${ILLUMINATE_FIR_LIVE_PLAYER_DIR:-}" ]; then
  npm run stage:fir-live
elif [ -f "$repo_root/test_output/fir-live/illuminate-selection-player.wasm" ]; then
  echo "reusing staged FIR selection player under test_output/fir-live"
else
  echo "FIR selection player not staged; set ILLUMINATE_FIR_LIVE_PLAYER_DIR to include it"
fi

if [ -n "${ILLUMINATE_LLVM_PLAYER_DIR:-}" ]; then
  npm run stage:llvm-live
elif [ -f "$repo_root/test_output/llvm-live/illuminate-selection-player.manifest.json" ]; then
  echo "reusing staged FIR-LLVM selection player under test_output/llvm-live"
else
  echo "FIR-LLVM selection player not staged; set ILLUMINATE_LLVM_PLAYER_DIR to include it"
fi

if [ -n "${ILLUMINATE_FIR_HIT_SCENE_DIR:-}" ]; then
  npm run stage:fir-hit-scene
fi

if [ -n "${ILLUMINATE_FIR_SPATIAL_HIT_SCENE_DIR:-}" ]; then
  npm run stage:fir-spatial-hit-scene
fi

if [ -f "$repo_root/test_output/native/illuminate-player.wasm" ]; then
  npm run test:player-traces
fi

hit_scene_requirements=()
if [ -f "$repo_root/test_output/fir-hit-scene/illuminate-hit-scene.wasm" ]; then
  hit_scene_requirements+=(--require-fir)
fi
if [ -f "$repo_root/test_output/fir-spatial-hit-scene/illuminate-spatial-hit-scene.wasm" ]; then
  hit_scene_requirements+=(--require-spatial-fir)
fi
npm run measure:hit-scene -- --quick "${hit_scene_requirements[@]}"
npm run measure:hit-scene -- --suite --quick "${hit_scene_requirements[@]}"
npm run profile:vir-hit-scene -- --quick
npm run measure:vir-spatial-hit-scene -- --quick
npm run stage:hit-scene-performance

cp "$repo_root/player_js/demo-index.html" "$repo_root/test_output/index.html"

demo_pages=(
  index.html
  anim-comparison.html
  hit-scene-performance.html
  anim-seek-test.html
  anim-vir-seek-test.html
  anim-loop-test.html
  anim-vir-loop-test.html
  anim-segment-test.html
  anim-vir-segment-test.html
  anim-dual-test.html
  anim-vir-dual-test.html
  anim-clippath-test.html
  anim-clipshape-test.html
  anim-gradient-color-test.html
)
for page in "${demo_pages[@]}"; do
  if [ ! -f "$repo_root/test_output/$page" ]; then
    echo "missing generated demo page: $page" >&2
    exit 1
  fi
done

echo "${#demo_pages[@]} Illuminate demo pages are staged under $repo_root/test_output"
echo "Serve them with:"
echo "  python3 -m http.server 8765 --bind 127.0.0.1 --directory $repo_root/test_output"
echo "Then open http://127.0.0.1:8765/"
