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
const stabilityQueries = quick ? 1_000 : 10_000;

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

function groupObservations(records, field) {
    const names = [...new Set(records.map((record) => record[field]))].sort();
    return Object.fromEntries(
        names.map((name) => [
            name,
            summarizeObservations(
                records
                    .filter((record) => record[field] === name)
                    .map((record) => record.observation),
            ),
        ]),
    );
}

function summarizeProfile(records) {
    return {
        aggregate: summarizeObservations(records.map((record) => record.observation)),
        byQueryClass: groupObservations(records, "queryClass"),
        byResultClass: groupObservations(records, "resultClass"),
        byQueryAndResultClass: groupObservations(records, "queryAndResultClass"),
    };
}

function groupRatios(referenceGroups, spatialGroups) {
    const names = [
        ...new Set([...Object.keys(referenceGroups), ...Object.keys(spatialGroups)]),
    ].sort();
    return Object.fromEntries(
        names.map((name) => {
            const reference = referenceGroups[name]?.executeMs;
            const spatial = spatialGroups[name]?.executeMs;
            if (reference === undefined || spatial === undefined) {
                throw new Error(`incomplete spatial diagnostic group ${name}`);
            }
            return [
                name,
                {
                    samplesPerBackend: reference.count,
                    referenceExecute: reference,
                    spatialExecute: spatial,
                    executeSpeedupMedian: reference.medianMs / spatial.medianMs,
                    executeSpeedupMean: reference.meanMs / spatial.meanMs,
                    executeSpeedupP95: reference.p95Ms / spatial.p95Ms,
                },
            ];
        }),
    );
}

function sameResult(actual, expected) {
    return (
        actual.kind === expected.kind &&
        (expected.kind !== "tag" ||
            (actual.value === expected.value && actual.label === expected.label))
    );
}

function verifyStability(name, runtime, createHost, fixture) {
    const first = createHost(runtime, fixture.encodedScene);
    const replacement = createHost(runtime, fixture.encodedScene);
    let firstDisposed = false;
    try {
        for (let index = 0; index < 100; index += 1) {
            const query = fixture.queries[index % fixture.queries.length];
            if (!sameResult(replacement.query(query.x, query.y), query.expected)) {
                throw new Error(`${name} warmup mismatch at ${query.name}`);
            }
        }
        const memoryAfterWarmup = runtime.exports.memory.buffer.byteLength;
        for (let index = 0; index < stabilityQueries; index += 1) {
            const query = fixture.queries[index % fixture.queries.length];
            if (!sameResult(replacement.query(query.x, query.y), query.expected)) {
                throw new Error(`${name} stability mismatch at ${query.name}`);
            }
        }
        const memoryAfterQueries = runtime.exports.memory.buffer.byteLength;
        if (memoryAfterQueries !== memoryAfterWarmup) {
            throw new Error(
                `${name} memory grew from ${memoryAfterWarmup} to ${memoryAfterQueries} bytes`,
            );
        }
        first.dispose();
        firstDisposed = true;
        const survivorQuery = fixture.queries.at(-1);
        if (
            survivorQuery === undefined ||
            !sameResult(replacement.query(survivorQuery.x, survivorQuery.y), survivorQuery.expected)
        ) {
            throw new Error(`${name} replacement failed after peer disposal`);
        }
        return {
            fixture: fixture.name,
            simultaneousInstances: 2,
            warmupQueries: 100,
            measuredQueries: stabilityQueries,
            memoryAfterWarmup,
            memoryAfterQueries,
            independentAfterPeerDispose: true,
        };
    } finally {
        replacement.dispose();
        if (!firstDisposed) first.dispose();
    }
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
    function createCandidate(name, createHost) {
        const candidate = { name, records: [], currentQuery: null, host: null };
        candidate.host = createHost((observation) => {
            if (observation.kind !== "query") return;
            const query = candidate.currentQuery;
            if (query === null) throw new Error(`${name} emitted an unattributed observation`);
            candidate.records.push({
                observation,
                queryClass: query.queryClass,
                resultClass: query.resultClass,
                queryAndResultClass: `${query.queryClass}/${query.resultClass}`,
            });
        });
        return candidate;
    }
    const candidates = [
        createCandidate("reference", (observer) =>
            createVirHitSceneHost(reference.runtime, fixture.encodedScene, observer),
        ),
        createCandidate("spatial", (observer) =>
            createVirSpatialHitSceneHost(spatial.runtime, fixture.encodedScene, observer),
        ),
    ];
    try {
        for (let round = 0; round < 1 + profileRounds; round += 1) {
            const order = candidates.map(
                (_, index) => candidates[(index + round) % candidates.length],
            );
            for (const query of fixture.queries) {
                for (const candidate of order) {
                    candidate.currentQuery = query;
                    try {
                        const actual = candidate.host.query(query.x, query.y);
                        if (!sameResult(actual, query.expected)) {
                            throw new Error(
                                `${candidate.name} diagnostic mismatch at ${query.name}`,
                            );
                        }
                    } finally {
                        candidate.currentQuery = null;
                    }
                }
            }
            if (round === 0) {
                for (const candidate of candidates) candidate.records.length = 0;
            }
        }
        return Object.fromEntries(
            candidates.map(({ name, records }) => [name, summarizeProfile(records)]),
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
        const classRatios = {
            byQueryClass: groupRatios(
                diagnostics.reference.byQueryClass,
                diagnostics.spatial.byQueryClass,
            ),
            byResultClass: groupRatios(
                diagnostics.reference.byResultClass,
                diagnostics.spatial.byResultClass,
            ),
            byQueryAndResultClass: groupRatios(
                diagnostics.reference.byQueryAndResultClass,
                diagnostics.spatial.byQueryAndResultClass,
            ),
        };
        workloads.push({
            name: fixture.name,
            geometryClass: fixture.geometryClass,
            queryCount: fixture.queries.length,
            encodedBytes: fixture.encodedScene.length,
            timing,
            diagnostics,
            classRatios,
            ratios: {
                spatialOverReferenceMedian:
                    timing.spatial.query.medianMs / timing.reference.query.medianMs,
                spatialOverReferenceMean:
                    timing.spatial.query.meanMs / timing.reference.query.meanMs,
                spatialOverReferenceP95: timing.spatial.query.p95Ms / timing.reference.query.p95Ms,
                spatialOverReferenceCreation:
                    timing.spatial.creationMs / timing.reference.creationMs,
                spatialOverReferenceExecuteMedian:
                    diagnostics.spatial.aggregate.executeMs.medianMs /
                    diagnostics.reference.aggregate.executeMs.medianMs,
            },
        });
    }
    const stabilityFixture = suite.fixtures.find((fixture) => fixture.geometryClass === "paths");
    if (stabilityFixture === undefined) throw new Error("path stability fixture is missing");
    const stability = {
        reference: verifyStability(
            "reference",
            reference.runtime,
            createVirHitSceneHost,
            stabilityFixture,
        ),
        spatial: verifyStability(
            "spatial",
            spatial.runtime,
            createVirSpatialHitSceneHost,
            stabilityFixture,
        ),
    };
    const report = {
        schemaVersion: "illuminate.vir-spatial-hit-scene-performance/v2",
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
            diagnosticQueriesAttributedByClass: true,
            stabilityQueries,
            creationOrderBalanced: false,
            creationRatiosExploratoryOnly: true,
        },
        backends: {
            reference: reference.metadata,
            spatial: spatial.metadata,
        },
        workloads,
        stability,
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
                stability,
            },
            null,
            2,
        ),
    );
} finally {
    spatial.runtime.dispose();
    reference.runtime.dispose();
}
