import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import vm from "node:vm";

import {
    normalizeVirTraceResult,
    prepareVirPlayerAnimation,
    prepareVirPlayerEvents,
} from "./lib/vir-player-trace.mjs";
import {
    projectVirSelectionAnimation,
    projectVirSelectionEvent,
} from "../player_js/vir_selection_player.js";

import { createIlluminatePlayerAdapter } from "../test_output/native/illuminate-player-browser-adapter.mjs";
import {
    createVirRuntime,
    IR_PACKAGE_SET_FORMAT,
    IR_PACKAGE_SET_VERSION,
} from "../test_output/vir/sdk/js/vir-runtime-node.js";

const coreSource = await readFile(new URL("../player_js/anim_core.js", import.meta.url), "utf8");
const core = vm.createContext({});
vm.runInContext(coreSource, core);

const {
    animCheckPauseSteps,
    animClampFrame,
    animComputeFrame,
    animFindCurrentStep,
    animFindSegment,
    animFindStepEnd,
    animWrapLoop,
} = core;

class LegacyPlayerOracle {
    constructor(data) {
        this.data = data;
        this.frame = 0;
        this.currentStep = 0;
        this.startTime = null;
        this.pauseFrame = 0;
        this.playing = false;
        this.waitingForClick = false;
        this.advancePending = false;
        this.finished = false;
        this.currentSegment = -1;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    playback() {
        if (this.waitingForClick) return "waiting";
        if (this.finished) return "finished";
        if (!this.playing) return "paused";
        if (this.advancePending) return "finishingLoop";
        if (this.targetFrame !== null) return "playing";
        if (this.data.steps[this.currentStep]?.loop) return "looping";
        return "playing";
    }

    action() {
        this.frame = animClampFrame(this.frame, this.data.totalFrames);
        const segmentValue = animFindSegment(this.data.segments, this.frame);
        const segment = this.data.segments.indexOf(segmentValue);
        const localFrame = this.frame - segmentValue.sf;
        const segmentChanged = segment !== this.currentSegment;
        this.currentSegment = segment;
        const values = segmentValue.params[localFrame] ?? [];
        const updates = segmentValue.pmap.flatMap((binding, index) =>
            values[index] === undefined ? [] : [{ e: binding.e, a: binding.a, v: values[index] }],
        );
        return {
            frame: this.frame,
            step: this.currentStep,
            segment,
            localFrame,
            segmentChanged,
            updates,
            playback: this.playback(),
        };
    }

    advance() {
        if (this.waitingForClick) {
            this.waitingForClick = false;
            this.startTime = null;
            this.playing = true;
            this.finished = false;
            this.targetFrame = null;
            this.loopAfterTarget = false;
            return;
        }
        if (this.playing) {
            const step = this.data.steps[this.currentStep];
            if (step?.loop && this.currentStep + 1 < this.data.steps.length) {
                this.advancePending = true;
            } else {
                this.playing = false;
                this.pauseFrame = this.frame;
                this.targetFrame = null;
                this.loopAfterTarget = false;
            }
            return;
        }
        if (this.pauseFrame >= this.data.totalFrames - 1) {
            this.pauseFrame = 0;
            this.currentStep = 0;
            this.frame = 0;
        }
        this.playing = true;
        this.startTime = null;
        this.finished = false;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    pause() {
        this.startTime = null;
        this.pauseFrame = this.frame;
        this.playing = false;
        this.waitingForClick = false;
        this.advancePending = false;
        this.finished = false;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    seek(requested) {
        this.playing = false;
        this.waitingForClick = false;
        this.advancePending = false;
        this.frame = animClampFrame(requested, this.data.totalFrames);
        this.pauseFrame = this.frame;
        this.currentStep = animFindCurrentStep(this.data.steps, this.frame);
        this.finished = this.frame === this.data.totalFrames - 1;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    loopAt(requested) {
        const frame = animClampFrame(requested, this.data.totalFrames);
        const step = animFindCurrentStep(this.data.steps, frame);
        const stepInfo = this.data.steps[step];
        if (!stepInfo?.loop) {
            this.seek(frame);
            return;
        }
        this.frame = stepInfo.frame;
        this.currentStep = step;
        this.startTime = null;
        this.pauseFrame = stepInfo.frame;
        this.playing = true;
        this.waitingForClick = false;
        this.advancePending = false;
        this.finished = false;
        this.targetFrame = null;
        this.loopAfterTarget = false;
    }

    playTo(requested, loopAfter) {
        const target = animClampFrame(requested, this.data.totalFrames);
        if (target === this.frame) {
            if (loopAfter) this.loopAt(target);
            else this.pause();
            return;
        }
        this.currentStep = animFindCurrentStep(this.data.steps, this.frame);
        this.startTime = null;
        this.pauseFrame = this.frame;
        this.playing = true;
        this.waitingForClick = false;
        this.advancePending = false;
        this.finished = false;
        this.targetFrame = target;
        this.loopAfterTarget = loopAfter;
    }

    tick(timestamp) {
        if (!this.playing || this.waitingForClick) return;
        if (this.targetFrame !== null) {
            if (this.startTime === null) this.startTime = timestamp;
            const elapsed = animComputeFrame(this.startTime, timestamp, this.data.fps, 0);
            const target = this.targetFrame;
            const forward = target >= this.pauseFrame;
            this.frame = forward
                ? Math.min(target, this.pauseFrame + elapsed)
                : this.pauseFrame - Math.min(elapsed, this.pauseFrame - target);
            this.currentStep = animFindCurrentStep(this.data.steps, this.frame);
            if (this.frame === target) {
                const loopAfter = this.loopAfterTarget;
                this.startTime = null;
                this.pauseFrame = this.frame;
                this.playing = false;
                this.targetFrame = null;
                this.loopAfterTarget = false;
                if (loopAfter) this.loopAt(this.frame);
            }
            return;
        }
        if (this.startTime === null) this.startTime = timestamp;
        let frame = animComputeFrame(this.startTime, timestamp, this.data.fps, this.pauseFrame);
        const stepInfo = this.data.steps[this.currentStep];
        let isLooping = Boolean(stepInfo?.loop);
        if (isLooping) {
            const stepStart = stepInfo.frame;
            const stepEnd = animFindStepEnd(
                this.data.steps,
                this.currentStep,
                this.data.totalFrames,
            );
            const loop = animWrapLoop(frame, stepStart, stepEnd);
            if (loop.didCycle) {
                if (this.advancePending) {
                    this.advancePending = false;
                    if (this.currentStep + 1 < this.data.steps.length) {
                        this.currentStep += 1;
                        frame = this.data.steps[this.currentStep].frame;
                        this.pauseFrame = frame;
                        this.startTime = null;
                        isLooping = false;
                    }
                } else {
                    frame = loop.wrapped;
                    this.startTime = timestamp;
                    this.pauseFrame = stepStart;
                }
            }
        }
        if (frame >= this.data.totalFrames) {
            frame = this.data.totalFrames - 1;
            this.pauseFrame = frame;
            this.playing = false;
            this.finished = true;
        }
        if (!isLooping) {
            const pause = animCheckPauseSteps(this.data.steps, this.currentStep, frame);
            if (pause !== null) {
                frame = pause.pauseAtFrame;
                this.pauseFrame = frame;
                this.waitingForClick = true;
                this.currentStep = pause.pauseAtStep;
                this.frame = frame;
                return;
            }
            this.currentStep = animFindCurrentStep(this.data.steps, frame);
        }
        this.frame = frame;
    }

    dispatch(event) {
        if (event.kind === "advance") this.advance();
        else if (event.kind === "pause") this.pause();
        else if (event.kind === "seek") this.seek(event.frame);
        else if (event.kind === "playTo") this.playTo(event.frame, event.loopAfter);
        else if (event.kind === "loopAt") this.loopAt(event.frame);
        else if (event.kind === "tick") this.tick(event.timestamp);
        else throw new Error(`unknown oracle event: ${event.kind}`);
        return this.action();
    }
}

function segment(start, count, binding = { e: 2, a: "opacity" }) {
    return {
        sf: start,
        fc: count,
        sync: `<svg data-segment="${start}"><text data-e="${binding.e}"></text></svg>`,
        pmap: [binding],
        params: Array.from({ length: count }, (_, frame) => [`${start + frame}`]),
    };
}

function animation(totalFrames, steps, segments = [segment(0, totalFrames)]) {
    return { fps: 10, totalFrames, segments, steps };
}

const cases = [
    {
        name: "exact pause boundary",
        data: animation(12, [
            { frame: 0, pause: false, loop: false },
            { frame: 5, pause: true, loop: false },
        ]),
        events: [
            { kind: "advance" },
            { kind: "tick", timestamp: 100 },
            { kind: "tick", timestamp: 599.9 },
        ],
    },
    {
        name: "large timestamp jump",
        data: animation(10, [{ frame: 0, pause: false, loop: false }]),
        events: [
            { kind: "advance" },
            { kind: "tick", timestamp: 0 },
            { kind: "tick", timestamp: 5000 },
        ],
    },
    {
        name: "loop overshoot and exit",
        data: animation(20, [
            { frame: 0, pause: false, loop: true },
            { frame: 10, pause: false, loop: false },
        ]),
        events: [
            { kind: "advance" },
            { kind: "tick", timestamp: 0 },
            { kind: "tick", timestamp: 1150 },
            { kind: "advance" },
            { kind: "tick", timestamp: 2150 },
        ],
    },
    {
        name: "end seek and replay",
        data: animation(10, [{ frame: 0, pause: false, loop: false }]),
        events: [
            { kind: "seek", frame: 99 },
            { kind: "advance" },
            { kind: "tick", timestamp: 1000 },
            { kind: "tick", timestamp: 1100 },
        ],
    },
    {
        name: "segment and text patches",
        data: animation(
            4,
            [{ frame: 0, pause: false, loop: false }],
            [segment(0, 2), segment(2, 2, { e: 7, a: "textContent" })],
        ),
        events: [
            { kind: "seek", frame: 1 },
            { kind: "seek", frame: 2 },
            { kind: "seek", frame: 3 },
        ],
    },
    {
        name: "directed playback and explicit loop controls",
        data: animation(12, [
            { frame: 0, pause: false, loop: false },
            { frame: 5, pause: true, loop: true },
        ]),
        events: [
            { kind: "playTo", frame: 5, loopAfter: true },
            { kind: "tick", timestamp: 0 },
            { kind: "tick", timestamp: 500 },
            { kind: "pause" },
            { kind: "loopAt", frame: 5 },
            { kind: "tick", timestamp: 1000 },
            { kind: "tick", timestamp: 1200 },
            { kind: "playTo", frame: 2, loopAfter: false },
            { kind: "tick", timestamp: 1300 },
            { kind: "tick", timestamp: 1800 },
        ],
    },
];

let randomState = 0x1_11_04_28;
function random() {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return randomState / 0x1_0000_0000;
}

function randomCuts(totalFrames, maximumCuts) {
    const values = new Set([0]);
    const count = Math.min(maximumCuts, totalFrames);
    while (values.size < count) values.add(Math.floor(random() * totalFrames));
    return [...values].sort((left, right) => left - right);
}

for (let caseIndex = 0; caseIndex < 100; caseIndex += 1) {
    const totalFrames = 1 + Math.floor(random() * 30);
    const segmentCuts = randomCuts(totalFrames, 1 + Math.floor(random() * 5));
    const segments = segmentCuts.map((start, index) => {
        const end = segmentCuts[index + 1] ?? totalFrames;
        const binding =
            index % 2 === 0 ? { e: index + 1, a: "opacity" } : { e: index + 1, a: "textContent" };
        return segment(start, end - start, binding);
    });
    const stepCuts = randomCuts(totalFrames, 1 + Math.floor(random() * 6));
    const steps = stepCuts.map((frame) => {
        const flag = Math.floor(random() * 4);
        return { frame, pause: flag === 1, loop: flag === 2 };
    });
    const events = [];
    let timestamp = Math.floor(random() * 1000);
    for (let eventIndex = 0; eventIndex < 30; eventIndex += 1) {
        const choice = random();
        if (choice < 0.25) {
            events.push({ kind: "advance" });
        } else if (choice < 0.45) {
            events.push({ kind: "seek", frame: Math.floor(random() * (totalFrames + 8)) });
        } else {
            timestamp += random() * 2000;
            events.push({ kind: "tick", timestamp });
        }
    }
    cases.push({
        name: `generated trace ${caseIndex}`,
        data: animation(totalFrames, steps, segments),
        events,
    });
}

const wasmBytes = await readFile(
    new URL("../test_output/vir/sdk/wasm/vir-upstream.wasm", import.meta.url),
);
const packageSetUrl = new URL(
    "../test_output/vir/module-sets/Illuminate/Animation/Vir.irpkg-set.json",
    import.meta.url,
);
const packageSet = JSON.parse(await readFile(packageSetUrl, "utf8"));
assert.equal(packageSet.format, IR_PACKAGE_SET_FORMAT);
assert.equal(packageSet.version, IR_PACKAGE_SET_VERSION);
assert.ok(Array.isArray(packageSet.packages) && packageSet.packages.length > 0);
const irPackageSetBytes = await Promise.all(
    packageSet.packages.map((member) => readFile(new URL(member.path, packageSetUrl))),
);
const runtime = await createVirRuntime({ wasmBytes, irPackageSetBytes });
const nativeWasmBytes = await readFile(
    new URL("../test_output/native/illuminate-player.wasm", import.meta.url),
);
const nativeManifest = JSON.parse(
    await readFile(
        new URL("../test_output/native/illuminate-player.wasm.json", import.meta.url),
        "utf8",
    ),
);
const nativeBuild = JSON.parse(
    await readFile(new URL("../test_output/native/BUILD.json", import.meta.url), "utf8"),
);
assert.equal(nativeBuild.schemaVersion, "fir.illuminate-player.build/v1");
assert.equal(nativeBuild.wasm.functionImportCount, 0);
assert.equal(nativeBuild.wasm.memoryImportCount, 0);
assert.equal(createHash("sha256").update(nativeWasmBytes).digest("hex"), nativeBuild.wasm.sha256);
const native = await createIlluminatePlayerAdapter({
    bytes: nativeWasmBytes,
    manifest: nativeManifest,
    build: nativeBuild,
});
const selectionRoot = new URL("../test_output/fir-live/", import.meta.url);
let selection = null;
try {
    await access(new URL("BUILD.json", selectionRoot));
    const [
        { createIlluminateSelectionPlayerAdapter },
        selectionWasmBytes,
        selectionManifestText,
        selectionBuildText,
    ] = await Promise.all([
        import(new URL("illuminate-selection-player-browser-adapter.mjs", selectionRoot).href),
        readFile(new URL("illuminate-selection-player.wasm", selectionRoot)),
        readFile(new URL("illuminate-selection-player.wasm.json", selectionRoot), "utf8"),
        readFile(new URL("BUILD.json", selectionRoot), "utf8"),
    ]);
    const selectionManifest = JSON.parse(selectionManifestText);
    const selectionBuild = JSON.parse(selectionBuildText);
    assert.equal(selectionBuild.schemaVersion, "fir.illuminate-selection-player.build/v1");
    assert.equal(selectionBuild.wasm.functionImportCount, 0);
    assert.equal(selectionBuild.wasm.memoryImportCount, 0);
    assert.equal(
        createHash("sha256").update(selectionWasmBytes).digest("hex"),
        selectionBuild.wasm.sha256,
    );
    selection = await createIlluminateSelectionPlayerAdapter({
        bytes: selectionWasmBytes,
        manifest: selectionManifest,
        build: selectionBuild,
    });
} catch (error) {
    if (error?.code !== "ENOENT") throw error;
}

function materializeSelections(data, actions) {
    return actions.map((action) => {
        const segment = data.segments[action.segment];
        assert.ok(segment, `selection chose missing segment ${action.segment}`);
        const values = segment.params[action.localFrame];
        assert.ok(values, `selection chose missing local frame ${action.localFrame}`);
        const updates = segment.pmap.flatMap((binding, index) =>
            values[index] === undefined ? [] : [{ e: binding.e, a: binding.a, v: values[index] }],
        );
        return { ...action, updates };
    });
}

function selectionNat(value, label) {
    const number = typeof value === "number" ? value : Number(value);
    assert.ok(Number.isSafeInteger(number) && number >= 0, `${label} is not a natural number`);
    return number;
}

function normalizeVirSelectionOutput(output, label) {
    assert.equal(
        output.scheduleNextFrame,
        ["playing", "looping", "finishingLoop"].includes(output.action.playback),
        `${label} scheduling decision`,
    );
    return {
        frame: selectionNat(output.action.frame, `${label}.frame`),
        step: selectionNat(output.action.step, `${label}.step`),
        segment: selectionNat(output.action.segment, `${label}.segment`),
        localFrame: selectionNat(output.action.localFrame, `${label}.localFrame`),
        segmentChanged: output.action.segmentChanged,
        playback: output.action.playback,
    };
}

function replayVirSelections(data, events) {
    const mounted = runtime.call(
        "Illuminate.Animation.Vir.mountSelectionPlayer",
        projectVirSelectionAnimation(data),
    );
    assert.equal(mounted.kind, "ok", mounted.value);
    const handle = mounted.value;
    try {
        const actions = [
            normalizeVirSelectionOutput(
                runtime.call("Illuminate.Animation.Vir.selectionPlayerSnapshot", handle),
                "VIR selection initial",
            ),
        ];
        for (const [index, event] of events.entries()) {
            actions.push(
                normalizeVirSelectionOutput(
                    runtime.call(
                        "Illuminate.Animation.Vir.dispatchSelectionPlayer",
                        handle,
                        projectVirSelectionEvent(event),
                    ),
                    `VIR selection event ${index}`,
                ),
            );
        }
        return actions;
    } finally {
        runtime.call("Illuminate.Animation.Vir.disposeSelectionPlayer", handle);
    }
}

try {
    for (const testCase of cases) {
        const oracle = new LegacyPlayerOracle(testCase.data);
        const expected = [
            oracle.action(),
            ...testCase.events.map((event) => oracle.dispatch(event)),
        ];
        const jsonResult = JSON.parse(
            runtime.call(
                "Illuminate.Animation.Vir.replayTrace",
                JSON.stringify(testCase.data),
                JSON.stringify(testCase.events),
            ),
        );
        assert.equal(jsonResult.ok, true, jsonResult.error);
        assert.deepEqual(jsonResult.actions, expected, `${testCase.name} (VIR JSON)`);
        const typedResult = normalizeVirTraceResult(
            runtime.call(
                "Illuminate.Animation.Vir.replayTraceTyped",
                prepareVirPlayerAnimation(testCase.data),
                prepareVirPlayerEvents(testCase.events),
            ),
        );
        assert.equal(typedResult.ok, true, typedResult.error);
        assert.deepEqual(typedResult.actions, expected, `${testCase.name} (VIR typed)`);
        assert.deepEqual(
            materializeSelections(
                testCase.data,
                replayVirSelections(testCase.data, testCase.events),
            ),
            expected,
            `${testCase.name} (VIR selection)`,
        );
        const nativeResult = native.replayTrace(testCase.data, testCase.events);
        assert.equal(nativeResult.ok, true, nativeResult.error);
        assert.deepEqual(nativeResult.actions, expected, testCase.name);
        if (selection !== null) {
            const selectionResult = selection.replayTrace(testCase.data, testCase.events);
            assert.equal(selectionResult.ok, true, selectionResult.error);
            assert.deepEqual(
                materializeSelections(testCase.data, selectionResult.actions),
                expected,
                `${testCase.name} (FIR selection)`,
            );
        }
    }

    const invalidTypedResult = normalizeVirTraceResult(
        runtime.call(
            "Illuminate.Animation.Vir.replayTraceTyped",
            prepareVirPlayerAnimation({ ...cases[0].data, totalFrames: 0 }),
            [],
        ),
    );
    assert.deepEqual(invalidTypedResult, {
        ok: false,
        error: "animation must contain at least one frame",
    });
    const invalidSelectionResult = runtime.call(
        "Illuminate.Animation.Vir.mountSelectionPlayer",
        projectVirSelectionAnimation({ ...cases[0].data, totalFrames: 0 }),
    );
    assert.deepEqual(invalidSelectionResult, {
        kind: "error",
        value: "animation must contain at least one frame",
    });
    const compact = projectVirSelectionAnimation(cases[0].data);
    const left = runtime.call("Illuminate.Animation.Vir.mountSelectionPlayer", compact);
    const right = runtime.call("Illuminate.Animation.Vir.mountSelectionPlayer", compact);
    assert.equal(left.kind, "ok");
    assert.equal(right.kind, "ok");
    runtime.call(
        "Illuminate.Animation.Vir.dispatchSelectionPlayer",
        left.value,
        projectVirSelectionEvent({ kind: "seek", frame: 3 }),
    );
    assert.equal(
        selectionNat(
            runtime.call("Illuminate.Animation.Vir.selectionPlayerSnapshot", left.value).action
                .frame,
            "left isolated frame",
        ),
        3,
    );
    assert.equal(
        selectionNat(
            runtime.call("Illuminate.Animation.Vir.selectionPlayerSnapshot", right.value).action
                .frame,
            "right isolated frame",
        ),
        0,
    );
    runtime.call("Illuminate.Animation.Vir.disposeSelectionPlayer", left.value);
    runtime.call("Illuminate.Animation.Vir.disposeSelectionPlayer", right.value);
    assert.throws(
        () => runtime.call("Illuminate.Animation.Vir.selectionPlayerSnapshot", left.value),
        /released|resource|handle/i,
    );
} finally {
    runtime.dispose();
}

const backends = `legacy/VIR-JSON/VIR-typed/VIR-selection/FIR-native${selection === null ? "" : "/FIR-selection"}`;
console.log(`${cases.length} ${backends} player traces matched`);
