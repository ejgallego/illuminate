#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
native_root="${ILLUMINATE_FIR_HIT_SCENE_DIR:-}"
stage_root="$repo_root/test_output/fir-hit-scene"
stage_parent="$repo_root/test_output"

if [ -z "$native_root" ]; then
  echo "set ILLUMINATE_FIR_HIT_SCENE_DIR to an immutable FIR hit-scene package" >&2
  exit 1
fi

if [ -L "$native_root" ]; then
  echo "use an immutable FIR package directory, not a symlink" >&2
  exit 1
fi
native_root="$(cd "$native_root" && pwd -P)"
if [ "$(basename "$native_root")" = "illuminate-hit-scene-current" ]; then
  echo "use an immutable FIR package directory, not illuminate-hit-scene-current" >&2
  exit 1
fi

required=(
  BUILD.json
  SHA256SUMS
  illuminate-hit-scene-browser-adapter.mjs
  illuminate-hit-scene.wasm
  illuminate-hit-scene.wasm.json
  smoke.mjs
)

for file in "${required[@]}"; do
  if [ ! -f "$native_root/$file" ]; then
    echo "missing FIR hit-scene artifact: $native_root/$file" >&2
    exit 1
  fi
done

ILLUMINATE_FIR_HIT_SCENE_DIR="$native_root" \
  node --no-warnings "$repo_root/scripts/test-fir-hit-scene-package.mjs"

mkdir -p "$stage_parent"
stage_tmp="$(mktemp -d "$stage_parent/.fir-hit-scene-stage.XXXXXX")"
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

echo "staged persistent FIR Illuminate hit-scene assets under test_output/fir-hit-scene"
