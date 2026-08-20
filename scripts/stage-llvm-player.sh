#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
package_root="${ILLUMINATE_LLVM_PLAYER_DIR:-}"
stage_root="$repo_root/test_output/llvm-live"
stage_parent="$repo_root/test_output"

if [ -z "$package_root" ]; then
  echo "set ILLUMINATE_LLVM_PLAYER_DIR to an immutable FIR-LLVM selection-player package" >&2
  exit 1
fi
if [ -L "$package_root" ]; then
  echo "use an immutable FIR-LLVM package directory, not a symlink" >&2
  exit 1
fi
package_root="$(cd "$package_root" && pwd -P)"
if [ "$(basename "$package_root")" = "illuminate-selection-player-current" ]; then
  echo "use an immutable FIR-LLVM package directory, not illuminate-selection-player-current" >&2
  exit 1
fi

required=(
  README.md
  SHA256SUMS
  emscripten-loader.mjs
  illuminate-selection-player-emscripten-adapter.mjs
  illuminate-selection-player.manifest.json
  illuminate-selection-player.mjs
  illuminate-selection-player.wasm
  smoke.mjs
)
for file in "${required[@]}"; do
  if [ ! -f "$package_root/$file" ]; then
    echo "missing FIR-LLVM selection-player artifact: $package_root/$file" >&2
    exit 1
  fi
  if [ -L "$package_root/$file" ]; then
    echo "FIR-LLVM package files must be regular files, not symlinks: $package_root/$file" >&2
    exit 1
  fi
done

(
  cd "$package_root"
  sha256sum --check SHA256SUMS
  node smoke.mjs
)
ILLUMINATE_LLVM_PLAYER_DIR="$package_root" \
  node --no-warnings "$repo_root/scripts/test-llvm-live-package.mjs"

mkdir -p "$stage_parent"
stage_tmp="$(mktemp -d "$stage_parent/.llvm-live-stage.XXXXXX")"
cleanup() {
  rm -rf "$stage_tmp"
}
trap cleanup EXIT
for file in "${required[@]}"; do
  cp "$package_root/$file" "$stage_tmp/$file"
done
(
  cd "$stage_tmp"
  sha256sum --check SHA256SUMS
  node smoke.mjs
)

rm -rf "$stage_root"
mv "$stage_tmp" "$stage_root"
trap - EXIT

echo "staged FIR-LLVM Illuminate selection-player assets under test_output/llvm-live"
