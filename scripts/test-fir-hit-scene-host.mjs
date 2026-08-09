import assert from "node:assert/strict";

import {
    createFirHitSceneController,
    createFirHitSceneHost,
    queryPreparedHitSceneRpc,
} from "../player_js/fir_hit_scene.js";
import { createHitSceneTimingStore } from "../player_js/hit_scene_comparison.js";

function adjacentFloat(value, direction) {
    const storage = new ArrayBuffer(8);
    const floats = new Float64Array(storage);
    const bits = new BigUint64Array(storage);
    floats[0] = value;
    bits[0] += direction > 0 ? 1n : -1n;
    return floats[0];
}

const encodedScene = JSON.stringify({
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

let nextScene = 1;
const liveScenes = new Set();
const createdScenes = [];
const queries = [];
const disposedScenes = [];
const adapter = {
    createHitScene(source) {
        assert.equal(source, encodedScene);
        const scene = Object.freeze({ id: nextScene++ });
        liveScenes.add(scene);
        createdScenes.push(scene);
        return {
            scene,
            timings: {
                parseMs: 0.02,
                encodeMs: 0.03,
                instantiateMs: 0.04,
                totalMs: 0.1,
            },
            memory: { persistentCheckpoint: 128 },
        };
    },
    hitTest(scene, x, y) {
        assert.ok(liveScenes.has(scene), "query used a scene that is not live");
        queries.push({ scene, x, y });
        const result =
            x === 0 && y === 0
                ? { kind: "tag", value: 7, label: "center" }
                : x >= -1 && x <= 1 && y >= -1 && y <= 1
                  ? { kind: "something" }
                  : { kind: "nothing" };
        return {
            result,
            timings: {
                inputMs: 0.001,
                executeMs: 0.004,
                decodeMs: 0.002,
                rewindMs: 0.001,
                residualMs: 0.001,
                totalMs: 0.009,
            },
            memory: { frontierBefore: 128, postRewindFrontier: 128 },
        };
    },
    disposeHitScene(scene) {
        assert.ok(liveScenes.delete(scene), "adapter received duplicate disposal");
        disposedScenes.push(scene);
    },
};

const observations = [];
const first = createFirHitSceneHost(adapter, encodedScene, (observation) => {
    observations.push(observation);
});
assert.deepEqual(first.query(0, 0), { kind: "tag", value: 7, label: "center" });
assert.deepEqual(first.query(0.5, -0.5), { kind: "something" });
assert.deepEqual(first.query(2, 2), { kind: "nothing" });

const below = adjacentFloat(1, -1);
const above = adjacentFloat(1, 1);
first.query(below, -0);
first.query(above, +0);
assert.equal(queries.at(-2).x, below);
assert.equal(queries.at(-1).x, above);
assert.equal(Object.is(queries.at(-2).y, -0), true, "negative zero was not preserved");
assert.equal(Object.is(queries.at(-1).y, +0), true, "positive zero was not preserved");

assert.equal(observations[0].kind, "create");
assert.equal(observations[0].backend, "fir");
assert.equal(observations[1].kind, "query");
assert.deepEqual(observations[1].adapterTimings, {
    inputMs: 0.001,
    executeMs: 0.004,
    decodeMs: 0.002,
    rewindMs: 0.001,
    residualMs: 0.001,
    totalMs: 0.009,
});

const second = createFirHitSceneHost(adapter, encodedScene);
assert.notEqual(createdScenes[0], createdScenes[1], "two hosts shared one scene handle");
assert.deepEqual(second.query(0, 0), { kind: "tag", value: 7, label: "center" });
first.dispose();
first.dispose();
assert.deepEqual(disposedScenes, [createdScenes[0]]);
assert.throws(() => first.query(0, 0), /disposed/);
assert.deepEqual(second.query(2, 2), { kind: "nothing" });
second.dispose();
assert.deepEqual(disposedScenes, createdScenes);

const controller = createFirHitSceneController(adapter);
assert.throws(() => controller.query(0, 0), /has no scene/);
controller.replace(encodedScene);
const controllerFirst = createdScenes.at(-1);
controller.replace(encodedScene);
const controllerSecond = createdScenes.at(-1);
assert.notEqual(controllerFirst, controllerSecond);
assert.ok(disposedScenes.includes(controllerFirst), "replacement did not release the old scene");
assert.deepEqual(controller.query(0, 0), { kind: "tag", value: 7, label: "center" });
controller.dispose();
controller.dispose();
assert.ok(disposedScenes.includes(controllerSecond));
assert.throws(() => controller.replace(encodedScene), /disposed/);

const atomicController = createFirHitSceneController(adapter);
atomicController.replace(encodedScene);
const atomicScene = createdScenes.at(-1);
assert.throws(() => atomicController.replace("invalid"));
assert.deepEqual(atomicController.query(0, 0), { kind: "tag", value: 7, label: "center" });
assert.ok(liveScenes.has(atomicScene), "failed replacement discarded the previous live scene");
atomicController.dispose();

assert.throws(() => createFirHitSceneHost(adapter, ""), /requires an encoded scene/);
const invalidHost = createFirHitSceneHost(adapter, encodedScene);
assert.throws(() => invalidHost.query(Number.NaN, 0), /finite numbers/);
invalidHost.dispose();

const rpcObservations = [];
const rpcResult = await queryPreparedHitSceneRpc(
    async (request) => {
        assert.deepEqual(request, { id: 41, x: below, y: -0 });
        assert.equal(Object.is(request.y, -0), true);
        return { kind: "tag", value: 9, label: "rpc" };
    },
    41,
    below,
    -0,
    (observation) => rpcObservations.push(observation),
);
assert.deepEqual(rpcResult, { kind: "tag", value: 9, label: "rpc" });
assert.equal(rpcObservations.length, 1);
assert.equal(rpcObservations[0].backend, "rpc");
assert.equal(rpcObservations[0].adapterTimings, null);

const store = createHitSceneTimingStore();
for (const observation of observations) store.record(observation);
for (const observation of rpcObservations) store.record(observation);
const snapshot = store.snapshot();
assert.equal(snapshot.fir.count, 5);
assert.equal(snapshot.rpc.count, 1);
assert.equal(snapshot.fir.phases.executeMs, 0.004);
assert.equal(snapshot.fir.phases.decodeMs, 0.002);
assert.ok(snapshot.fir.maxMs >= 0);
store.reset();
assert.equal(store.snapshot().fir.count, 0);
assert.equal(store.snapshot().rpc.count, 0);

console.log("FIR hit-scene host and timing contracts passed");
