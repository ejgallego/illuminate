#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
vir_root="$repo_root/vir"

if [ "$#" -eq 0 ]; then
  set -- animation hit-scene
fi

stage_animation=false
stage_hit_scene=false
for artifact in "$@"; do
  case "$artifact" in
    animation)
      stage_animation=true
      ;;
    hit-scene)
      stage_hit_scene=true
      ;;
    *)
      echo "unknown VIR artifact '$artifact'; expected animation or hit-scene" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "$vir_root/Vir/Runtime.lean" ]; then
  echo "missing repository-local VIR checkout at $vir_root" >&2
  exit 1
fi

if [ ! -d "$vir_root/node_modules" ]; then
  npm --prefix "$vir_root" install
fi

npm --prefix "$repo_root" run build:vir-widget

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
if [ "$stage_animation" = true ]; then
  lake build +Illuminate.Animation.Vir:vir
fi
if [ "$stage_hit_scene" = true ]; then
  lake build +Illuminate.Diagram.HitScene.Vir:vir
fi

VIR_SDK_ARCHIVE="$sdk_archive" lake build :virSdk

stage_root="$repo_root/test_output/vir"
sdk_source="$repo_root/.lake/build/vir/sdk"

mkdir -p "$stage_root"
rm -rf "$stage_root/sdk"
mkdir -p "$stage_root/sdk"
cp -R "$sdk_source/." "$stage_root/sdk/"

stage_module_set() {
  local module_path="$1"
  local package_set_source="$repo_root/.lake/build/vir/module-sets/$module_path"
  local package_set_dir="$stage_root/module-sets/$module_path"

  rm -rf "$package_set_dir"
  mkdir -p "$package_set_dir"
  cp "$package_set_source/Vir.irpkg-set.json" "$package_set_dir/Vir.irpkg-set.json"
  cp "$package_set_source/Vir.irpkg" "$package_set_dir/Vir.irpkg"
  cp -R "$package_set_source/Vir.parts" "$package_set_dir/Vir.parts"
}

if [ "$stage_animation" = true ]; then
  stage_module_set "Illuminate/Animation"
fi
if [ "$stage_hit_scene" = true ]; then
  stage_module_set "Illuminate/Diagram/HitScene"
fi

staged=()
if [ "$stage_animation" = true ]; then
  staged+=("animation")
fi
if [ "$stage_hit_scene" = true ]; then
  staged+=("hit-scene")
fi
echo "staged Illuminate VIR ${staged[*]} assets under test_output/vir"
