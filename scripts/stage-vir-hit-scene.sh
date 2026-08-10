#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
vir_root="$repo_root/vir"

if [ ! -f "$vir_root/Vir/Runtime.lean" ]; then
  echo "missing repository-local VIR checkout at $vir_root" >&2
  exit 1
fi

if [ ! -d "$vir_root/node_modules" ]; then
  npm --prefix "$vir_root" install
fi

if [ ! -d "$vir_root/third_party/lean4-src/.git" ]; then
  npm --prefix "$vir_root" run fetch:lean
fi

if [ ! -x "$vir_root/.tools/wasi-sdk/bin/clang" ]; then
  npm --prefix "$vir_root" run install:wasi
fi

sdk_archive="$vir_root/build/artifacts/lean-vir-sdk.tar.gz"
if [ ! -f "$sdk_archive" ] || find \
    "$vir_root/Vir" \
    "$vir_root/web/src" \
    "$vir_root/wasm/upstream_shim" \
    "$vir_root/tools" \
    "$vir_root/scripts/build-demo.sh" \
    "$vir_root/scripts/build-infoview-widget.mjs" \
    "$vir_root/scripts/build-lean-lib.sh" \
    "$vir_root/scripts/build-upstream-probe.sh" \
    "$vir_root/scripts/file-utils.mjs" \
    "$vir_root/scripts/package-sdk-artifact.mjs" \
    "$vir_root/scripts/package-versions.mjs" \
    "$vir_root/scripts/process-utils.mjs" \
    "$vir_root/scripts/sdk-payloads.mjs" \
    "$vir_root/lakefile.lean" \
    "$vir_root/lean-toolchain" \
    "$vir_root/package.json" \
    "$vir_root/package-lock.json" \
    -type f -newer "$sdk_archive" -print -quit | grep -q .; then
  npm --prefix "$vir_root" run build:sdk-artifact
else
  echo "reusing current repository-local VIR SDK artifact"
fi

cd "$repo_root"
lake build +Illuminate.Diagram.HitScene.Vir:vir

VIR_SDK_ARCHIVE="$sdk_archive" lake build :virSdk

stage_root="$repo_root/test_output/vir"
sdk_source="$repo_root/.lake/build/vir/sdk"
package_set_source="$repo_root/.lake/build/vir/module-sets/Illuminate/Diagram/HitScene"
package_set_dir="$stage_root/module-sets/Illuminate/Diagram/HitScene"

mkdir -p "$stage_root" "$package_set_dir"
rm -rf "$stage_root/sdk" "$package_set_dir"
mkdir -p "$stage_root/sdk" "$package_set_dir"
cp -R "$sdk_source/." "$stage_root/sdk/"
cp "$package_set_source/Vir.irpkg-set.json" "$package_set_dir/Vir.irpkg-set.json"
cp "$package_set_source/Vir.irpkg" "$package_set_dir/Vir.irpkg"
cp -R "$package_set_source/Vir.parts" "$package_set_dir/Vir.parts"

echo "staged Illuminate VIR hit-scene assets under test_output/vir"
