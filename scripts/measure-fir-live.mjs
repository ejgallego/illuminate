import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const packageArgument = process.env.ILLUMINATE_FIR_LIVE_PLAYER_DIR;
assert.ok(
    packageArgument,
    "set ILLUMINATE_FIR_LIVE_PLAYER_DIR to an immutable FIR live-player package",
);
const packageRoot = await realpath(path.resolve(packageArgument));
const quick = process.argv.includes("--quick");
const creationRounds = quick ? 3 : 12;
const warmupTicks = quick ? 10 : 60;
const measuredTicks = quick ? 120 : 1_200;

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function quantile(values, fraction) {
    assert.ok(values.length > 0);
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function summarize(values) {
    return {
        median: quantile(values, 0.5),
        p95: quantile(values, 0.95),
        minimum: Math.min(...values),
        maximum: Math.max(...values),
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    };
}

function summarizeFields(records, fields) {
    return Object.fromEntries(
        fields.map((field) => [field, summarize(records.map((row) => row[field]))]),
    );
}

async function readExamples() {
    const html = await readFile(
        new URL("../test_output/anim-comparison.html", import.meta.url),
        "utf8",
    );
    const marker = "var examples = ";
    const start = html.indexOf(marker);
    assert.notEqual(start, -1, "run lake test to generate anim-comparison.html");
    const jsonStart = start + marker.length;
    const jsonEnd = html.indexOf(";\n", jsonStart);
    assert.notEqual(jsonEnd, -1, "comparison example payload is incomplete");
    return JSON.parse(html.slice(jsonStart, jsonEnd));
}

const [adapterModule, wasmBytes, manifestBytes, buildBytes, examples] = await Promise.all([
    import(
        pathToFileURL(path.join(packageRoot, "illuminate-selection-player-browser-adapter.mjs"))
            .href
    ),
    readFile(path.join(packageRoot, "illuminate-selection-player.wasm")),
    readFile(path.join(packageRoot, "illuminate-selection-player.wasm.json")),
    readFile(path.join(packageRoot, "BUILD.json")),
    readExamples(),
]);
const manifest = JSON.parse(manifestBytes);
const build = JSON.parse(buildBytes);
assert.equal(
    adapterModule.ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION,
    "fir.illuminate-player.browser/v4",
);
assert.equal(
    adapterModule.ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION,
    "fir.illuminate-player.persistent-checkpoint/v2",
);
assert.equal(sha256(wasmBytes), build.wasm.sha256);

const adapter = await adapterModule.createIlluminateSelectionPlayerAdapter({
    bytes: wasmBytes,
    manifest,
    build,
});

const workloadTitles = ["Pause-driven slide show", "Morphing arrows and final loop"];
const workloads = workloadTitles.map((title) => {
    const example = examples.find((candidate) => candidate.title === title);
    assert.ok(example, `missing comparison example ${title}`);
    return example;
});

function active(playback) {
    return ["playing", "looping", "finishingLoop"].includes(playback);
}

function startPlayer(player, animation) {
    const looping = animation.steps.find((step) => step.loop);
    const event = looping ? { kind: "loopAt", frame: looping.frame } : { kind: "advance" };
    const started = adapter.dispatch(player, event);
    assert.equal(started.ok, true, started.error);
    return started;
}

function resumeIfNeeded(player, animation, action) {
    if (active(action.playback)) return;
    const reset = adapter.dispatch(player, { kind: "seek", frame: 0 });
    assert.equal(reset.ok, true, reset.error);
    startPlayer(player, animation);
}

function measureCreation(animation) {
    const observations = [];
    for (let round = 0; round < creationRounds; round += 1) {
        const wallStarted = performance.now();
        const created = adapter.createPlayer(animation);
        const wallMs = performance.now() - wallStarted;
        assert.equal(created.ok, true, created.error);
        observations.push({
            round,
            wallMs,
            timings: created.timings,
            memory: created.memory,
        });
        adapter.disposePlayer(created.player);
    }
    const timingFields = Object.keys(observations[0].timings);
    const memoryFields = [
        "selectionBytes",
        "persistentAllocationCalls",
        "persistentCheckpoint",
        "peakFrontier",
        "pagesAfter",
    ];
    return {
        observations,
        wallMs: summarize(observations.map(({ wallMs }) => wallMs)),
        timings: summarizeFields(
            observations.map(({ timings }) => timings),
            timingFields,
        ),
        memory: summarizeFields(
            observations.map(({ memory }) => memory),
            memoryFields,
        ),
    };
}

function measureDispatch(animation) {
    const created = adapter.createPlayer(animation);
    assert.equal(created.ok, true, created.error);
    startPlayer(created.player, animation);
    let timestamp = 0.125;
    for (let index = 0; index < warmupTicks; index += 1) {
        const tick = adapter.dispatch(created.player, { kind: "tick", timestamp });
        assert.equal(tick.ok, true, tick.error);
        resumeIfNeeded(created.player, animation, tick.action);
        timestamp += 1000 / 60;
    }

    const observations = [];
    const checkpoint = created.memory.persistentCheckpoint;
    for (let index = 0; index < measuredTicks; index += 1) {
        const wallStarted = performance.now();
        const tick = adapter.dispatch(created.player, { kind: "tick", timestamp });
        const wallMs = performance.now() - wallStarted;
        assert.equal(tick.ok, true, tick.error);
        assert.equal(tick.memory.frontierBefore, checkpoint);
        assert.equal(tick.memory.postRewindFrontier, checkpoint);
        observations.push({
            index,
            timestamp,
            wallMs,
            timings: tick.timings,
            memory: tick.memory,
        });
        resumeIfNeeded(created.player, animation, tick.action);
        timestamp += 1000 / 60;
    }
    adapter.disposePlayer(created.player);

    const timingFields = Object.keys(observations[0].timings);
    const memoryFields = ["scratchBytes", "scratchAllocationCalls", "peakFrontier", "pagesAfter"];
    return {
        warmupTicks,
        measuredTicks,
        fixedTimestampStepMs: 1000 / 60,
        persistentCheckpoint: checkpoint,
        observations,
        wallMs: summarize(observations.map(({ wallMs }) => wallMs)),
        timings: summarizeFields(
            observations.map(({ timings }) => timings),
            timingFields,
        ),
        memory: summarizeFields(
            observations.map(({ memory }) => memory),
            memoryFields,
        ),
    };
}

const results = workloads.map(({ title, data }) => ({
    title,
    animation: {
        jsonBytes: Buffer.byteLength(JSON.stringify(data)),
        sha256: sha256(JSON.stringify(data)),
        totalFrames: data.totalFrames,
        segments: data.segments.length,
    },
    creation: measureCreation(data),
    dispatch: measureDispatch(data),
}));

const report = {
    schema: "illuminate.fir-live-phases/v2",
    generatedAt: new Date().toISOString(),
    scope: {
        coreOnly: true,
        domIncluded: false,
        note: "DOM-inclusive rolling measurements are exported by the comparison dashboard",
    },
    policy: { quick, creationRounds, warmupTicks, measuredTicks },
    identity: {
        packageRoot,
        firCommit: build.sources?.fir?.commit,
        illuminateCommit: build.sources?.illuminate?.commit,
        wasmBytes: wasmBytes.byteLength,
        wasmSha256: sha256(wasmBytes),
        manifestSha256: sha256(manifestBytes),
        buildSha256: sha256(buildBytes),
        adapterApi: adapterModule.ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION,
        inputLayout: adapterModule.ILLUMINATE_SELECTION_PLAYER_INPUT_LAYOUT_VERSION,
        ownership: adapterModule.ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION,
        startupTimings: adapter.startupTimings,
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
    },
    workloads: results,
};

const outputUrl = new URL("../test_output/perf/fir-live-phases.json", import.meta.url);
await mkdir(new URL(".", outputUrl), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`);

console.log("FIR live player medians (milliseconds / bytes)");
for (const result of results) {
    console.log(`\n${result.title} (${result.animation.jsonBytes} JSON bytes)`);
    console.log(
        `  create: wall=${result.creation.wallMs.median.toFixed(3)} ` +
            `project=${result.creation.timings.projectMs.median.toFixed(3)} ` +
            `encode=${result.creation.timings.selectionEncodeMs.median.toFixed(3)} ` +
            `execute=${result.creation.timings.executeMs.median.toFixed(3)}`,
    );
    console.log(
        `  tick: wall=${result.dispatch.wallMs.median.toFixed(3)} ` +
            `encode=${result.dispatch.timings.encodeMs.median.toFixed(3)} ` +
            `execute=${result.dispatch.timings.executeMs.median.toFixed(3)} ` +
            `decode=${result.dispatch.timings.decodeMs.median.toFixed(3)} ` +
            `rewind=${result.dispatch.timings.rewindMs.median.toFixed(3)} ` +
            `scratch=${result.dispatch.memory.scratchBytes.median.toFixed(0)}`,
    );
}
console.log(`\nwrote ${outputUrl.pathname}`);
