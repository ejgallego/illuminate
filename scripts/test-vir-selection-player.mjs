import assert from "node:assert/strict";

import {
    createVirSelectionPlayerHost,
    projectVirSelectionAnimation,
} from "../player_js/vir_selection_player.js";

const animation = {
    fps: 20,
    totalFrames: 3,
    segments: [
        {
            sf: 0,
            fc: 3,
            get sync() {
                throw new Error("selection projection read sync");
            },
            get pmap() {
                throw new Error("selection projection read pmap");
            },
            get params() {
                throw new Error("selection projection read params");
            },
        },
    ],
    steps: [{ frame: 0, pause: false, loop: false }],
};

assert.deepEqual(projectVirSelectionAnimation(animation), {
    timeline: {
        fps: 20,
        totalFrames: 3,
        segments: [{ startFrame: 0, frameCount: 3, paramMap: [], params: [] }],
        steps: [{ frame: 0, pause: false, loop: false }],
    },
});

const calls = [];
const handle = { id: 1 };
let frame = 0;
let active = false;
const runtime = {
    call(name, ...args) {
        calls.push({ name, args });
        if (name.endsWith("mountSelectionPlayer")) return { kind: "ok", value: handle };
        if (name.endsWith("selectionPlayerSnapshot")) {
            return { action: selection(), scheduleNextFrame: false };
        }
        if (name.endsWith("dispatchSelectionPlayer")) {
            const event = args[1];
            if (event.kind === "advance") active = true;
            else if (event.kind === "pause") active = false;
            else if (event.kind === "seek") {
                frame = event.value;
                active = false;
            } else if (event.kind === "playTo") {
                frame = event.fields.frame;
                active = event.fields.loopAfter;
            } else if (event.kind === "loopAt") {
                frame = event.value;
                active = true;
            } else if (event.kind === "tick") {
                frame = Math.min(frame + 1, 2);
            }
            return { action: selection(), scheduleNextFrame: active };
        }
        if (name.endsWith("disposeSelectionPlayer")) return undefined;
        throw new Error(`unexpected runtime call: ${name}`);
    },
    callTimed(name, ...args) {
        return {
            value: this.call(name, ...args),
            timings: { marshalMs: 0.01, executeMs: 0.02, decodeMs: 0.01, totalMs: 0.04 },
        };
    },
};

function selection() {
    return {
        frame,
        step: 0,
        segment: 0,
        localFrame: frame,
        segmentChanged: frame === 0,
        playback: active ? "playing" : frame === 2 ? "finished" : "paused",
    };
}

let nextHandle = 1;
const scheduled = new Map();
const cancelled = [];
const scheduler = {
    request(callback) {
        const id = nextHandle++;
        scheduled.set(id, callback);
        return id;
    },
    cancel(id) {
        cancelled.push(id);
        scheduled.delete(id);
    },
};

const rendered = [];
let rendererDisposals = 0;
const observations = [];
const host = createVirSelectionPlayerHost(
    runtime,
    animation,
    {
        render(action) {
            rendered.push(action);
        },
        dispose() {
            rendererDisposals += 1;
        },
    },
    scheduler,
    (observation) => observations.push(observation),
    () => true,
);

assert.deepEqual(host.snapshot(), selection());
assert.equal(rendered.length, 1);
assert.equal(observations[0].kind, "create");

host.advance();
assert.equal(scheduled.size, 1);
const tickCallback = [...scheduled.values()][0];
scheduled.clear();
const timestamp = 50.00000000000001;
tickCallback(timestamp);
assert.equal(calls.at(-1).args[1].kind, "tick");
assert.equal(calls.at(-1).args[1].value, timestamp);
assert.equal(scheduled.size, 1);

host.pause();
assert.equal(scheduled.size, 0);
assert.equal(cancelled.length, 1);
host.seek(2);
host.playTo(1, true);
host.loopAt(0);
assert.deepEqual(
    calls
        .filter((call) => call.name.endsWith("dispatchSelectionPlayer"))
        .slice(-3)
        .map((call) => call.args[1]),
    [
        { kind: "seek", value: 2 },
        { kind: "playTo", fields: { frame: 1, loopAfter: true } },
        { kind: "loopAt", value: 0 },
    ],
);

host.dispose();
host.dispose();
assert.equal(rendererDisposals, 1);
assert.equal(calls.filter((call) => call.name.endsWith("disposeSelectionPlayer")).length, 1);
assert.throws(() => host.snapshot(), /disposed/);
assert.ok(observations.some((observation) => observation.operation === "tick"));

console.log("VIR selection host contract passed");
