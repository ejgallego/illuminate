import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createFirHitSceneHost } from "../player_js/fir_hit_scene.js";

const packageArgument = process.env.ILLUMINATE_FIR_HIT_SCENE_DIR;
assert.ok(
    packageArgument,
    "set ILLUMINATE_FIR_HIT_SCENE_DIR to an immutable FIR hit-scene package",
);
const requestedRoot = path.resolve(packageArgument);
assert.equal(
    (await lstat(requestedRoot)).isSymbolicLink(),
    false,
    "ILLUMINATE_FIR_HIT_SCENE_DIR must name an immutable package, not a moving symlink",
);
assert.notEqual(
    path.basename(requestedRoot),
    "illuminate-hit-scene-current",
    "use the immutable package directory rather than illuminate-hit-scene-current",
);
const packageRoot = await realpath(requestedRoot);
const repositoryRoot = await realpath(new URL("..", import.meta.url));

const filenames = {
    adapter: "illuminate-hit-scene-browser-adapter.mjs",
    build: "BUILD.json",
    manifest: "illuminate-hit-scene.wasm.json",
    wasm: "illuminate-hit-scene.wasm",
};
const [adapterModule, build, manifest, wasmBytes] = await Promise.all([
    import(pathToFileURL(path.join(packageRoot, filenames.adapter)).href),
    readFile(path.join(packageRoot, filenames.build), "utf8").then(JSON.parse),
    readFile(path.join(packageRoot, filenames.manifest), "utf8").then(JSON.parse),
    readFile(path.join(packageRoot, filenames.wasm)),
]);

const { createIlluminateHitSceneAdapter, fetchIlluminateHitSceneAdapter } = adapterModule;
assert.equal(typeof createIlluminateHitSceneAdapter, "function");
assert.equal(typeof fetchIlluminateHitSceneAdapter, "function");
assert.equal(build.capabilities?.browserAdapter?.apiVersion, "fir.illuminate-hit-scene.browser/v1");
assert.deepEqual(build.capabilities?.browserAdapter?.operations, [
    "createHitScene",
    "hitTest",
    "hitTestDiagnostic",
    "disposeHitScene",
]);
assert.equal(build.capabilities?.inputLayout?.version, "lean-4.32-Illuminate.HitScene/v2");
assert.equal(
    build.capabilities?.ownership?.version,
    "fir.illuminate-hit-scene.persistent-checkpoint/v1",
);

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

assert.equal(sha256(wasmBytes), build.wasm.sha256);
assert.equal(wasmBytes.byteLength, build.wasm.byteLength);
const module = new WebAssembly.Module(wasmBytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
assert.equal(build.wasm.functionImportCount, 0);
assert.equal(build.wasm.memoryImportCount, 0);
assert.equal(build.wasm.memoryOwner, "module");
assert.deepEqual(
    WebAssembly.Module.exports(module).filter(({ kind }) => kind !== "function"),
    [{ name: "memory", kind: "memory" }],
);

assert.equal(build.entry?.sourceName, "Illuminate.HitScene.query");
assert.deepEqual(
    build.entry?.parameters?.map(({ lean, transport }) => ({ lean, transport })),
    [
        { lean: "HitScene", transport: undefined },
        { lean: "Float", transport: "uint64-bits" },
        { lean: "Float", transport: "uint64-bits" },
    ],
);
assert.equal(build.entry?.result?.lean, "HitSceneResult");
const expectedFunctionExports = [
    "Illuminate.HitScene.query",
    "Illuminate.HitScene.query._fir_bit_exact",
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
    "Wasm function exports differ from the entry and ownership surface",
);
assert.deepEqual(
    build.wasm.exports,
    WebAssembly.Module.exports(module).map(({ name, kind }) => ({ name, kind })),
    "BUILD.json does not describe the exact Wasm exports",
);

const expectedSources = new Map([
    [
        "src/Illuminate/Diagram/HitScene.lean",
        "1e51512bbe246654cfb8b1c16b40101c659e91d6bbe9bb0745b8b11257ff997e",
    ],
    [
        "src/Illuminate/Diagram/HitTest.lean",
        "c2e4e0cf31a291c5d04f13dfae3f82b78f9fb519f3ae1c48058a7db2149c137d",
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
assert.equal(build.sources?.illuminate?.dirty, false);
for (const [source, expectedHash] of expectedSources) {
    assert.equal(sha256(await readFile(path.join(repositoryRoot, source))), expectedHash);
    const packaged = build.sources?.illuminate?.relevantFiles?.find(
        ({ path: candidate }) => candidate === source,
    );
    assert.equal(packaged?.sha256, expectedHash, `${source} is absent from BUILD.json`);
}

const adapter = await createIlluminateHitSceneAdapter({ bytes: wasmBytes, manifest, build });
const taggedScene = JSON.stringify({
    tree: {
        kind: "tag",
        value: 7,
        child: {
            kind: "primitive",
            value: { kind: "bounds", left: -1, right: 1, bottom: -1, top: 1 },
        },
    },
    labels: [{ value: 7, label: "center" }],
});
const untaggedScene = JSON.stringify({
    tree: {
        kind: "primitive",
        value: { kind: "bounds", left: -2, right: 2, bottom: -2, top: 2 },
    },
    labels: [],
});

function adjacentFloat(value, direction) {
    const storage = new ArrayBuffer(8);
    const floats = new Float64Array(storage);
    const bits = new BigUint64Array(storage);
    floats[0] = value;
    bits[0] += direction > 0 ? 1n : -1n;
    return floats[0];
}

const observations = [];
const tagged = createFirHitSceneHost(adapter, taggedScene, (observation) => {
    observations.push(observation);
});
assert.deepEqual(tagged.query(0, 0), { kind: "tag", value: 7, label: "center" });
assert.deepEqual(tagged.query(2, 2), { kind: "nothing" });
assert.deepEqual(tagged.query(adjacentFloat(1, -1), -0), {
    kind: "tag",
    value: 7,
    label: "center",
});
assert.deepEqual(tagged.query(adjacentFloat(1, 1), +0), { kind: "nothing" });

const untagged = createFirHitSceneHost(adapter, untaggedScene);
assert.deepEqual(untagged.query(0, 0), { kind: "something" });
assert.deepEqual(tagged.query(0, 0), { kind: "tag", value: 7, label: "center" });

const createObservation = observations.find(({ kind }) => kind === "create");
assert.ok(createObservation, "adapter reported no creation observation");
for (const phase of ["parseProjectMs", "encodeMs", "instantiateMs", "totalMs", "overheadMs"]) {
    assert.equal(typeof createObservation.adapterTimings?.[phase], "number", `missing ${phase}`);
}
const queryObservations = observations.filter(({ kind }) => kind === "query");
assert.ok(queryObservations.length > 0);
for (const observation of queryObservations) {
    for (const phase of ["inputMs", "executeMs", "decodeMs", "rewindMs", "totalMs", "overheadMs"]) {
        assert.equal(typeof observation.adapterTimings?.[phase], "number", `missing ${phase}`);
    }
    assert.equal(observation.memory?.frontierBefore, observation.memory?.persistentCheckpoint);
    assert.equal(observation.memory?.postRewindFrontier, observation.memory?.persistentCheckpoint);
}

let pagesAfterWarmup;
for (let index = 0; index < 10_000; index += 1) {
    tagged.query((index % 5) - 2, ((index * 3) % 5) - 2);
    const memory = observations.at(-1).memory;
    assert.equal(memory?.frontierBefore, memory?.persistentCheckpoint);
    assert.equal(memory?.postRewindFrontier, memory?.persistentCheckpoint);
    if (index === 99) pagesAfterWarmup = memory?.pagesAfter;
    if (index >= 100) {
        assert.equal(memory?.pagesAfter, pagesAfterWarmup, `Wasm memory grew at query ${index}`);
    }
}

tagged.dispose();
tagged.dispose();
assert.throws(() => tagged.query(0, 0), /disposed/);
assert.deepEqual(untagged.query(0, 0), { kind: "something" });
untagged.dispose();

const directlyOwned = adapter.createHitScene(taggedScene);
assert.notEqual(directlyOwned.ok, false, directlyOwned.error);
assert.ok("scene" in directlyOwned);
adapter.disposeHitScene(directlyOwned.scene);
adapter.disposeHitScene(directlyOwned.scene);
assert.throws(() => adapter.hitTest(directlyOwned.scene, 0, 0), /disposed/);

console.log(
    JSON.stringify(
        {
            ok: true,
            packageRoot,
            firCommit: build.sources?.fir?.commit,
            illuminateCommit: build.sources?.illuminate?.commit,
            wasmBytes: wasmBytes.byteLength,
            wasmSha256: sha256(wasmBytes),
            queryCount: queryObservations.length + 10_000,
        },
        null,
        2,
    ),
);
