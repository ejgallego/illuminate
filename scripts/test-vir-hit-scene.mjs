import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { loadHitSceneBenchmark, runPairedHitSceneBenchmark } from "./lib/hit-scene-benchmark.mjs";
import { createVirHitSceneHost } from "../player_js/vir_hit_scene.js";
import {
    createVirRuntime,
    IR_PACKAGE_SET_FORMAT,
    IR_PACKAGE_SET_VERSION,
} from "../test_output/vir/sdk/js/vir-runtime-node.js";

const quick = process.argv.includes("--quick");
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
const runtime = await createVirRuntime({ wasmBytes, irPackageSetBytes: packageSetBytes });

function sameResult(actual, expected) {
    return (
        actual.kind === expected.kind &&
        (expected.kind !== "tag" ||
            (actual.value === expected.value && actual.label === expected.label))
    );
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

try {
    const benchmark = await runPairedHitSceneBenchmark(
        fixture,
        {
            vir: {
                create({ encodedScene }) {
                    return createVirHitSceneHost(runtime, encodedScene);
                },
                query(host, x, y) {
                    return host.query(x, y);
                },
                dispose(host) {
                    host.dispose();
                },
            },
        },
        { warmupRounds: quick ? 1 : 2, measuredRounds: quick ? 2 : 10 },
    );
    assert.equal(benchmark.vir.query.count, fixture.queries.length * (quick ? 2 : 10));

    const observations = [];
    const profiled = createVirHitSceneHost(runtime, fixture.encodedScene, (observation) => {
        observations.push(observation);
    });
    const profileRounds = quick ? 1 : 5;
    for (let round = 0; round < profileRounds; round += 1) {
        for (const query of fixture.queries) {
            assert.ok(sameResult(profiled.query(query.x, query.y), query.expected));
        }
    }
    profiled.dispose();

    const left = createVirHitSceneHost(runtime, fixture.encodedScene);
    const right = createVirHitSceneHost(runtime, fixture.encodedScene);
    const first = fixture.queries[0];
    assert.ok(sameResult(left.query(first.x, first.y), first.expected));
    assert.ok(sameResult(right.query(first.x, first.y), first.expected));
    left.dispose();
    assert.throws(() => left.query(first.x, first.y), /disposed/);
    assert.ok(sameResult(right.query(first.x, first.y), first.expected));
    right.dispose();

    const longRunning = createVirHitSceneHost(runtime, fixture.encodedScene);
    for (let index = 0; index < 100; index += 1) {
        const query = fixture.queries[index % fixture.queries.length];
        assert.ok(sameResult(longRunning.query(query.x, query.y), query.expected));
    }
    const memoryAfterWarmup = runtime.exports.memory.buffer.byteLength;
    const queryCount = quick ? 1_000 : 10_000;
    for (let index = 0; index < queryCount; index += 1) {
        const query = fixture.queries[index % fixture.queries.length];
        assert.ok(sameResult(longRunning.query(query.x, query.y), query.expected));
    }
    assert.equal(
        runtime.exports.memory.buffer.byteLength,
        memoryAfterWarmup,
        "VIR Wasm memory grew after hit-scene warmup",
    );
    longRunning.dispose();

    const queryObservations = observations.filter(({ kind }) => kind === "query");
    const timingFields = ["marshalMs", "executeMs", "decodeMs", "hostMs", "totalMs"];
    const phaseMedians = Object.fromEntries(
        timingFields.map((field) => [
            field,
            median(queryObservations.map(({ adapterTimings }) => adapterTimings[field])),
        ]),
    );
    console.log(
        JSON.stringify(
            {
                ok: true,
                fixtureQueries: fixture.queries.length,
                measuredQueries: benchmark.vir.query.count,
                profiledQueries: queryObservations.length,
                stabilityQueries: queryCount,
                creationMs: benchmark.vir.creationMs,
                query: benchmark.vir.query,
                runtimePhases: phaseMedians,
                wasmMemoryBytes: memoryAfterWarmup,
            },
            null,
            2,
        ),
    );
} finally {
    runtime.dispose();
}
