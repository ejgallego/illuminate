import assert from "node:assert/strict";

import {
    createVirHitSceneController,
    createVirHitSceneHost,
    normalizeVirHitSceneResult,
    projectHitSceneForVir,
} from "../player_js/vir_hit_scene.js";

const encodedScene = JSON.stringify({
    tree: {
        kind: "compose",
        back: {
            kind: "transform",
            inverse: { a: 1, b: 0, tx: -2, c: 0, d: 1, ty: 3 },
            child: {
                kind: "primitive",
                value: { kind: "bounds", left: -1, right: 1, bottom: -2, top: 2 },
            },
        },
        front: {
            kind: "tag",
            value: 7,
            child: {
                kind: "clip",
                boundary: [
                    { kind: "moveTo", point: { x: -1, y: -1 } },
                    { kind: "lineTo", point: { x: 1, y: -1 } },
                    { kind: "lineTo", point: { x: 0, y: 1 } },
                    { kind: "closePath" },
                ],
                child: {
                    kind: "primitive",
                    value: {
                        kind: "path",
                        data: [
                            { kind: "moveTo", point: { x: 0, y: 0 } },
                            { kind: "lineTo", point: { x: 2, y: 0 } },
                            {
                                kind: "curveTo",
                                control1: { x: 2, y: 1 },
                                control2: { x: 1, y: 2 },
                                endpoint: { x: 0, y: 2 },
                            },
                            {
                                kind: "arcTo",
                                rx: 1,
                                ry: 1,
                                rotation: 0,
                                largeArc: false,
                                sweep: true,
                                endpoint: { x: 0, y: 0 },
                            },
                            { kind: "closePath" },
                        ],
                        hasFill: true,
                        strokeWidth: 1,
                    },
                },
            },
        },
    },
    labels: [{ value: 7, label: "shape" }],
});

const projected = projectHitSceneForVir(encodedScene);
assert.equal(projected.tree.kind, "compose");
assert.equal(projected.tree.fields.back.kind, "transform");
assert.equal(projected.tree.fields.back.fields.inverse.tx, -2);
assert.equal(projected.tree.fields.back.fields.child.value.kind, "bounds");
assert.equal(projected.tree.fields.front.kind, "tag");
assert.equal(projected.tree.fields.front.fields.child.kind, "clip");
assert.equal(projected.tree.fields.front.fields.child.fields.boundary.commands.length, 4);
assert.equal(
    projected.tree.fields.front.fields.child.fields.child.value.fields.data.commands.length,
    5,
);
assert.deepEqual(
    projected.tree.fields.front.fields.child.fields.child.value.fields.data.commands[2].fields.arg1,
    { x: 2, y: 1 },
);
assert.equal(
    projected.tree.fields.front.fields.child.fields.child.value.fields.data.commands[3].fields
        .xRotation,
    0,
);
assert.deepEqual(projected.labels, [{ fst: 7, snd: "shape" }]);
assert.deepEqual(normalizeVirHitSceneResult({ kind: "nothing" }), { kind: "nothing" });
assert.deepEqual(normalizeVirHitSceneResult({ kind: "something" }), { kind: "something" });
assert.deepEqual(
    normalizeVirHitSceneResult({ kind: "tag", fields: { value: "7", label: "shape" } }),
    { kind: "tag", value: 7, label: "shape" },
);

const calls = [];
const createdHandles = [];
let nextHandle = 11;
function createHandle() {
    const handle = Object.freeze({ resource: nextHandle++ });
    createdHandles.push(handle);
    return handle;
}
const runtime = {
    call(name, ...args) {
        calls.push({ timed: false, name, args });
        if (name.endsWith(".mount")) return createHandle();
        if (name.endsWith(".query")) {
            return args[1] === 0
                ? { kind: "tag", fields: { value: 7, label: "shape" } }
                : { kind: "nothing" };
        }
        if (name.endsWith(".dispose")) return undefined;
        throw new Error(`unexpected VIR call ${name}`);
    },
    callTimed(name, ...args) {
        calls.push({ timed: true, name, args });
        const value = name.endsWith(".mount")
            ? createHandle()
            : args[1] === 0
              ? { kind: "tag", fields: { value: 7, label: "shape" } }
              : { kind: "nothing" };
        return {
            value,
            timings: { marshalMs: 0.1, executeMs: 0.2, decodeMs: 0.1, hostMs: 0, totalMs: 0.5 },
        };
    },
};

const observations = [];
const host = createVirHitSceneHost(runtime, encodedScene, (observation) => {
    observations.push(observation);
});
assert.deepEqual(host.query(0, -0), { kind: "tag", value: 7, label: "shape" });
assert.equal(Object.is(calls.at(-1).args[2], -0), true);
assert.deepEqual(host.query(2, 2), { kind: "nothing" });
assert.deepEqual(
    observations.map(({ backend, kind }) => ({ backend, kind })),
    [
        { backend: "vir", kind: "create" },
        { backend: "vir", kind: "query" },
        { backend: "vir", kind: "query" },
    ],
);
assert.equal(observations[1].adapterTimings.executeMs, 0.2);
host.dispose();
host.dispose();
assert.equal(calls.filter(({ name }) => name.endsWith(".dispose")).length, 1);
assert.throws(() => host.query(0, 0), /disposed/);

const controller = createVirHitSceneController(runtime);
assert.throws(() => controller.query(0, 0), /has no scene/);
controller.replace(encodedScene);
const firstControllerHandle = createdHandles.at(-1);
controller.replace(encodedScene);
const secondControllerHandle = createdHandles.at(-1);
assert.notEqual(firstControllerHandle, secondControllerHandle);
assert.ok(
    calls.some(({ name, args }) => name.endsWith(".dispose") && args[0] === firstControllerHandle),
);
assert.throws(() => controller.replace("invalid JSON"));
assert.deepEqual(controller.query(0, 0), { kind: "tag", value: 7, label: "shape" });
controller.dispose();
controller.dispose();
assert.ok(
    calls.some(({ name, args }) => name.endsWith(".dispose") && args[0] === secondControllerHandle),
);
assert.throws(() => controller.replace(encodedScene), /disposed/);

console.log("VIR hit-scene projection and host contracts passed");
