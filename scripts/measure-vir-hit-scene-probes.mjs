import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normalizeVirHitSceneResult, projectHitSceneForVir } from "../player_js/vir_hit_scene.js";
import { loadHitSceneBenchmark } from "./lib/hit-scene-benchmark.mjs";
import {
    createVirRuntime,
    IR_PACKAGE_SET_FORMAT,
    IR_PACKAGE_SET_VERSION,
} from "../test_output/vir/sdk/js/vir-runtime-node.js";

const prefix = "Illuminate.HitScene.VirMemoryProbe";
const quick = process.argv.includes("--quick");
const long = process.argv.includes("--long");
const onlyArgument = process.argv.find((argument) => argument.startsWith("--only="));
const only = new Set(onlyArgument?.slice("--only=".length).split(",") ?? []);
const milestones = quick
    ? [0, 10, 100, 1_000]
    : long
      ? [0, 10, 100, 1_000, 5_000, 10_000, 20_000, 50_000]
      : [0, 10, 100, 1_000, 5_000, 10_000];
const fixture = await loadHitSceneBenchmark("test_output/hit-scene-benchmark.json");
const projected = projectHitSceneForVir(fixture.encodedScene);
const tagQuery = fixture.queries.find(({ expected }) => expected.kind === "tag");
const missQuery = fixture.queries.find(({ expected }) => expected.kind === "nothing");
assert.ok(tagQuery);
assert.ok(missQuery);

function findFirstPath(tree) {
    switch (tree.kind) {
        case "empty":
            return null;
        case "primitive":
            return tree.value.kind === "path" ? tree.value.fields.data : null;
        case "tag":
        case "transform":
            return findFirstPath(tree.fields.child);
        case "compose":
            return findFirstPath(tree.fields.front) ?? findFirstPath(tree.fields.back);
        case "clip":
            return tree.fields.boundary ?? findFirstPath(tree.fields.child);
        default:
            throw new Error(`unknown projected hit-tree constructor ${tree.kind}`);
    }
}

const firstPath = findFirstPath(projected.tree);
assert.ok(firstPath);
const oneLinePath = {
    commands: [
        { kind: "moveTo", value: { x: 1, y: -1 } },
        { kind: "lineTo", value: { x: 1, y: 1 } },
    ],
};

const wasmBytes = await readFile("test_output/vir/sdk/wasm/vir-upstream.wasm");
const descriptorUrl = new URL(
    "../.lake/build/vir/module-sets/Illuminate/Diagram/HitScene/VirMemoryProbe.irpkg-set.json",
    import.meta.url,
);
const descriptor = JSON.parse(await readFile(descriptorUrl, "utf8"));
assert.equal(descriptor.format, IR_PACKAGE_SET_FORMAT);
assert.equal(descriptor.version, IR_PACKAGE_SET_VERSION);
const packageSetBytes = await Promise.all(
    descriptor.packages.map((member) => readFile(new URL(member.path, descriptorUrl))),
);

function sameResult(actual, expected) {
    return (
        actual.kind === expected.kind &&
        (expected.kind !== "tag" ||
            (actual.value === expected.value && actual.label === expected.label))
    );
}

async function measureScenario(scenario) {
    const runtime = await createVirRuntime({ wasmBytes, irPackageSetBytes: packageSetBytes });
    const handle =
        scenario.handle === "scene"
            ? runtime.call(`${prefix}.mount`, projected)
            : scenario.handle === "path"
              ? runtime.call(`${prefix}.mountPath`, scenario.path ?? firstPath)
              : null;
    const samples = [];
    let completed = 0;
    const started = performance.now();
    try {
        for (const milestone of milestones) {
            while (completed < milestone) {
                scenario.run(runtime, handle);
                completed += 1;
            }
            samples.push({
                queries: completed,
                memoryBytes: runtime.exports.memory.buffer.byteLength,
            });
        }
    } finally {
        if (scenario.handle === "scene") runtime.call(`${prefix}.dispose`, handle);
        if (scenario.handle === "path") runtime.call(`${prefix}.disposePath`, handle);
    }
    const steadyStart = samples.find(({ queries }) => queries === 1_000);
    const final = samples.at(-1);
    assert.ok(steadyStart);
    assert.ok(final);
    const steadyQueries = final.queries - steadyStart.queries;
    const steadyBytesPerCall =
        steadyQueries === 0 ? 0 : (final.memoryBytes - steadyStart.memoryBytes) / steadyQueries;
    const result = {
        name: scenario.name,
        elapsedMs: performance.now() - started,
        samples,
        steadyBytesPerCall,
    };
    runtime.dispose();
    return result;
}

const scenarios = [
    {
        name: "fixed-bounds-no-handle",
        handle: "none",
        run(runtime) {
            const result = normalizeVirHitSceneResult(
                runtime.call(`${prefix}.fixedBounds`, 1.25, -2.5),
            );
            assert.deepEqual(result, { kind: "something" });
        },
    },
    {
        name: "map-float-array",
        handle: "none",
        run(runtime) {
            assert.equal(Number(runtime.call(`${prefix}.mapFloatArray`, 1.25, -2.5)), 1);
        },
    },
    {
        name: "map-stroke-hit-array",
        handle: "none",
        run(runtime) {
            assert.equal(Number(runtime.call(`${prefix}.mapStrokeHitArray`, 1.25, -2.5)), 1);
        },
    },
    {
        name: "borrow-only",
        handle: "scene",
        run(runtime, handle) {
            const result = normalizeVirHitSceneResult(runtime.call(`${prefix}.borrowOnly`, handle));
            assert.deepEqual(result, { kind: "nothing" });
        },
    },
    {
        name: "borrow-and-read-label-count",
        handle: "scene",
        run(runtime, handle) {
            assert.equal(
                Number(runtime.call(`${prefix}.labelCount`, handle)),
                projected.labels.length,
            );
        },
    },
    {
        name: "structural-tree-node-count",
        handle: "scene",
        run(runtime, handle) {
            assert.ok(Number(runtime.call(`${prefix}.nodeCount`, handle)) > 0);
        },
    },
    {
        name: "label-lookup-only",
        handle: "scene",
        run(runtime, handle) {
            const first = projected.labels[0];
            const result = normalizeVirHitSceneResult(
                runtime.call(`${prefix}.labelOnly`, handle, first.fst),
            );
            assert.deepEqual(result, { kind: "tag", value: first.fst, label: first.snd });
        },
    },
    {
        name: "hit-traversal-tag",
        handle: "scene",
        run(runtime, handle) {
            const result = normalizeVirHitSceneResult(
                runtime.call(`${prefix}.hitOnly`, handle, tagQuery.x, tagQuery.y),
            );
            assert.ok(
                sameResult(result, {
                    ...tagQuery.expected,
                    label: tagQuery.expected.kind === "tag" ? "" : undefined,
                }),
            );
        },
    },
    {
        name: "full-query-tag",
        handle: "scene",
        run(runtime, handle) {
            const result = normalizeVirHitSceneResult(
                runtime.call(`${prefix}.fullQuery`, handle, tagQuery.x, tagQuery.y),
            );
            assert.ok(sameResult(result, tagQuery.expected));
        },
    },
    {
        name: "hit-traversal-miss",
        handle: "scene",
        run(runtime, handle) {
            const result = normalizeVirHitSceneResult(
                runtime.call(`${prefix}.hitOnly`, handle, missQuery.x, missQuery.y),
            );
            assert.deepEqual(result, { kind: "nothing" });
        },
    },
    {
        name: "full-query-miss",
        handle: "scene",
        run(runtime, handle) {
            const result = normalizeVirHitSceneResult(
                runtime.call(`${prefix}.fullQuery`, handle, missQuery.x, missQuery.y),
            );
            assert.deepEqual(result, { kind: "nothing" });
        },
    },
    {
        name: "retained-path-fill",
        handle: "path",
        run(runtime, handle) {
            normalizeVirHitSceneResult(runtime.call(`${prefix}.pathFill`, handle, 0.25, -0.75));
        },
    },
    {
        name: "retained-path-fill-east",
        handle: "path",
        run(runtime, handle) {
            assert.ok(Number(runtime.call(`${prefix}.pathFillEast`, handle, 0.25, -0.75)) >= 0);
        },
    },
    {
        name: "retained-path-fill-east-results",
        handle: "path",
        run(runtime, handle) {
            assert.ok(
                Array.isArray(runtime.call(`${prefix}.pathFillEastResults`, handle, 0.25, -0.75)),
            );
        },
    },
    {
        name: "retained-path-stroke",
        handle: "path",
        run(runtime, handle) {
            normalizeVirHitSceneResult(runtime.call(`${prefix}.pathStroke`, handle, 0.25, -0.75));
        },
    },
    {
        name: "retained-path-stroke-east",
        handle: "path",
        run(runtime, handle) {
            assert.ok(Number(runtime.call(`${prefix}.pathStrokeEast`, handle, 0.25, -0.75)) >= 0);
        },
    },
    {
        name: "retained-path-stroke-east-results",
        handle: "path",
        run(runtime, handle) {
            assert.ok(
                Array.isArray(runtime.call(`${prefix}.pathStrokeEastResults`, handle, 0.25, -0.75)),
            );
        },
    },
    {
        name: "one-line-fill-east-results",
        handle: "path",
        path: oneLinePath,
        run(runtime, handle) {
            const result = runtime.call(`${prefix}.pathFillEastResults`, handle, 0, 0);
            assert.equal(result.length, 1);
        },
    },
    {
        name: "one-line-stroke-east-results",
        handle: "path",
        path: oneLinePath,
        run(runtime, handle) {
            const result = runtime.call(`${prefix}.pathStrokeEastResults`, handle, 0, 0);
            assert.equal(result.length, 1);
        },
    },
];

const report = [];
for (const scenario of scenarios) {
    if (only.size === 0 || only.has(scenario.name)) {
        report.push(await measureScenario(scenario));
    }
}
console.log(JSON.stringify({ ok: true, report }, null, 2));
