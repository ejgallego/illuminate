import assert from "node:assert/strict";

import {
    createFirDomRenderer,
    createFirLivePlayerHost,
    createFirSelectionDomRenderer,
    createSelectionPlayerHost,
} from "../player_js/fir_live_player.js";

assert.equal(createFirLivePlayerHost, createSelectionPlayerHost);

function action({
    frame = 0,
    segment = 0,
    segmentChanged = false,
    playback = "paused",
    updates = [],
} = {}) {
    return {
        frame,
        step: 0,
        segment,
        localFrame: frame,
        segmentChanged,
        updates,
        playback,
    };
}

function fakeScheduler() {
    let nextHandle = 1;
    const callbacks = new Map();
    const cancelled = [];
    return {
        request(callback) {
            const handle = nextHandle++;
            callbacks.set(handle, callback);
            return handle;
        },
        cancel(handle) {
            cancelled.push(handle);
            callbacks.delete(handle);
        },
        fire(handle, timestamp) {
            const callback = callbacks.get(handle);
            assert.ok(callback, `missing callback ${handle}`);
            callbacks.delete(handle);
            callback(timestamp);
        },
        callbacks,
        cancelled,
    };
}

const animation = {
    fps: 60,
    totalFrames: 2,
    segments: [
        {
            sf: 0,
            fc: 1,
            sync: "segment-zero",
            pmap: [],
            params: [],
        },
        {
            sf: 1,
            fc: 1,
            sync: "segment-one",
            pmap: [],
            params: [],
        },
    ],
    steps: [{ frame: 0, pause: false, loop: false }],
};

const dispatched = [];
const dispatchedTicks = [];
const disposed = [];
const handle = Object.freeze({ id: 17 });
const responses = [
    { action: action({ playback: "playing" }), scheduleNextFrame: true },
    {
        action: action({
            frame: 1,
            segment: 1,
            segmentChanged: true,
            playback: "playing",
        }),
        scheduleNextFrame: true,
    },
    { action: action({ frame: 1 }), scheduleNextFrame: false },
    { action: action(), scheduleNextFrame: false },
];
const adapter = {
    createPlayer(value) {
        assert.equal(value, animation);
        return {
            ok: true,
            player: handle,
            action: action(),
            scheduleNextFrame: false,
        };
    },
    dispatch(player, event) {
        assert.equal(player, handle);
        dispatched.push(event);
        const response = responses.shift();
        assert.ok(response, `unexpected ${event.kind} event`);
        return { ok: true, ...response };
    },
    dispatchTick(player, timestamp) {
        assert.equal(player, handle);
        dispatchedTicks.push(timestamp);
        const response = responses.shift();
        assert.ok(response, "unexpected tick event");
        return { ok: true, ...response };
    },
    disposePlayer(player) {
        disposed.push(player);
    },
};
const rendered = [];
let rendererDisposed = 0;
const renderer = {
    render(value) {
        rendered.push(value);
    },
    dispose() {
        rendererDisposed += 1;
    },
};
const scheduler = fakeScheduler();
const observations = [];
const host = createFirLivePlayerHost(adapter, animation, renderer, scheduler, (observation) => {
    observations.push(observation);
});
assert.equal(rendered.length, 1);
assert.equal(scheduler.callbacks.size, 0);

host.advance();
assert.deepEqual(dispatched[0], { kind: "advance" });
assert.deepEqual([...scheduler.callbacks.keys()], [1]);
scheduler.fire(1, 123.125);
assert.deepEqual(dispatchedTicks, [123.125]);
assert.deepEqual([...scheduler.callbacks.keys()], [2]);
assert.equal(host.snapshot().segment, 1);

host.pause();
assert.deepEqual(dispatched[1], { kind: "pause" });
assert.deepEqual(scheduler.cancelled, [2]);
assert.equal(scheduler.callbacks.size, 0);
host.seek(0);
assert.deepEqual(dispatched[2], { kind: "seek", frame: 0 });
assert.equal(host.snapshot().frame, 0);

host.dispose();
host.dispose();
assert.deepEqual(disposed, [handle]);
assert.equal(rendererDisposed, 1);
assert.throws(() => host.advance(), /disposed/);
assert.deepEqual(
    observations.map(({ kind, operation }) => ({ kind, operation })),
    [
        { kind: "create", operation: "create" },
        { kind: "dispatch", operation: "advance" },
        { kind: "dispatch", operation: "tick" },
        { kind: "dispatch", operation: "pause" },
        { kind: "dispatch", operation: "seek" },
    ],
);
assert.ok(observations.every(({ renderMs, totalMs }) => renderMs >= 0 && totalMs >= renderMs));

function fakeElement(index) {
    return {
        textContent: "",
        attributes: new Map(),
        getAttribute(name) {
            return name === "data-e" ? String(index) : (this.attributes.get(name) ?? null);
        },
        setAttribute(name, value) {
            this.attributes.set(name, value);
        },
    };
}

const element0 = fakeElement(0);
const element2 = fakeElement(2);
const container = {
    innerHTML: "",
    querySelectorAll(selector) {
        assert.equal(selector, "[data-e]");
        return [element0, element2];
    },
};
const domRenderer = createFirDomRenderer(animation, container);
domRenderer.render(
    action({
        segmentChanged: true,
        updates: [
            { e: 0, a: "textContent", v: "Lean" },
            { e: 2, a: "fill", v: "#5b8cff" },
        ],
    }),
);
assert.equal(container.innerHTML, "segment-zero");
assert.equal(element0.textContent, "Lean");
assert.equal(element2.attributes.get("fill"), "#5b8cff");
assert.throws(
    () => domRenderer.render(action({ updates: [{ e: 9, a: "opacity", v: "0.5" }] })),
    /missing data-e=9/,
);

const selectionAnimation = {
    ...animation,
    segments: [
        {
            sf: 0,
            fc: 1,
            sync: "selection-segment-zero",
            pmap: [
                { e: 0, a: "textContent" },
                { e: 2, a: "fill" },
            ],
            params: [["Selected by Lean", "#15a66f"]],
        },
    ],
};
const selectionRenderer = createFirSelectionDomRenderer(selectionAnimation, container);
selectionRenderer.render(action({ segmentChanged: true }));
assert.equal(container.innerHTML, "selection-segment-zero");
assert.equal(element0.textContent, "Selected by Lean");
assert.equal(element2.attributes.get("fill"), "#15a66f");
assert.throws(
    () => selectionRenderer.render({ ...action(), localFrame: 1 }),
    /invalid local frame 1/,
);

console.log("FIR live host contract passed");
