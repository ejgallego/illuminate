import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { createVirRuntime as createControlRuntime } from "../test_output/vir-control-5202-normalizer/sdk/js/vir-runtime-node.js";
import { createVirRuntime as createCandidateRuntime } from "../test_output/vir/sdk/js/vir-runtime-node.js";
import {
    normalizeVirTraceResult,
    prepareVirPlayerAnimation,
    prepareVirPlayerEvents,
} from "./lib/vir-player-trace.mjs";

const warmupRounds = 2;
const sampleRounds = 12;
const focusedEvents = process.argv.includes("--focused-events");
const batchSize = focusedEvents ? 1 : 7;
const exampleTitle = focusedEvents ? "Pause-driven slide show" : "Morphing arrows and final loop";
const entry = "Illuminate.Animation.Vir.replayTraceTyped";

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function summarize(samples) {
    const phaseNames = Object.keys(samples[0].timings);
    return {
        wallMedianMs: median(samples.map((sample) => sample.wallMs)),
        phaseMedians: Object.fromEntries(
            phaseNames.map((name) => [name, median(samples.map((sample) => sample.timings[name]))]),
        ),
    };
}

function pairedDeltas(controlSamples, candidateSamples) {
    const phaseNames = ["wallMs", ...Object.keys(controlSamples[0].timings)];
    return Object.fromEntries(
        phaseNames.map((name) => {
            const values = controlSamples.map((control, index) => {
                const baseline = name === "wallMs" ? control.wallMs : control.timings[name];
                const candidate =
                    name === "wallMs"
                        ? candidateSamples[index].wallMs
                        : candidateSamples[index].timings[name];
                if (baseline === 0) return candidate === 0 ? 0 : null;
                return ((candidate - baseline) / baseline) * 100;
            });
            const finiteValues = values.filter((value) => value !== null);
            return [
                name,
                {
                    medianPercent: finiteValues.length === 0 ? null : median(finiteValues),
                    samplesPercent: values,
                },
            ];
        }),
    );
}

function traceChecksum(result) {
    return Number.parseInt(sha256(JSON.stringify(result)).slice(0, 12), 16);
}

function gitOutput(args) {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
}

async function readPackageSet() {
    const packageSetUrl = new URL(
        "../test_output/vir/module-sets/Illuminate/Animation/Vir.irpkg-set.json",
        import.meta.url,
    );
    const descriptorBytes = await readFile(packageSetUrl);
    const descriptor = JSON.parse(descriptorBytes.toString("utf8"));
    const members = await Promise.all(
        descriptor.packages.map((member) => readFile(new URL(member.path, packageSetUrl))),
    );
    return { descriptorBytes, members };
}

async function readRepresentativeInput() {
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
    const examples = JSON.parse(html.slice(jsonStart, jsonEnd));
    const example = examples.find(({ title }) => title === exampleTitle);
    assert.ok(example, `missing comparison example ${exampleTitle}`);

    const events = focusedEvents
        ? Array.from({ length: 4096 }, () => ({ kind: "advance" }))
        : [
              { kind: "playTo", frame: example.data.totalFrames - 1, loopAfter: true },
              ...Array.from({ length: 29 }, (_, index) => ({
                  kind: "tick",
                  timestamp: 1000 + index * (1000 / 60),
              })),
          ];
    return {
        animation: prepareVirPlayerAnimation(example.data),
        events: prepareVirPlayerEvents(events),
    };
}

async function measureVariant(variant, runtimeInputs, input) {
    const runtime = await variant.createRuntime(runtimeInputs);
    try {
        const calls = [];
        let result = null;
        for (let index = 0; index < batchSize; index += 1) {
            const started = performance.now();
            const observation = runtime.callTimed(entry, input.animation, input.events);
            calls.push({
                wallMs: performance.now() - started,
                timings: observation.timings,
            });
            const decoded = normalizeVirTraceResult(observation.value);
            assert.equal(decoded.ok, true, decoded.error);
            if (result === null) result = decoded;
            else assert.deepEqual(decoded, result, `${variant.id} batch result mismatch`);
        }
        assert.notEqual(result, null);
        const phaseNames = Object.keys(calls[0].timings);
        return {
            wallMs: median(calls.map((call) => call.wallMs)),
            timings: Object.fromEntries(
                phaseNames.map((name) => [name, median(calls.map((call) => call.timings[name]))]),
            ),
            checksum: traceChecksum(result),
            result,
        };
    } finally {
        runtime.dispose();
    }
}

const wasmPath = new URL("../test_output/vir/sdk/wasm/vir-upstream.wasm", import.meta.url);
const wasmBytes = await readFile(wasmPath);
const packageSet = await readPackageSet();
const input = await readRepresentativeInput();
const runtimeInputs = { wasmBytes, irPackageSetBytes: packageSet.members };
const variants = [
    {
        id: "control-5202-normalizer",
        createRuntime: (inputs) => createControlRuntime(inputs),
    },
    {
        id: "candidate-main-normalizer",
        createRuntime: (inputs) => createCandidateRuntime(inputs),
    },
];
const observations = Object.fromEntries(variants.map(({ id }) => [id, []]));
let expectedResult = null;

for (let round = -warmupRounds; round < sampleRounds; round += 1) {
    const measured = round >= 0;
    const order = round % 2 === 0 ? variants : [...variants].reverse();
    for (const variant of order) {
        const observation = await measureVariant(variant, runtimeInputs, input);
        if (expectedResult === null) {
            expectedResult = observation.result;
        } else {
            assert.deepEqual(observation.result, expectedResult, `${variant.id} result mismatch`);
        }
        if (measured) {
            observations[variant.id].push({
                round,
                order: order.map(({ id }) => id),
                wallMs: observation.wallMs,
                timings: observation.timings,
                checksum: observation.checksum,
            });
        }
    }
}

const controlSamples = observations[variants[0].id];
const candidateSamples = observations[variants[1].id];
const controlNormalizer = await readFile(
    new URL(
        "../test_output/vir-control-5202-normalizer/sdk/js/runtime/vir-value-normalizers.js",
        import.meta.url,
    ),
);
const candidateNormalizer = await readFile(
    new URL("../test_output/vir/sdk/js/runtime/vir-value-normalizers.js", import.meta.url),
);
const controlCodec = await readFile(
    new URL(
        "../test_output/vir-control-5202-normalizer/sdk/js/runtime/vir-codec.js",
        import.meta.url,
    ),
);
const candidateCodec = await readFile(
    new URL("../test_output/vir/sdk/js/runtime/vir-codec.js", import.meta.url),
);
const report = {
    schema: "illuminate.vir-call-phases/v1",
    generatedAt: new Date().toISOString(),
    workload: {
        class: focusedEvents ? "focused-custom-inductive" : "representative-boundary",
        exampleTitle,
        entry,
        warmupRounds,
        sampleRounds,
        batchSize,
        batchAggregation: "median per call",
        freshRuntimePerObservation: true,
        runtimeSetupTimed: false,
        projectionTimed: false,
        actionNormalizationTimed: false,
        animationSha256: sha256(JSON.stringify(input.animation)),
        eventsSha256: sha256(JSON.stringify(input.events)),
        animationJsonBytes: Buffer.byteLength(JSON.stringify(input.animation)),
        eventCount: input.events.length,
    },
    identity: {
        illuminateHead: gitOutput(["rev-parse", "HEAD"]),
        virCandidateHead: gitOutput(["-C", "vir", "rev-parse", "HEAD"]),
        virMainBase: "6c7e6d2510402d7a104135036ae75fcab30db91e",
        virControlBase: "5202d2743ebc9a27f63d52f0a4317841748f0e5d",
        timedCallHead: "686aa24b1f7f4136b771bb85a8fd814c1da00c71",
        wasmSha256: sha256(wasmBytes),
        packageSetDescriptorSha256: sha256(packageSet.descriptorBytes),
        packageMemberSha256: packageSet.members.map(sha256),
        controlNormalizerSha256: sha256(controlNormalizer),
        candidateNormalizerSha256: sha256(candidateNormalizer),
        controlCodecSha256: sha256(controlCodec),
        candidateCodecSha256: sha256(candidateCodec),
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        arch: process.arch,
    },
    endpoint: {
        parity: true,
        checksum: controlSamples[0].checksum,
        actionCount: expectedResult.actions.length,
    },
    observations,
    summaries: {
        [variants[0].id]: summarize(controlSamples),
        [variants[1].id]: summarize(candidateSamples),
        pairedCandidateDelta: pairedDeltas(controlSamples, candidateSamples),
    },
};

const outputUrl = new URL(
    focusedEvents
        ? "../test_output/perf/vir-main-call-phases-focused-events.json"
        : "../test_output/perf/vir-main-call-phases.json",
    import.meta.url,
);
await mkdir(new URL(".", outputUrl), { recursive: true });
await writeFile(outputUrl, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.summaries, null, 2));
console.log(`wrote ${outputUrl.pathname}`);
