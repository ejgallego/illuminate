import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { loadHitSceneBenchmark } from "./lib/hit-scene-benchmark.mjs";
import { createVirHitSceneHost } from "../player_js/vir_hit_scene.js";
import {
    createVirRuntime,
    IR_PACKAGE_SET_FORMAT,
    IR_PACKAGE_SET_VERSION,
} from "../test_output/vir/sdk/js/vir-runtime-node.js";

const quick = process.argv.includes("--quick");
const milestones = quick ? [0, 10, 100, 1_000] : [0, 10, 100, 1_000, 5_000, 10_000];
const fixture = await loadHitSceneBenchmark("test_output/hit-scene-benchmark.json");
const wasmBytes = await readFile("test_output/vir/sdk/wasm/vir-upstream.wasm");
const descriptorUrl = new URL(
    "../test_output/vir/module-sets/Illuminate/Diagram/HitScene/Vir.irpkg-set.json",
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

const representatives = ["tag", "something", "nothing"].map((kind) => {
    const query = fixture.queries.find(({ expected }) => expected.kind === kind);
    assert.ok(query, `fixture has no ${kind} result`);
    return query;
});
const report = [];

for (const query of representatives) {
    const runtime = await createVirRuntime({ wasmBytes, irPackageSetBytes: packageSetBytes });
    const host = createVirHitSceneHost(runtime, fixture.encodedScene);
    const samples = [];
    let completed = 0;
    const started = performance.now();
    try {
        for (const milestone of milestones) {
            while (completed < milestone) {
                assert.ok(sameResult(host.query(query.x, query.y), query.expected));
                completed += 1;
            }
            samples.push({
                queries: completed,
                memoryBytes: runtime.exports.memory.buffer.byteLength,
            });
        }
    } finally {
        host.dispose();
    }
    samples.push({
        queries: "disposed",
        memoryBytes: runtime.exports.memory.buffer.byteLength,
    });
    report.push({
        kind: query.expected.kind,
        query: query.name,
        elapsedMs: performance.now() - started,
        samples,
    });
    runtime.dispose();
}

{
    const runtime = await createVirRuntime({ wasmBytes, irPackageSetBytes: packageSetBytes });
    const host = createVirHitSceneHost(runtime, fixture.encodedScene);
    const mixedMilestones = quick
        ? [0, 100, 301, 602, 1_000]
        : [0, 100, 301, 602, 1_204, 3_010, 10_000];
    const samples = [];
    const growthTransitions = [];
    let completed = 0;
    let previousMemory = runtime.exports.memory.buffer.byteLength;
    const started = performance.now();
    try {
        for (const milestone of mixedMilestones) {
            while (completed < milestone) {
                const query = fixture.queries[completed % fixture.queries.length];
                assert.ok(sameResult(host.query(query.x, query.y), query.expected));
                completed += 1;
                const currentMemory = runtime.exports.memory.buffer.byteLength;
                if (currentMemory !== previousMemory && growthTransitions.length < 100) {
                    growthTransitions.push({
                        queries: completed,
                        fixtureIndex: (completed - 1) % fixture.queries.length,
                        query: query.name,
                        beforeBytes: previousMemory,
                        afterBytes: currentMemory,
                    });
                }
                previousMemory = currentMemory;
            }
            samples.push({
                queries: completed,
                memoryBytes: runtime.exports.memory.buffer.byteLength,
            });
        }
    } finally {
        host.dispose();
    }
    samples.push({
        queries: "disposed",
        memoryBytes: runtime.exports.memory.buffer.byteLength,
    });
    report.push({
        kind: "mixed",
        query: "fixture-cycle",
        elapsedMs: performance.now() - started,
        samples,
        growthTransitions,
    });
    runtime.dispose();
}

{
    const runtime = await createVirRuntime({ wasmBytes, irPackageSetBytes: packageSetBytes });
    const host = createVirHitSceneHost(runtime, fixture.encodedScene, () => {});
    const timedMilestones = quick ? [0, 10, 100, 1_000] : [0, 10, 100, 1_000, 5_000];
    const samples = [];
    const growthTransitions = [];
    let completed = 0;
    let previousMemory = runtime.exports.memory.buffer.byteLength;
    const started = performance.now();
    try {
        for (const milestone of timedMilestones) {
            while (completed < milestone) {
                const query = fixture.queries[completed % fixture.queries.length];
                assert.ok(sameResult(host.query(query.x, query.y), query.expected));
                completed += 1;
                const currentMemory = runtime.exports.memory.buffer.byteLength;
                if (currentMemory !== previousMemory && growthTransitions.length < 100) {
                    growthTransitions.push({
                        queries: completed,
                        fixtureIndex: (completed - 1) % fixture.queries.length,
                        query: query.name,
                        beforeBytes: previousMemory,
                        afterBytes: currentMemory,
                    });
                }
                previousMemory = currentMemory;
            }
            samples.push({
                queries: completed,
                memoryBytes: runtime.exports.memory.buffer.byteLength,
            });
        }
    } finally {
        host.dispose();
    }
    samples.push({
        queries: "disposed",
        memoryBytes: runtime.exports.memory.buffer.byteLength,
    });
    report.push({
        kind: "mixed-timed",
        query: "fixture-cycle",
        elapsedMs: performance.now() - started,
        samples,
        growthTransitions,
    });
    runtime.dispose();
}

console.log(JSON.stringify({ ok: true, report }, null, 2));
