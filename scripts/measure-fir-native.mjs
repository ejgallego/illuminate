import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { createIlluminatePlayerAdapter } from "../test_output/native/illuminate-player-browser-adapter.mjs";
import { createVirRuntime } from "../test_output/vir/sdk/js/vir-runtime-node.js";
import {
    normalizeVirTraceResult,
    prepareVirPlayerAnimation,
    prepareVirPlayerEvents,
} from "./lib/vir-player-trace.mjs";

const quick = process.argv.includes("--quick");
const warmupRounds = quick ? 1 : 2;
const sampleRounds = quick ? 3 : 12;
const prefixRounds = quick ? 2 : 5;
const traceEventCounts = quick ? [0, 1, 10] : [0, 1, 30];
const crossRuntimeBatchSize = quick ? 2 : 7;
const typedVirEntry = "Illuminate.Animation.Vir.replayTraceTyped";

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function quantile(values, fraction) {
    assert.ok(values.length > 0);
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function summarizeNumbers(values) {
    return {
        median: quantile(values, 0.5),
        p95: quantile(values, 0.95),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
    };
}

function summarizeRecords(records, names) {
    return Object.fromEntries(
        names.map((name) => [name, summarizeNumbers(records.map((record) => record[name]))]),
    );
}

function gitOutput(args) {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function readExamples() {
    const html = await readFile(
        new URL("../test_output/anim-comparison.html", import.meta.url),
        "utf8",
    );
    const marker = "var examples = ";
    const start = html.indexOf(marker);
    assert.notEqual(start, -1, "comparison examples are missing");
    const jsonStart = start + marker.length;
    const jsonEnd = html.indexOf(";\n", jsonStart);
    assert.notEqual(jsonEnd, -1, "comparison examples are unterminated");
    return JSON.parse(html.slice(jsonStart, jsonEnd));
}

async function readVirArtifacts() {
    const wasmBytes = await readFile(
        new URL("../test_output/vir/sdk/wasm/vir-upstream.wasm", import.meta.url),
    );
    const descriptorUrl = new URL(
        "../test_output/vir/module-sets/Illuminate/Animation/Vir.irpkg-set.json",
        import.meta.url,
    );
    const descriptorBytes = await readFile(descriptorUrl);
    const descriptor = JSON.parse(descriptorBytes.toString("utf8"));
    const packageBytes = await Promise.all(
        descriptor.packages.map((member) => readFile(new URL(member.path, descriptorUrl))),
    );
    return { wasmBytes, descriptorBytes, packageBytes };
}

function makeEvents(animation, count) {
    if (count === 0) return [];
    return [
        { kind: "playTo", frame: animation.totalFrames - 1, loopAfter: true },
        ...Array.from({ length: count - 1 }, (_, index) => ({
            kind: "tick",
            timestamp: 0.125 + index * (1000 / 60),
        })),
    ];
}

async function createAdapter(artifacts) {
    return createIlluminatePlayerAdapter({
        bytes: artifacts.wasmBytes,
        manifest: artifacts.manifest,
        build: artifacts.build,
    });
}

async function measureStartup(artifacts) {
    const observations = [];
    for (let round = -warmupRounds; round < sampleRounds; round += 1) {
        const adapter = await createAdapter(artifacts);
        if (round >= 0) observations.push(adapter.startupTimings);
    }
    return {
        observations,
        summary: summarizeRecords(observations, ["compileMs", "instantiateMs", "totalMs"]),
    };
}

async function measureFixedTrace(artifacts, workload, eventCount) {
    const adapter = await createAdapter(artifacts);
    const events = makeEvents(workload.animation, eventCount);
    for (let round = 0; round < warmupRounds; round += 1) {
        const warmup = adapter.replayTrace(workload.animation, events);
        assert.equal(warmup.ok, true, warmup.error);
    }
    const observations = [];
    for (let round = 0; round < sampleRounds; round += 1) {
        const result = adapter.replayTrace(workload.animation, events);
        assert.equal(result.ok, true, result.error);
        assert.equal(result.actions.length, eventCount + 1);
        observations.push({
            round,
            actionCount: result.actions.length,
            timings: result.timings,
            memory: result.memory,
        });
    }
    return {
        eventCount,
        observations,
        timingSummary: summarizeRecords(
            observations.map(({ timings }) => timings),
            [
                "projectMs",
                "encodeMs",
                "prepareMs",
                "executeMs",
                "decodeMs",
                "totalMs",
                "overheadMs",
            ],
        ),
        memorySummary: summarizeRecords(
            observations.map(({ memory }) => memory),
            [
                "inputBytes",
                "residentAllocationCalls",
                "frontierGrowthPrepare",
                "frontierGrowthExecute",
                "frontierGrowthTotal",
            ],
        ),
    };
}

function prefixCheckpoints(limit) {
    return [...new Set([1, 10, 30, 60, 120, limit].filter((value) => value <= limit))].sort(
        (left, right) => left - right,
    );
}

async function measurePrefixReplay(artifacts, workload) {
    const limit = workload.prefixLimit;
    const checkpoints = prefixCheckpoints(limit);
    const rounds = [];
    for (let round = 0; round < prefixRounds; round += 1) {
        const adapter = await createAdapter(artifacts);
        const events = makeEvents(workload.animation, limit);
        const frontierStart = adapter.synchronizeFrontier();
        let cumulativeMs = 0;
        const samples = [];
        for (let count = 1; count <= limit; count += 1) {
            const result = adapter.replayTrace(workload.animation, events.slice(0, count));
            assert.equal(result.ok, true, result.error);
            assert.equal(result.actions.length, count + 1);
            cumulativeMs += result.timings.totalMs;
            if (checkpoints.includes(count)) {
                samples.push({
                    eventCount: count,
                    actionCount: result.actions.length,
                    callTimings: result.timings,
                    callMemory: result.memory,
                    cumulativeMs,
                    cumulativeFrontierGrowth: result.memory.frontierAfterDecode - frontierStart,
                });
            }
        }
        rounds.push({ round, samples });
    }
    const summaries = checkpoints.map((eventCount) => {
        const samples = rounds.map(({ samples }) =>
            samples.find((sample) => sample.eventCount === eventCount),
        );
        assert.ok(samples.every(Boolean));
        return {
            eventCount,
            callTimingSummary: summarizeRecords(
                samples.map(({ callTimings }) => callTimings),
                ["projectMs", "encodeMs", "executeMs", "decodeMs", "totalMs"],
            ),
            callMemorySummary: summarizeRecords(
                samples.map(({ callMemory }) => callMemory),
                [
                    "inputBytes",
                    "frontierGrowthPrepare",
                    "frontierGrowthExecute",
                    "frontierGrowthTotal",
                ],
            ),
            cumulativeMs: summarizeNumbers(samples.map((sample) => sample.cumulativeMs)),
            cumulativeFrontierGrowth: summarizeNumbers(
                samples.map((sample) => sample.cumulativeFrontierGrowth),
            ),
        };
    });
    return { limit, prefixRounds, checkpoints, rounds, summaries };
}

function traceResult(result) {
    return result.ok ? { ok: true, actions: result.actions } : { ok: false, error: result.error };
}

function observationSummary(observations, phaseNames) {
    return {
        wallMs: summarizeNumbers(observations.map(({ wallMs }) => wallMs)),
        phases: Object.fromEntries(
            phaseNames.map((name) => [
                name,
                summarizeNumbers(observations.map(({ phases }) => phases[name])),
            ]),
        ),
    };
}

async function measureFirObservation(artifacts, animation, events) {
    const adapter = await createAdapter(artifacts);
    const calls = [];
    let result = null;
    for (let index = 0; index < crossRuntimeBatchSize; index += 1) {
        const started = performance.now();
        const call = adapter.replayTrace(animation, events);
        calls.push({
            wallMs: performance.now() - started,
            phases: call.timings,
            memory: call.memory,
        });
        assert.equal(call.ok, true, call.error);
        const normalized = traceResult(call);
        if (result === null) result = normalized;
        else assert.deepEqual(normalized, result, "FIR batch result mismatch");
    }
    assert.notEqual(result, null);
    return {
        wallMs: quantile(
            calls.map(({ wallMs }) => wallMs),
            0.5,
        ),
        phases: Object.fromEntries(
            Object.keys(calls[0].phases).map((name) => [
                name,
                quantile(
                    calls.map(({ phases }) => phases[name]),
                    0.5,
                ),
            ]),
        ),
        memory: Object.fromEntries(
            [
                "inputBytes",
                "frontierGrowthPrepare",
                "frontierGrowthExecute",
                "frontierGrowthTotal",
            ].map((name) => [
                name,
                quantile(
                    calls.map(({ memory }) => memory[name]),
                    0.5,
                ),
            ]),
        ),
        result,
    };
}

async function measureVirObservation(virArtifacts, animation, events) {
    const runtime = await createVirRuntime({
        wasmBytes: virArtifacts.wasmBytes,
        irPackageSetBytes: virArtifacts.packageBytes,
    });
    try {
        const calls = [];
        let result = null;
        for (let index = 0; index < crossRuntimeBatchSize; index += 1) {
            const started = performance.now();
            const call = runtime.callTimed(typedVirEntry, animation, events);
            calls.push({
                wallMs: performance.now() - started,
                phases: call.timings,
            });
            const normalized = normalizeVirTraceResult(call.value);
            assert.equal(normalized.ok, true, normalized.error);
            if (result === null) result = normalized;
            else assert.deepEqual(normalized, result, "VIR batch result mismatch");
        }
        assert.notEqual(result, null);
        return {
            wallMs: quantile(
                calls.map(({ wallMs }) => wallMs),
                0.5,
            ),
            phases: Object.fromEntries(
                Object.keys(calls[0].phases).map((name) => [
                    name,
                    quantile(
                        calls.map(({ phases }) => phases[name]),
                        0.5,
                    ),
                ]),
            ),
            result,
        };
    } finally {
        runtime.dispose();
    }
}

async function measureCrossRuntime(artifacts, virArtifacts, workload) {
    const events = makeEvents(workload.animation, 30);
    const virAnimation = prepareVirPlayerAnimation(workload.animation);
    const virEvents = prepareVirPlayerEvents(events);
    const observations = { firNative: [], virTyped: [] };
    let expected = null;
    for (let round = -warmupRounds; round < sampleRounds; round += 1) {
        const order = round % 2 === 0 ? ["firNative", "virTyped"] : ["virTyped", "firNative"];
        for (const variant of order) {
            const observation =
                variant === "firNative"
                    ? await measureFirObservation(artifacts, workload.animation, events)
                    : await measureVirObservation(virArtifacts, virAnimation, virEvents);
            if (expected === null) expected = observation.result;
            else
                assert.deepEqual(observation.result, expected, `${variant} cross-runtime mismatch`);
            if (round >= 0) observations[variant].push({ round, order, ...observation });
        }
    }
    assert.notEqual(expected, null);
    const firPhases = Object.keys(observations.firNative[0].phases);
    const virPhases = Object.keys(observations.virTyped[0].phases);
    const pairedTotalDeltaPercent = observations.firNative.map((fir, index) => {
        const vir = observations.virTyped[index];
        return ((fir.wallMs - vir.wallMs) / vir.wallMs) * 100;
    });
    return {
        workload: workload.title,
        eventCount: events.length,
        actionCount: expected.actions.length,
        batchSize: crossRuntimeBatchSize,
        animationProjectionSha256: sha256(JSON.stringify(virAnimation)),
        eventsSha256: sha256(JSON.stringify(events)),
        resultSha256: sha256(JSON.stringify(expected)),
        setupTimed: false,
        firIncludesProjection: true,
        virProjectionTimed: false,
        observations,
        summaries: {
            firNative: observationSummary(observations.firNative, firPhases),
            virTyped: observationSummary(observations.virTyped, virPhases),
            pairedFirWallDeltaPercent: summarizeNumbers(pairedTotalDeltaPercent),
        },
    };
}

const nativeRoot = new URL("../test_output/native/", import.meta.url);
const [wasmBytes, manifestBytes, buildBytes, adapterBytes, examples, virArtifacts] =
    await Promise.all([
        readFile(new URL("illuminate-player.wasm", nativeRoot)),
        readFile(new URL("illuminate-player.wasm.json", nativeRoot)),
        readFile(new URL("BUILD.json", nativeRoot)),
        readFile(new URL("illuminate-player-browser-adapter.mjs", nativeRoot)),
        readExamples(),
        readVirArtifacts(),
    ]);
const artifacts = {
    wasmBytes,
    manifest: JSON.parse(manifestBytes.toString("utf8")),
    build: JSON.parse(buildBytes.toString("utf8")),
};
assert.equal(artifacts.build.wasm.sha256, sha256(wasmBytes));

const workloadSpecs = [
    { id: "small", title: "Pause-driven slide show", prefixLimit: quick ? 30 : 120 },
    {
        id: "parameter-heavy",
        title: "Morphing arrows and final loop",
        prefixLimit: quick ? 10 : 30,
    },
];
const workloads = workloadSpecs.map((spec) => {
    const example = examples.find(({ title }) => title === spec.title);
    assert.ok(example, `missing comparison example ${spec.title}`);
    return {
        ...spec,
        animation: example.data,
        animationJsonBytes: Buffer.byteLength(JSON.stringify(example.data)),
        animationSha256: sha256(JSON.stringify(example.data)),
    };
});

const startup = await measureStartup(artifacts);
const results = [];
for (const workload of workloads) {
    const fixedTraces = [];
    for (const eventCount of traceEventCounts) {
        fixedTraces.push(await measureFixedTrace(artifacts, workload, eventCount));
    }
    results.push({
        id: workload.id,
        title: workload.title,
        animationJsonBytes: workload.animationJsonBytes,
        animationSha256: workload.animationSha256,
        totalFrames: workload.animation.totalFrames,
        segmentCount: workload.animation.segments.length,
        fixedTraces,
        prefixReplay: await measurePrefixReplay(artifacts, workload),
    });
}
const crossRuntime = await measureCrossRuntime(
    artifacts,
    virArtifacts,
    workloads.find(({ id }) => id === "parameter-heavy"),
);

const report = {
    schema: "illuminate.fir-native-trace-phases/v1",
    generatedAt: new Date().toISOString(),
    policy: {
        quick,
        warmupRounds,
        sampleRounds,
        prefixRounds,
        traceEventCounts,
        crossRuntimeBatchSize,
        fixedTraceRuntime: "one adapter per workload/event-count case",
        prefixReplayRuntime: "fresh adapter per round; prefixes replayed monotonically",
        setupExcludedFromTraceTimings: true,
    },
    identity: {
        illuminateHead: gitOutput(["rev-parse", "HEAD"]),
        illuminateDirty: gitOutput(["status", "--porcelain"]) !== "",
        firHead: artifacts.build.sources.fir.commit,
        wasmSha256: sha256(wasmBytes),
        wasmBytes: wasmBytes.byteLength,
        manifestSha256: sha256(manifestBytes),
        buildSha256: sha256(buildBytes),
        adapterSha256: sha256(adapterBytes),
        adapterApi: artifacts.build.capabilities.browserAdapter.apiVersion,
        inputLayout: artifacts.build.capabilities.inputLayout.version,
        ownership: artifacts.build.capabilities.ownership.version,
        virWasmSha256: sha256(virArtifacts.wasmBytes),
        virPackageSetDescriptorSha256: sha256(virArtifacts.descriptorBytes),
        virPackageMemberSha256: virArtifacts.packageBytes.map(sha256),
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
    },
    startup,
    workloads: results,
    crossRuntime,
};

const outputUrl = new URL("../test_output/perf/fir-native-trace-phases.json", import.meta.url);
await mkdir(new URL(".", outputUrl), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`);

console.log("FIR-native whole-trace medians (milliseconds / bytes)");
for (const workload of results) {
    console.log(`\n${workload.title} (${workload.animationJsonBytes} JSON bytes)`);
    for (const trace of workload.fixedTraces) {
        const timing = trace.timingSummary;
        const memory = trace.memorySummary;
        console.log(
            `  ${String(trace.eventCount).padStart(3)} events: ` +
                `project=${timing.projectMs.median.toFixed(3)} ` +
                `encode=${timing.encodeMs.median.toFixed(3)} ` +
                `execute=${timing.executeMs.median.toFixed(3)} ` +
                `decode=${timing.decodeMs.median.toFixed(3)} ` +
                `total=${timing.totalMs.median.toFixed(3)} ` +
                `frontier=${memory.frontierGrowthTotal.median}`,
        );
    }
    const last = workload.prefixReplay.summaries.at(-1);
    console.log(
        `  replay prefixes 1..${last.eventCount}: ` +
            `cumulative=${last.cumulativeMs.median.toFixed(3)} ms ` +
            `frontier=${last.cumulativeFrontierGrowth.median} bytes`,
    );
}
console.log("\nPaired 30-event parameter-heavy boundary");
console.log(
    `  FIR native=${crossRuntime.summaries.firNative.wallMs.median.toFixed(3)} ms ` +
        `VIR typed=${crossRuntime.summaries.virTyped.wallMs.median.toFixed(3)} ms ` +
        `paired delta=${crossRuntime.summaries.pairedFirWallDeltaPercent.median.toFixed(1)}%`,
);
console.log(`\nwrote ${outputUrl.pathname}`);
