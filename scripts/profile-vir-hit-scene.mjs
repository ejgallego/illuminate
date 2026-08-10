import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { createVirHitSceneHost } from "../player_js/vir_hit_scene.js";
import { loadHitSceneBenchmarkSuite } from "./lib/hit-scene-benchmark.mjs";
import { createVirRuntime } from "../test_output/vir/sdk/js/vir-runtime-node.js";

const quick = process.argv.includes("--quick");
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const outputPath =
    outputArgument?.slice("--output=".length) || "test_output/vir-hit-scene-profile.json";
const warmupRounds = 1;
const measuredRounds = quick ? 2 : 8;

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function percentile(sorted, fraction) {
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function summarize(values) {
    assert.ok(values.length > 0, "cannot summarize an empty profile group");
    const sorted = [...values].sort((left, right) => left - right);
    return {
        count: values.length,
        meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
        medianMs: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.at(-1),
    };
}

function summarizeObservations(observations) {
    const phaseNames = [
        ...new Set(
            observations.flatMap(({ observation }) =>
                Object.keys(observation.adapterTimings ?? {}),
            ),
        ),
    ].sort();
    return {
        wall: summarize(observations.map(({ observation }) => observation.adapterWallMs)),
        phases: Object.fromEntries(
            phaseNames.map((phase) => [
                phase,
                summarize(observations.map(({ observation }) => observation.adapterTimings[phase])),
            ]),
        ),
    };
}

function groupObservations(observations, classify) {
    const groups = new Map();
    for (const entry of observations) {
        const name = classify(entry);
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(entry);
    }
    return Object.fromEntries(
        [...groups.entries()].map(([name, entries]) => [name, summarizeObservations(entries)]),
    );
}

function sameResult(actual, expected) {
    return (
        actual.kind === expected.kind &&
        (expected.kind !== "tag" ||
            (actual.value === expected.value && actual.label === expected.label))
    );
}

function profileFixture(runtime, fixture) {
    let measuring = false;
    let currentQuery = null;
    const observations = [];
    const host = createVirHitSceneHost(
        runtime,
        fixture.encodedScene,
        (observation) => {
            if (observation.kind === "query" && currentQuery !== null) {
                observations.push({ query: currentQuery, observation });
            }
        },
        () => measuring,
    );
    try {
        for (let round = 0; round < warmupRounds + measuredRounds; round += 1) {
            measuring = round >= warmupRounds;
            for (const query of fixture.queries) {
                currentQuery = query;
                const actual = host.query(query.x, query.y);
                if (!sameResult(actual, query.expected)) {
                    throw new Error(
                        `VIR profile mismatch in ${fixture.name}/${query.name}: ` +
                            `expected ${JSON.stringify(query.expected)}, got ${JSON.stringify(actual)}`,
                    );
                }
            }
        }
    } finally {
        currentQuery = null;
        host.dispose();
    }
    assert.equal(observations.length, fixture.queries.length * measuredRounds);
    return {
        name: fixture.name,
        geometryClass: fixture.geometryClass,
        encodedBytes: fixture.encodedScene.length,
        queryCount: fixture.queries.length,
        samples: observations.length,
        aggregate: summarizeObservations(observations),
        byQueryClass: groupObservations(observations, ({ query }) => query.queryClass),
        byResultClass: groupObservations(observations, ({ query }) => query.resultClass),
        raw: observations.map(({ query, observation }) => ({
            query: query.name,
            queryClass: query.queryClass,
            resultClass: query.resultClass,
            wallMs: observation.adapterWallMs,
            timings: observation.adapterTimings,
        })),
    };
}

const suite = await loadHitSceneBenchmarkSuite("test_output/hit-scene-benchmark-suite.json");
const wasmBytes = await readFile("test_output/vir/sdk/wasm/vir-upstream.wasm");
const descriptorPath = path.resolve(
    "test_output/vir/module-sets/Illuminate/Diagram/HitScene/Vir.irpkg-set.json",
);
const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
const packageSetBytes = await Promise.all(
    descriptor.packages.map((member) =>
        readFile(path.resolve(path.dirname(descriptorPath), member.path)),
    ),
);
const runtime = await createVirRuntime({ wasmBytes, irPackageSetBytes: packageSetBytes });

try {
    const workloads = suite.fixtures.map((fixture) => profileFixture(runtime, fixture));
    const report = {
        schemaVersion: "illuminate.vir-hit-scene-profile/v1",
        generatedAt: new Date().toISOString(),
        environment: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
        },
        runtime: {
            wasmBytes: wasmBytes.byteLength,
            wasmSha256: sha256(wasmBytes),
            packageMembers: descriptor.packages.length,
        },
        protocol: {
            warmupRounds,
            measuredRounds,
            productionPathMeasured: false,
            callTimedDiagnostics: true,
        },
        workloads,
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${path.resolve(outputPath)}`);
    for (const workload of workloads) {
        const phases = workload.aggregate.phases;
        console.log(
            `${workload.name}: wall=${workload.aggregate.wall.medianMs.toFixed(3)} ms ` +
                `execute=${phases.executeMs.medianMs.toFixed(3)} ms ` +
                `marshal=${phases.marshalMs.medianMs.toFixed(3)} ms ` +
                `decode=${phases.decodeMs.medianMs.toFixed(3)} ms`,
        );
    }
} finally {
    runtime.dispose();
}
