import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";

import { createVirRuntime } from "../test_output/vir/sdk/js/vir-runtime-node.js";
import {
    projectVirSelectionAnimation,
    projectVirSelectionEvent,
} from "../player_js/vir_selection_player.js";

const warmupTicks = process.argv.includes("--quick") ? 40 : 200;
const measuredTicks = process.argv.includes("--quick") ? 240 : 2000;
const sampleRounds = process.argv.includes("--quick") ? 1 : 5;
const initialDirectEntry = "Illuminate.Animation.Vir.initialSelectionDirect";
const transitionDirectEntry = "Illuminate.Animation.Vir.transitionSelectionDirect";
const mountEntry = "Illuminate.Animation.Vir.mountSelectionPlayer";
const snapshotEntry = "Illuminate.Animation.Vir.selectionPlayerSnapshot";
const dispatchEntry = "Illuminate.Animation.Vir.dispatchSelectionPlayer";
const disposeEntry = "Illuminate.Animation.Vir.disposeSelectionPlayer";

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
        mean: values.reduce((sum, value) => sum + value, 0) / values.length,
        minimum: Math.min(...values),
        maximum: Math.max(...values),
    };
}

function summarizeCalls(calls) {
    const timingFields = Object.keys(calls[0].timings).filter((field) =>
        calls.every((call) => Number.isFinite(call.timings[field])),
    );
    return {
        wallMs: summarize(calls.map((call) => call.wallMs)),
        timings: Object.fromEntries(
            timingFields.map((field) => [
                field,
                summarize(calls.map((call) => call.timings[field])),
            ]),
        ),
    };
}

function summarizeRoundLane(rounds, lane) {
    const values = rounds.map((round) => round[lane]);
    const timingFields = Object.keys(values[0].timings);
    return {
        wallMs: summarize(values.map((value) => value.wallMs.median)),
        timings: Object.fromEntries(
            timingFields.map((field) => [
                field,
                summarize(values.map((value) => value.timings[field].median)),
            ]),
        ),
    };
}

function aggregateWorkload(rounds) {
    const direct = summarizeRoundLane(rounds, "direct");
    const retained = summarizeRoundLane(rounds, "retained");
    const directExecute = direct.timings.executeMs.median;
    const retainedExecute = retained.timings.executeMs.median;
    return {
        title: rounds[0].title,
        animation: rounds[0].animation,
        samples: measuredTicks * rounds.length,
        sampleRounds: rounds.length,
        direct,
        retained,
        comparison: {
            executeRatio: retainedExecute / directExecute,
            executeDeltaMs: retainedExecute - directExecute,
            totalRatio: retained.timings.totalMs.median / direct.timings.totalMs.median,
            wallRatio: retained.wallMs.median / direct.wallMs.median,
        },
        rounds,
    };
}

function requireOk(result, operation) {
    assert.equal(typeof result, "object", `${operation} returned a non-object`);
    assert.notEqual(result, null, `${operation} returned null`);
    assert.equal(result.kind, "ok", `${operation} failed: ${String(result.value)}`);
    return result.value;
}

function callTimed(runtime, name, ...args) {
    const started = performance.now();
    const observation = runtime.callTimed(name, ...args);
    return {
        value: observation.value,
        timings: observation.timings,
        wallMs: performance.now() - started,
    };
}

async function readExamples() {
    const html = await readFile(
        new URL("../test_output/anim-comparison.html", import.meta.url),
        "utf8",
    );
    const marker = "var examples = ";
    const start = html.indexOf(marker);
    assert.notEqual(start, -1, "run lake test --wfail to generate anim-comparison.html");
    const jsonStart = start + marker.length;
    const jsonEnd = html.indexOf(";\n", jsonStart);
    assert.notEqual(jsonEnd, -1, "comparison example payload is incomplete");
    return JSON.parse(html.slice(jsonStart, jsonEnd));
}

async function readPackageSet() {
    const descriptorUrl = new URL(
        "../test_output/vir/module-sets/Illuminate/Animation/Vir.irpkg-set.json",
        import.meta.url,
    );
    const descriptorBytes = await readFile(descriptorUrl);
    const descriptor = JSON.parse(descriptorBytes.toString("utf8"));
    const members = await Promise.all(
        descriptor.packages.map((member) => readFile(new URL(member.path, descriptorUrl))),
    );
    return { descriptorBytes, members };
}

function selectionsMatch(direct, retained) {
    assert.deepEqual(direct.selection, retained.action, "direct/retained selection mismatch");
    assert.equal(
        direct.scheduleNextFrame,
        retained.scheduleNextFrame,
        "direct/retained scheduling mismatch",
    );
}

function startEvent(animation) {
    const loop = animation.steps.find((step) => step.loop);
    return loop ? { kind: "loopAt", frame: loop.frame } : { kind: "advance" };
}

function gitOutput(args) {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function measureWorkload(runtime, example) {
    const animation = projectVirSelectionAnimation(example.data);
    const initialDirect = requireOk(
        runtime.call(initialDirectEntry, animation),
        "direct initialization",
    );
    let directState = initialDirect.state;
    const handle = requireOk(runtime.call(mountEntry, animation), "retained mount");
    const initialRetained = runtime.call(snapshotEntry, handle);
    selectionsMatch(initialDirect, initialRetained);

    function direct(event, timed) {
        const projected = projectVirSelectionEvent(event);
        const observed = timed
            ? callTimed(runtime, transitionDirectEntry, animation, directState, projected)
            : { value: runtime.call(transitionDirectEntry, animation, directState, projected) };
        directState = observed.value.state;
        return observed;
    }

    function retained(event, timed) {
        const projected = projectVirSelectionEvent(event);
        return timed
            ? callTimed(runtime, dispatchEntry, handle, projected)
            : { value: runtime.call(dispatchEntry, handle, projected) };
    }

    function dispatchPair(event, timed, directFirst) {
        let directResult;
        let retainedResult;
        if (directFirst) {
            directResult = direct(event, timed);
            retainedResult = retained(event, timed);
        } else {
            retainedResult = retained(event, timed);
            directResult = direct(event, timed);
        }
        selectionsMatch(directResult.value, retainedResult.value);
        return { direct: directResult, retained: retainedResult };
    }

    function resume(output, directFirst) {
        const playback = output.selection.playback;
        if (["playing", "looping", "finishingLoop"].includes(playback)) return;
        if (playback === "finished") {
            dispatchPair({ kind: "seek", frame: 0 }, false, directFirst);
        }
        dispatchPair(startEvent(example.data), false, directFirst);
    }

    dispatchPair(startEvent(example.data), false, true);
    const directCalls = [];
    const retainedCalls = [];
    let timestamp = 0.125;
    const totalTicks = warmupTicks + measuredTicks;
    for (let index = 0; index < totalTicks; index += 1) {
        const measured = index >= warmupTicks;
        const pair = dispatchPair({ kind: "tick", timestamp }, measured, index % 2 === 0);
        if (measured) {
            directCalls.push(pair.direct);
            retainedCalls.push(pair.retained);
        }
        resume(pair.direct.value, index % 2 !== 0);
        timestamp += 1000 / 60;
    }

    runtime.call(disposeEntry, handle);
    const directSummary = summarizeCalls(directCalls);
    const retainedSummary = summarizeCalls(retainedCalls);
    const directExecute = directSummary.timings.executeMs.median;
    const retainedExecute = retainedSummary.timings.executeMs.median;
    return {
        title: example.title,
        animation: {
            compactJsonBytes: Buffer.byteLength(JSON.stringify(animation)),
            totalFrames: example.data.totalFrames,
            segments: example.data.segments.length,
            steps: example.data.steps.length,
        },
        samples: measuredTicks,
        direct: directSummary,
        retained: retainedSummary,
        comparison: {
            executeRatio: retainedExecute / directExecute,
            executeDeltaMs: retainedExecute - directExecute,
            totalRatio:
                retainedSummary.timings.totalMs.median / directSummary.timings.totalMs.median,
            wallRatio: retainedSummary.wallMs.median / directSummary.wallMs.median,
        },
    };
}

const [wasmBytes, packageSet, examples] = await Promise.all([
    readFile(new URL("../test_output/vir/sdk/wasm/vir-upstream.wasm", import.meta.url)),
    readPackageSet(),
    readExamples(),
]);
const runtime = await createVirRuntime({
    wasmBytes,
    irPackageSetBytes: packageSet.members,
});
const workloadTitles = ["Pause-driven slide show", "Morphing arrows and final loop"];
let workloads;
try {
    const selected = workloadTitles.map((title) => {
        const example = examples.find((candidate) => candidate.title === title);
        assert.ok(example, `missing comparison example ${title}`);
        return example;
    });
    const roundsByTitle = new Map(selected.map((example) => [example.title, []]));
    for (let round = 0; round < sampleRounds; round += 1) {
        const order = round % 2 === 0 ? selected : [...selected].reverse();
        for (const example of order) {
            roundsByTitle.get(example.title).push({
                round,
                order: order.map(({ title }) => title),
                ...measureWorkload(runtime, example),
            });
        }
    }
    workloads = selected.map((example) => aggregateWorkload(roundsByTitle.get(example.title)));
} finally {
    runtime.dispose();
}

const report = {
    schema: "illuminate.vir-selection-core/v1",
    generatedAt: new Date().toISOString(),
    scope: {
        domIncluded: false,
        runtimeSetupTimed: false,
        targetResolutionWarm: true,
        direct: "typed SelectionAnimation + PlayerState + PlayerEvent input and LiveSelectionTransition output",
        retained: "JSL handle + PlayerEvent input and SelectionPlayerOutput output",
        interpretation:
            "execute delta prices retained handle/ref operations only approximately because the direct boundary transfers state",
    },
    policy: {
        warmupTicks,
        measuredTicks,
        sampleRounds,
        roundAggregation: "median of per-round call medians",
        pairedCalls: true,
        alternatingCallOrder: true,
        fixedTimestampStepMs: 1000 / 60,
    },
    identity: {
        illuminateHead: gitOutput(["rev-parse", "HEAD"]),
        virHead: gitOutput(["-C", "vir", "rev-parse", "HEAD"]),
        wasmSha256: sha256(wasmBytes),
        packageSetDescriptorSha256: sha256(packageSet.descriptorBytes),
        packageMemberSha256: packageSet.members.map(sha256),
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
    },
    workloads,
};

const outputUrl = new URL("../test_output/perf/vir-selection-core.json", import.meta.url);
await mkdir(new URL(".", outputUrl), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`);

console.log("VIR direct transition / retained player medians (milliseconds)");
for (const workload of workloads) {
    console.log(`\n${workload.title}`);
    console.log(
        `  direct:   execute=${workload.direct.timings.executeMs.median.toFixed(4)} ` +
            `marshal=${workload.direct.timings.marshalMs.median.toFixed(4)} ` +
            `decode=${workload.direct.timings.decodeMs.median.toFixed(4)} ` +
            `host=${workload.direct.timings.hostMs.median.toFixed(4)} ` +
            `total=${workload.direct.timings.totalMs.median.toFixed(4)}`,
    );
    console.log(
        `  retained: execute=${workload.retained.timings.executeMs.median.toFixed(4)} ` +
            `marshal=${workload.retained.timings.marshalMs.median.toFixed(4)} ` +
            `decode=${workload.retained.timings.decodeMs.median.toFixed(4)} ` +
            `host=${workload.retained.timings.hostMs.median.toFixed(4)} ` +
            `total=${workload.retained.timings.totalMs.median.toFixed(4)}`,
    );
    console.log(
        `  retained/direct execute=${workload.comparison.executeRatio.toFixed(2)}× ` +
            `(${workload.comparison.executeDeltaMs >= 0 ? "+" : ""}${(
                workload.comparison.executeDeltaMs * 1000
            ).toFixed(1)} μs)`,
    );
}
console.log(`\nwrote ${outputUrl.pathname}`);
