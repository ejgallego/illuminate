#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
native_root="${ILLUMINATE_FIR_SPATIAL_HIT_SCENE_DIR:-}"
stage_root="$repo_root/test_output/fir-spatial-hit-scene"
stage_parent="$repo_root/test_output"

if [ -z "$native_root" ]; then
  echo "set ILLUMINATE_FIR_SPATIAL_HIT_SCENE_DIR to an immutable FIR spatial HitScene package" >&2
  exit 1
fi

if [ -L "$native_root" ]; then
  echo "use an immutable FIR package directory, not a symlink" >&2
  exit 1
fi
native_root="$(cd "$native_root" && pwd -P)"
if [ "$(basename "$native_root")" = "illuminate-spatial-hit-scene-current" ]; then
  echo "use an immutable FIR package directory, not illuminate-spatial-hit-scene-current" >&2
  exit 1
fi

required=(
  BUILD.json
  SHA256SUMS
  browser-smoke.html
  hit-scene-benchmark.json
  hit-scene-benchmark-suite.json
  illuminate-spatial-hit-scene-browser-adapter.mjs
  illuminate-spatial-hit-scene.wasm
  illuminate-spatial-hit-scene.wasm.json
  smoke.mjs
)

for file in "${required[@]}"; do
  if [ ! -f "$native_root/$file" ]; then
    echo "missing FIR spatial HitScene artifact: $native_root/$file" >&2
    exit 1
  fi
done

ILLUMINATE_FIR_SPATIAL_HIT_SCENE_DIR="$native_root" \
  node --no-warnings "$repo_root/scripts/test-fir-spatial-hit-scene-package.mjs"

mkdir -p "$stage_parent"
stage_tmp="$(mktemp -d "$stage_parent/.fir-spatial-hit-scene-stage.XXXXXX")"
cleanup() {
  rm -rf "$stage_tmp"
}
trap cleanup EXIT

for file in "${required[@]}"; do
  cp "$native_root/$file" "$stage_tmp/$file"
done

(
  cd "$stage_tmp"
  sha256sum --check SHA256SUMS
  node smoke.mjs
)

rm -rf "$stage_root"
mv "$stage_tmp" "$stage_root"
trap - EXIT

echo "staged persistent FIR spatial HitScene assets under test_output/fir-spatial-hit-scene"
