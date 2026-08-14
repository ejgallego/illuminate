import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createFirHitSceneHost } from "../player_js/fir_hit_scene.js";
import { loadHitSceneBenchmarkSuite } from "./lib/hit-scene-benchmark.mjs";

const packageArgument = process.env.ILLUMINATE_FIR_SPATIAL_HIT_SCENE_DIR;
assert.ok(
    packageArgument,
    "set ILLUMINATE_FIR_SPATIAL_HIT_SCENE_DIR to an immutable FIR spatial HitScene package",
);
const requestedRoot = path.resolve(packageArgument);
assert.equal(
    (await lstat(requestedRoot)).isSymbolicLink(),
    false,
    "ILLUMINATE_FIR_SPATIAL_HIT_SCENE_DIR must name an immutable package, not a moving symlink",
);
assert.notEqual(
    path.basename(requestedRoot),
    "illuminate-spatial-hit-scene-current",
    "use the immutable package directory rather than illuminate-spatial-hit-scene-current",
);
const packageRoot = await realpath(requestedRoot);
const repositoryRoot = await realpath(new URL("..", import.meta.url));

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

const filenames = {
    adapter: "illuminate-spatial-hit-scene-browser-adapter.mjs",
    build: "BUILD.json",
    manifest: "illuminate-spatial-hit-scene.wasm.json",
    suite: "hit-scene-benchmark-suite.json",
    wasm: "illuminate-spatial-hit-scene.wasm",
};
const [adapterModule, buildBytes, manifestBytes, suiteBytes, wasmBytes] = await Promise.all([
    import(pathToFileURL(path.join(packageRoot, filenames.adapter)).href),
    readFile(path.join(packageRoot, filenames.build)),
    readFile(path.join(packageRoot, filenames.manifest)),
    readFile(path.join(packageRoot, filenames.suite)),
    readFile(path.join(packageRoot, filenames.wasm)),
]);
const build = JSON.parse(buildBytes.toString("utf8"));
JSON.parse(manifestBytes.toString("utf8"));

assert.equal(build.schemaVersion, "fir.illuminate-spatial-hit-scene.build/v1");
assert.equal(build.sources?.fir?.commit, "afc8b88548a9ae3ab1b9a9f053b3674ba4d58a74");
assert.equal(build.sources?.fir?.dirty, false);
assert.equal(build.sources?.illuminate?.commit, "c8d321721262b5987226ae9626abf5ca3e1dfe9b");
assert.equal(build.sources?.illuminate?.pinnedRevision, "3b912826fdb39b27e214b3fef91c2b08c000bfea");
assert.equal(build.sources?.illuminate?.dirty, false);
assert.equal(
    build.capabilities?.browserAdapter?.apiVersion,
    "fir.illuminate-spatial-hit-scene.browser/v1",
);
assert.equal(build.capabilities?.inputLayout?.version, "lean-4.33-Illuminate.SpatialHitScene/v1");
assert.equal(
    build.capabilities?.ownership?.version,
    "fir.illuminate-spatial-hit-scene.persistent-checkpoint/v1",
);
assert.equal(build.wasm?.byteLength, 96_006);
assert.equal(
    build.wasm?.sha256,
    "366d84059bd0d0ffba6f77e1d68414dd93b512568359835b7b2620274c7afe74",
);
assert.equal(wasmBytes.byteLength, build.wasm.byteLength);
assert.equal(sha256(wasmBytes), build.wasm.sha256);

const module = new WebAssembly.Module(wasmBytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
assert.equal(build.wasm.functionImportCount, 0);
assert.equal(build.wasm.memoryImportCount, 0);
assert.equal(build.wasm.memoryOwner, "module");
const expectedFunctionExports = [
    "Illuminate.SpatialHitScene.ofHitScene",
    "IlluminateFirSpatialHitScene.queryBorrowed._fir_bit_exact",
    "fir_heap_alloc",
    "fir_heap_frontier",
    "fir_heap_rewind",
    "fir_heap_set_frontier",
];
assert.deepEqual(
    WebAssembly.Module.exports(module)
        .filter(({ kind }) => kind === "function")
        .map(({ name }) => name)
        .sort(),
    expectedFunctionExports.sort(),
);
assert.deepEqual(
    WebAssembly.Module.exports(module).filter(({ kind }) => kind !== "function"),
    [{ name: "memory", kind: "memory" }],
);

const expectedSources = new Map([
    [
        "src/Illuminate/Diagram/HitScene.lean",
        "1e51512bbe246654cfb8b1c16b40101c659e91d6bbe9bb0745b8b11257ff997e",
    ],
    [
        "src/Illuminate/Diagram/HitScene/Spatial.lean",
        "a6b20101413d47bb467ec2b4cc56d7943340633341a3140b6886ae34665999b6",
    ],
    [
        "src/Illuminate/Geometry/Trace.lean",
        "21956218724ce7deb9ef00354c01261f33dc17c294b013c69494ea8374997a16",
    ],
    [
        "src/Illuminate/Geometry/PathData.lean",
        "92dc894058d3e4a5e08d2a5a1fc3bf1d47bdfd52aa3ff1ec8226bdd04a265793",
    ],
    [
        "src/Illuminate/Geometry/Types.lean",
        "ed63356e5f21cd40b5b653510f20fb71e54b89b4072d848a5a58a66bd4b4d1d0",
    ],
    [
        "src/Illuminate/Geometry/Matrix.lean",
        "28cd47a7d678913ed0d22eeb6284637bfa99860bf760e2225bbd31dec1af80a3",
    ],
]);
for (const [source, expectedHash] of expectedSources) {
    assert.equal(sha256(await readFile(path.join(repositoryRoot, source))), expectedHash);
    assert.equal(
        build.sources.illuminate.relevantFiles.find(({ path: candidate }) => candidate === source)
            ?.sha256,
        expectedHash,
        `${source} is absent from BUILD.json`,
    );
}

assert.equal(
    sha256(suiteBytes),
    "45ee28cbd2eb0ffc0e83e88fbfd9587a5bc325afa638f477837fb38cbf11676d",
);
assert.equal(
    sha256(await readFile(path.join(repositoryRoot, "test_output/hit-scene-benchmark-suite.json"))),
    sha256(suiteBytes),
    "local differential suite differs from the package input",
);

const { createIlluminateSpatialHitSceneAdapter, fetchIlluminateSpatialHitSceneAdapter } =
    adapterModule;
assert.equal(typeof createIlluminateSpatialHitSceneAdapter, "function");
assert.equal(typeof fetchIlluminateSpatialHitSceneAdapter, "function");
const adapter = await createIlluminateSpatialHitSceneAdapter({ bytes: wasmBytes, build });
const suite = await loadHitSceneBenchmarkSuite(path.join(packageRoot, filenames.suite));
let queryCount = 0;
for (const fixture of suite.fixtures) {
    const host = createFirHitSceneHost(adapter, fixture.encodedScene);
    try {
        for (const query of fixture.queries) {
            assert.deepEqual(
                host.query(query.x, query.y),
                query.expected,
                `${fixture.name}/${query.name} diverged`,
            );
            queryCount += 1;
        }
    } finally {
        host.dispose();
    }
}

console.log(
    JSON.stringify(
        {
            ok: true,
            packageRoot,
            firCommit: build.sources.fir.commit,
            illuminateCommit: build.sources.illuminate.commit,
            wasmBytes: wasmBytes.byteLength,
            wasmSha256: sha256(wasmBytes),
            fixtures: suite.fixtures.length,
            queryCount,
        },
        null,
        2,
    ),
);
