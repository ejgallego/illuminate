#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
native_root="${ILLUMINATE_NATIVE_PLAYER_DIR:-$repo_root/native-player}"
stage_root="$repo_root/test_output/native"

if [ -L "$native_root" ]; then
  echo "use an immutable FIR package directory, not a symlink" >&2
  exit 1
fi
native_root="$(cd "$native_root" && pwd -P)"
if [ "$(basename "$native_root")" = "illuminate-player-current" ]; then
  echo "use an immutable FIR package directory, not illuminate-player-current" >&2
  exit 1
fi

required=(
  BUILD.json
  SHA256SUMS
  illuminate-player-browser-adapter.mjs
  illuminate-player.wasm
  illuminate-player.wasm.json
  smoke.mjs
)

for file in "${required[@]}"; do
  if [ ! -f "$native_root/$file" ]; then
    echo "missing FIR-native player artifact: $native_root/$file" >&2
    echo "copy a tested FIR package to $repo_root/native-player or set ILLUMINATE_NATIVE_PLAYER_DIR" >&2
    exit 1
  fi
done

(
  cd "$native_root"
  sha256sum --check SHA256SUMS
)

node --input-type=module - "$native_root" "$repo_root" <<'NODE'
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2];
const repoRoot = process.argv[3];
const [bytes, descriptor, build] = await Promise.all([
  readFile(path.join(root, "illuminate-player.wasm")),
  readFile(path.join(root, "illuminate-player.wasm.json"), "utf8").then(JSON.parse),
  readFile(path.join(root, "BUILD.json"), "utf8").then(JSON.parse),
]);
const module = new WebAssembly.Module(bytes);
const expectedSources = new Map([
  [
    "src/Illuminate/Animation/Player.lean",
    "e1f98f9d02118f4b61a3f935dbdf49b1c3caf7c0b52aa0f80b7232fb740cd620",
  ],
  [
    "src/Illuminate/Animation/Types.lean",
    "97a030fdd3ef718912479343cadf0131616a8a9b458901e963dc3709cf5633a3",
  ],
  [
    "src/Illuminate/Animation/FirLive.lean",
    "941daf939d9faa966aa8fb848b4a8f7ce0525ba6420d3843067e2c97908e2121",
  ],
]);
assert.ok(
  Array.isArray(build.sources?.illuminate?.relevantFiles),
  "FIR package does not inventory its Illuminate source files",
);
for (const [source, expected] of expectedSources) {
  const actual = createHash("sha256")
    .update(await readFile(path.join(repoRoot, source)))
    .digest("hex");
  assert.equal(actual, expected, `${source} does not match the FIR package input`);
  assert.equal(
    build.sources.illuminate.relevantFiles.find(({ path: candidate }) => candidate === source)?.sha256,
    expected,
    `${source} is missing from the FIR package source inventory`,
  );
}
assert.equal(build.schemaVersion, "fir.illuminate-player.build/v1");
assert.equal(
  build.sources.fir.commit,
  "c797b6db8ef435cdb39a75e53f86e0b73048181f",
);
assert.deepEqual(
  build.entries.map(({ sourceName }) => sourceName),
  [
    "Illuminate.AnimationPlayer.initialLive",
    "Illuminate.AnimationPlayer.transitionLive",
  ],
);
assert.equal(build.entries[0].parameters[0].lean, "PlayerAnimation");
assert.equal(build.entries[0].result.lean, "Except String LiveTransition");
assert.equal(build.entries[1].parameters[0].lean, "PlayerAnimation");
assert.equal(build.entries[1].parameters[1].lean, "PlayerState");
assert.equal(build.entries[1].parameters[2].lean, "PlayerEvent");
assert.equal(build.entries[1].result.lean, "LiveTransition");
assert.equal(descriptor.entry, build.entries[0].exportName);
assert.equal(descriptor.sourceEntry, build.entries[0].sourceName);
assert.deepEqual(descriptor.params, ["object"]);
assert.equal(descriptor.result, "object");
assert.deepEqual(WebAssembly.Module.imports(module), []);
const exports = WebAssembly.Module.exports(module);
assert.deepEqual(
  exports.filter(({ kind }) => kind === "function").map(({ name }) => name).sort(),
  [
    "Illuminate.AnimationPlayer.initialLive",
    "Illuminate.AnimationPlayer.transitionLive",
    "fir_heap_alloc",
    "fir_heap_frontier",
    "fir_heap_rewind",
    "fir_heap_set_frontier",
  ].sort(),
);
assert.deepEqual(
  exports.filter(({ kind }) => kind !== "function"),
  [{ name: "memory", kind: "memory" }],
);
assert.equal(build.wasm.functionImportCount, 0);
assert.equal(build.wasm.memoryImportCount, 0);
assert.equal(build.wasm.memoryOwner, "module");
assert.deepEqual(build.wasm.memoryExports, ["memory"]);
assert.equal(build.wasm.functionExportCount, 6);
assert.equal(build.wasm.byteLength, 50211);
assert.equal(
  build.wasm.sha256,
  "a4de0ec22d50c5070dbfa90969dc95c41be6f747955f60c8f9620baeafefbfa5",
);
assert.equal(build.wasm.base.byteLength, 18911);
assert.equal(
  build.wasm.base.sha256,
  "61cc4efd3f4d637dcc63e25783f52a8d1680acb269f86f1d277470bbcf6e7cc4",
);
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  build.wasm.sha256,
);
assert.equal(
  build.capabilities.browserAdapter.apiVersion,
  "fir.illuminate-player.browser/v3",
);
assert.equal(
  build.capabilities.inputLayout.version,
  "lean-4.32-Illuminate.Animation.PlayerAnimation-live/v3",
);
assert.equal(
  build.capabilities.ownership.version,
  "fir.illuminate-player.persistent-checkpoint/v2",
);
NODE

mkdir -p "$stage_root"
for file in "${required[@]}"; do
  cp "$native_root/$file" "$stage_root/$file"
done

(
  cd "$stage_root"
  sha256sum --check SHA256SUMS
  node smoke.mjs
)

echo "staged FIR-native Illuminate player assets under test_output/native"
