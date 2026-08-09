#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
native_root="${ILLUMINATE_NATIVE_PLAYER_DIR:-$repo_root/native-player}"
stage_root="$repo_root/test_output/native"

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
    "3ed87ac8d6a21c0afb2b00efcde6f5390c47be336c09214c24ead847bdb4f306",
  ],
  [
    "src/Illuminate/Animation/Types.lean",
    "97a030fdd3ef718912479343cadf0131616a8a9b458901e963dc3709cf5633a3",
  ],
]);
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
  "658d36e6388197649da7a63198aec8454306727d",
);
assert.equal(build.entry.sourceName, "Illuminate.AnimationPlayer.replayTrace");
assert.equal(build.entry.exportName, "Illuminate.AnimationPlayer.replayTrace");
assert.equal(build.entry.parameters[0].lean, "Illuminate.PlayerAnimation");
assert.equal(build.entry.parameters[1].lean, "List PlayerEvent");
assert.equal(build.entry.result.lean, "Except String (Array FrameAction)");
assert.equal(descriptor.entry, build.entry.exportName);
assert.equal(descriptor.sourceEntry, build.entry.sourceName);
assert.deepEqual(descriptor.params, ["object", "tobject"]);
assert.equal(descriptor.result, "object");
assert.deepEqual(WebAssembly.Module.imports(module), []);
const exports = WebAssembly.Module.exports(module);
assert.deepEqual(
  exports.filter(({ kind }) => kind === "function").map(({ name }) => name).sort(),
  [
    "Illuminate.AnimationPlayer.replayTrace",
    "fir_heap_alloc",
    "fir_heap_frontier",
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
assert.equal(build.wasm.functionExportCount, 4);
assert.equal(build.wasm.byteLength, 50194);
assert.equal(
  build.wasm.sha256,
  "3ec5485591b88397cc6b664894f343fc156ce50fb346f6b0c189cde0e50944c9",
);
assert.equal(build.wasm.base.byteLength, 18005);
assert.equal(
  build.wasm.base.sha256,
  "2f26b90debd56473f7d30ec20903124fd7e625acf62c5e1d1cbb226e80b4aa62",
);
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  build.wasm.sha256,
);
assert.equal(
  build.capabilities.browserAdapter.apiVersion,
  "fir.illuminate-player.browser/v2",
);
assert.equal(
  build.capabilities.inputLayout.version,
  "lean-4.32-Illuminate.Animation.PlayerAnimation/v2",
);
assert.equal(
  build.capabilities.ownership.version,
  "fir.illuminate-player.module-owned-arena/v1",
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
