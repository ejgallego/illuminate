import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import { createVirHitSceneHost, createVirSpatialHitSceneHost } from "../player_js/vir_hit_scene.js";
import {
    loadHitSceneBenchmarkSuite,
    runPairedHitSceneBenchmark,
} from "./lib/hit-scene-benchmark.mjs";
import { createVirRuntime } from "../test_output/vir/sdk/js/vir-runtime-node.js";

const quick = process.argv.includes("--quick");
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const outputPath =
    outputArgument?.slice("--output=".length) ||
    "test_output/vir-spatial-hit-scene-performance.json";
const warmupRounds = quick ? 2 : 5;
const measuredRounds = quick ? 5 : 20;
const profileRounds = quick ? 2 : 5;

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function percentile(values, fraction) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function summarize(values) {
    return {
        count: values.length,
        meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
        medianMs: percentile(values, 0.5),
        p95Ms: percentile(values, 0.95),
        maxMs: Math.max(...values),
    };
}

function summarizeObservations(observations) {
    const phaseNames = [
        ...new Set(observations.flatMap(({ adapterTimings }) => Object.keys(adapterTimings ?? {}))),
    ].sort();
    return Object.fromEntries(
        phaseNames.map((name) => [
            name,
            summarize(
                observations
                    .map(({ adapterTimings }) => adapterTimings?.[name])
                    .filter((value) => Number.isFinite(value)),
            ),
        ]),
    );
}

function sameResult(actual, expected) {
    return (
        actual.kind === expected.kind &&
        (expected.kind !== "tag" ||
            (actual.value === expected.value && actual.label === expected.label))
    );
}

async function loadRuntime(descriptorPath) {
    const [wasmBytes, descriptorBytes] = await Promise.all([
        readFile("test_output/vir/sdk/wasm/vir-upstream.wasm"),
        readFile(descriptorPath),
    ]);
    const descriptorUrl = pathToFileURL(descriptorPath);
    const descriptor = JSON.parse(descriptorBytes.toString("utf8"));
    const packageSetBytes = await Promise.all(
        descriptor.packages.map((member) => readFile(new URL(member.path, descriptorUrl))),
    );
    return {
        runtime: await createVirRuntime({ wasmBytes, irPackageSetBytes: packageSetBytes }),
        metadata: {
            descriptorPath,
            descriptorSha256: sha256(descriptorBytes),
            packageMembers: descriptor.packages.length,
            wasmBytes: wasmBytes.byteLength,
            wasmSha256: sha256(wasmBytes),
        },
    };
}

const fixturePath = "test_output/hit-scene-benchmark-suite.json";
const referencePath = "test_output/vir/module-sets/Illuminate/Diagram/HitScene/Vir.irpkg-set.json";
const spatialPath =
    "test_output/vir/module-sets/Illuminate/Diagram/HitScene/SpatialVir/SpatialVir.irpkg-set.json";
const suite = await loadHitSceneBenchmarkSuite(fixturePath);
const reference = await loadRuntime(referencePath);
const spatial = await loadRuntime(spatialPath);

const referenceBackend = {
    create({ encodedScene }) {
        return createVirHitSceneHost(reference.runtime, encodedScene);
    },
    query(host, x, y) {
        return host.query(x, y);
    },
    dispose(host) {
        host.dispose();
    },
};

const spatialBackend = {
    create({ encodedScene }) {
        return createVirSpatialHitSceneHost(spatial.runtime, encodedScene);
    },
    query(host, x, y) {
        return host.query(x, y);
    },
    dispose(host) {
        host.dispose();
    },
};

function profileFixture(fixture) {
    const candidates = [
        {
            name: "reference",
            observations: [],
            host: createVirHitSceneHost(reference.runtime, fixture.encodedScene, (observation) => {
                if (observation.kind === "query") candidates[0].observations.push(observation);
            }),
        },
        {
            name: "spatial",
            observations: [],
            host: createVirSpatialHitSceneHost(
                spatial.runtime,
                fixture.encodedScene,
                (observation) => {
                    if (observation.kind === "query") candidates[1].observations.push(observation);
                },
            ),
        },
    ];
    try {
        for (let round = 0; round < 1 + profileRounds; round += 1) {
            const order = candidates.map(
                (_, index) => candidates[(index + round) % candidates.length],
            );
            for (const query of fixture.queries) {
                for (const candidate of order) {
                    const actual = candidate.host.query(query.x, query.y);
                    if (!sameResult(actual, query.expected)) {
                        throw new Error(`${candidate.name} diagnostic mismatch at ${query.name}`);
                    }
                }
            }
            if (round === 0) {
                for (const candidate of candidates) candidate.observations.length = 0;
            }
        }
        return Object.fromEntries(
            candidates.map(({ name, observations }) => [name, summarizeObservations(observations)]),
        );
    } finally {
        for (const candidate of candidates.toReversed()) candidate.host.dispose();
    }
}

try {
    const workloads = [];
    for (const fixture of suite.fixtures) {
        const timing = await runPairedHitSceneBenchmark(
            fixture,
            { reference: referenceBackend, spatial: spatialBackend },
            { warmupRounds, measuredRounds, now: () => performance.now() },
        );
        const diagnostics = profileFixture(fixture);
        workloads.push({
            name: fixture.name,
            geometryClass: fixture.geometryClass,
            queryCount: fixture.queries.length,
            timing,
            diagnostics,
            ratios: {
                spatialOverReferenceMedian:
                    timing.spatial.query.medianMs / timing.reference.query.medianMs,
                spatialOverReferenceMean:
                    timing.spatial.query.meanMs / timing.reference.query.meanMs,
                spatialOverReferenceP95: timing.spatial.query.p95Ms / timing.reference.query.p95Ms,
                spatialOverReferenceCreation:
                    timing.spatial.creationMs / timing.reference.creationMs,
                spatialOverReferenceExecuteMedian:
                    diagnostics.spatial.executeMs.medianMs /
                    diagnostics.reference.executeMs.medianMs,
            },
        });
    }
    const report = {
        schemaVersion: "illuminate.vir-spatial-hit-scene-performance/v1",
        generatedAt: new Date().toISOString(),
        protocol: {
            fixturePath,
            warmupRounds,
            measuredRounds,
            profileRounds,
            balancedQueryBackendOrder: true,
            identicalTypedSceneTransport: true,
            identicalScalarQueryBoundary: true,
            identicalResultDecoder: true,
            semanticOracleCheckedBeforeTiming: true,
            creationOrderBalanced: false,
            creationRatiosExploratoryOnly: true,
        },
        backends: {
            reference: reference.metadata,
            spatial: spatial.metadata,
        },
        workloads,
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(
        JSON.stringify(
            {
                ok: true,
                outputPath,
                workloads: workloads.map(({ name, queryCount, timing, ratios }) => ({
                    name,
                    queryCount,
                    referenceMedianMs: timing.reference.query.medianMs,
                    spatialMedianMs: timing.spatial.query.medianMs,
                    speedupMedian: 1 / ratios.spatialOverReferenceMedian,
                    executeSpeedupMedian: 1 / ratios.spatialOverReferenceExecuteMedian,
                })),
            },
            null,
            2,
        ),
    );
} finally {
    spatial.runtime.dispose();
    reference.runtime.dispose();
}
