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

const quick = process.argv.includes("--quick");
const warmupTicks = quick ? 100 : 500;
const measuredTicks = quick ? 500 : 5000;
const sampleRounds = quick ? 2 : 7;
const mountEntry = "Illuminate.Animation.Vir.mountSelectionPlayer";
const snapshotEntry = "Illuminate.Animation.Vir.selectionPlayerSnapshot";
const dispatchEntry = "Illuminate.Animation.Vir.dispatchSelectionPlayer";
const tickEntry = "Illuminate.Animation.Vir.dispatchSelectionTick";
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

function aggregateLane(rounds, lane) {
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

function requireOk(result, operation) {
    assert.equal(result?.kind, "ok", `${operation} failed: ${String(result?.value)}`);
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

function startEvent(animation) {
    const loop = animation.steps.find((step) => step.loop);
    return loop ? { kind: "loopAt", frame: loop.frame } : { kind: "advance" };
}

function gitOutput(args) {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function measureRound(runtime, example, round) {
    const animation = projectVirSelectionAnimation(example.data);
    const genericHandle = requireOk(runtime.call(mountEntry, animation), "generic mount");
    const scalarHandle = requireOk(runtime.call(mountEntry, animation), "scalar mount");
    assert.deepEqual(
        runtime.call(snapshotEntry, genericHandle),
        runtime.call(snapshotEntry, scalarHandle),
        "initial selections differ",
    );

    function dispatch(handle, event, scalarTick, timed) {
        if (scalarTick && event.kind === "tick") {
            return timed
                ? callTimed(runtime, tickEntry, handle, event.timestamp)
                : { value: runtime.call(tickEntry, handle, event.timestamp) };
        }
        const projected = projectVirSelectionEvent(event);
        return timed
            ? callTimed(runtime, dispatchEntry, handle, projected)
            : { value: runtime.call(dispatchEntry, handle, projected) };
    }

    function dispatchPair(event, timed, scalarFirst) {
        let generic;
        let scalar;
        if (scalarFirst) {
            scalar = dispatch(scalarHandle, event, true, timed);
            generic = dispatch(genericHandle, event, false, timed);
        } else {
            generic = dispatch(genericHandle, event, false, timed);
            scalar = dispatch(scalarHandle, event, true, timed);
        }
        assert.deepEqual(scalar.value, generic.value, `scalar mismatch for ${event.kind}`);
        return { generic, scalar };
    }

    function resume(output, scalarFirst) {
        const playback = output.action.playback;
        if (["playing", "looping", "finishingLoop"].includes(playback)) return;
        if (playback === "finished") {
            dispatchPair({ kind: "seek", frame: 0 }, false, scalarFirst);
        }
        dispatchPair(startEvent(example.data), false, scalarFirst);
    }

    const genericCalls = [];
    const scalarCalls = [];
    try {
        dispatchPair(startEvent(example.data), false, round % 2 !== 0);
        let timestamp = 0.125;
        for (let index = 0; index < warmupTicks + measuredTicks; index += 1) {
            const measured = index >= warmupTicks;
            const pair = dispatchPair(
                { kind: "tick", timestamp },
                measured,
                (index + round) % 2 !== 0,
            );
            if (measured) {
                genericCalls.push(pair.generic);
                scalarCalls.push(pair.scalar);
            }
            resume(pair.generic.value, (index + round) % 2 === 0);
            timestamp += 1000 / 60;
        }
    } finally {
        runtime.call(disposeEntry, genericHandle);
        runtime.call(disposeEntry, scalarHandle);
    }
    return {
        round,
        generic: summarizeCalls(genericCalls),
        scalar: summarizeCalls(scalarCalls),
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
    workloads = workloadTitles.map((title) => {
        const example = examples.find((candidate) => candidate.title === title);
        assert.ok(example, `missing comparison example ${title}`);
        const rounds = Array.from({ length: sampleRounds }, (_, round) =>
            measureRound(runtime, example, round),
        );
        const generic = aggregateLane(rounds, "generic");
        const scalar = aggregateLane(rounds, "scalar");
        return {
            title,
            samples: measuredTicks * sampleRounds,
            generic,
            scalar,
            ratios: {
                marshal: scalar.timings.marshalMs.median / generic.timings.marshalMs.median,
                execute: scalar.timings.executeMs.median / generic.timings.executeMs.median,
                decode: scalar.timings.decodeMs.median / generic.timings.decodeMs.median,
                total: scalar.timings.totalMs.median / generic.timings.totalMs.median,
                wall: scalar.wallMs.median / generic.wallMs.median,
            },
            deltasMs: {
                marshal: scalar.timings.marshalMs.median - generic.timings.marshalMs.median,
                execute: scalar.timings.executeMs.median - generic.timings.executeMs.median,
                decode: scalar.timings.decodeMs.median - generic.timings.decodeMs.median,
                total: scalar.timings.totalMs.median - generic.timings.totalMs.median,
                wall: scalar.wallMs.median - generic.wallMs.median,
            },
            rounds,
        };
    });
} finally {
    runtime.dispose();
}

const report = {
    schema: "illuminate.vir-scalar-tick/v1",
    generatedAt: new Date().toISOString(),
    scope: {
        generic: "retained handle plus typed PlayerEvent.tick input",
        scalar: "same retained handle plus Float timestamp input",
        output: "identical SelectionPlayerOutput",
        domIncluded: false,
        targetResolutionWarm: true,
    },
    policy: {
        warmupTicks,
        measuredTicks,
        sampleRounds,
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

const outputUrl = new URL("../test_output/perf/vir-scalar-tick.json", import.meta.url);
await mkdir(new URL(".", outputUrl), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`);

console.log("VIR generic-event / scalar-tick medians (milliseconds)");
for (const workload of workloads) {
    console.log(`\n${workload.title}`);
    for (const lane of ["generic", "scalar"]) {
        const value = workload[lane];
        console.log(
            `  ${lane.padEnd(7)} marshal=${value.timings.marshalMs.median.toFixed(4)} ` +
                `execute=${value.timings.executeMs.median.toFixed(4)} ` +
                `decode=${value.timings.decodeMs.median.toFixed(4)} ` +
                `total=${value.timings.totalMs.median.toFixed(4)}`,
        );
    }
    console.log(
        `  scalar/generic total=${workload.ratios.total.toFixed(3)}× ` +
            `delta=${(workload.deltasMs.total * 1000).toFixed(1)} µs`,
    );
}
console.log(`\nwrote ${outputUrl.pathname}`);
