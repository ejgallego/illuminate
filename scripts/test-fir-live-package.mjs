import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createFirLivePlayerHost } from "../player_js/fir_live_player.js";

const packageArgument = process.env.ILLUMINATE_FIR_LIVE_PLAYER_DIR;
assert.ok(
    packageArgument,
    "set ILLUMINATE_FIR_LIVE_PLAYER_DIR to an immutable FIR selection-player package",
);

const requestedRoot = path.resolve(packageArgument);
const requestedStat = await lstat(requestedRoot);
assert.equal(
    requestedStat.isSymbolicLink(),
    false,
    "ILLUMINATE_FIR_LIVE_PLAYER_DIR must name an immutable package, not a moving symlink",
);
assert.notEqual(
    path.basename(requestedRoot),
    "illuminate-selection-player-current",
    "use the immutable package directory rather than illuminate-selection-player-current",
);
const packageRoot = await realpath(requestedRoot);
const repositoryRoot = await realpath(new URL("..", import.meta.url));

const filenames = {
    adapter: "illuminate-selection-player-browser-adapter.mjs",
    build: "BUILD.json",
    manifest: "illuminate-selection-player.wasm.json",
    wasm: "illuminate-selection-player.wasm",
};
const [adapterModule, build, manifest, wasmBytes] = await Promise.all([
    import(pathToFileURL(path.join(packageRoot, filenames.adapter)).href),
    readFile(path.join(packageRoot, filenames.build), "utf8").then(JSON.parse),
    readFile(path.join(packageRoot, filenames.manifest), "utf8").then(JSON.parse),
    readFile(path.join(packageRoot, filenames.wasm)),
]);

const {
    createIlluminateSelectionPlayerAdapter,
    ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION,
    ILLUMINATE_SELECTION_PLAYER_INPUT_LAYOUT_VERSION,
    ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION,
} = adapterModule;
assert.equal(typeof createIlluminateSelectionPlayerAdapter, "function");
assert.equal(ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION, "fir.illuminate-player.browser/v4");
assert.equal(
    ILLUMINATE_SELECTION_PLAYER_INPUT_LAYOUT_VERSION,
    "lean-4.32-Illuminate.Animation.SelectionAnimation/v4",
);
assert.equal(
    ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION,
    "fir.illuminate-player.persistent-checkpoint/v2",
);
assert.equal(
    build.capabilities?.browserAdapter?.apiVersion,
    ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION,
);
assert.equal(
    build.capabilities?.inputLayout?.version,
    ILLUMINATE_SELECTION_PLAYER_INPUT_LAYOUT_VERSION,
);
assert.equal(build.capabilities?.ownership?.version, ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION);

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

assert.equal(sha256(wasmBytes), build.wasm.sha256);
const module = new WebAssembly.Module(wasmBytes);
assert.deepEqual(WebAssembly.Module.imports(module), []);
assert.deepEqual(
    WebAssembly.Module.exports(module)
        .filter(({ kind }) => kind === "function")
        .map(({ name }) => name)
        .sort(),
    [
        "Illuminate.AnimationPlayer.initialSelectionLive",
        "Illuminate.AnimationPlayer.transitionSelectionLive",
        "fir_heap_alloc",
        "fir_heap_frontier",
        "fir_heap_rewind",
        "fir_heap_set_frontier",
    ].sort(),
);
assert.deepEqual(
    WebAssembly.Module.exports(module).filter(({ kind }) => kind !== "function"),
    [{ name: "memory", kind: "memory" }],
);

const expectedSources = new Map([
    [
        "src/Illuminate/Animation/Types.lean",
        "97a030fdd3ef718912479343cadf0131616a8a9b458901e963dc3709cf5633a3",
    ],
    [
        "src/Illuminate/Animation/Player.lean",
        "3ed87ac8d6a21c0afb2b00efcde6f5390c47be336c09214c24ead847bdb4f306",
    ],
    [
        "src/Illuminate/Animation/FirLive.lean",
        "941daf939d9faa966aa8fb848b4a8f7ce0525ba6420d3843067e2c97908e2121",
    ],
    [
        "src/Illuminate/Animation/FirSelection.lean",
        "a80771bcc8a4b09db99f004559726654dacc102d9982909ccf863f3d60ed0e83",
    ],
]);
for (const [source, expectedHash] of expectedSources) {
    const localHash = sha256(await readFile(path.join(repositoryRoot, source)));
    assert.equal(localHash, expectedHash, `${source} changed during FIR generation`);
    const packaged = build.sources?.illuminate?.relevantFiles?.find(
        ({ path: candidate }) => candidate === source,
    );
    assert.equal(packaged?.sha256, expectedHash, `${source} is absent from BUILD.json`);
}

const adapter = await createIlluminateSelectionPlayerAdapter({
    bytes: wasmBytes,
    manifest,
    build,
});

const animation = {
    fps: 10,
    totalFrames: 6,
    segments: [
        {
            sf: 0,
            fc: 2,
            sync: '<svg data-segment="attribute"><rect data-e="2"/></svg>',
            pmap: [{ e: 2, a: "opacity" }],
            params: [["0.0"], ["1.0"]],
        },
        {
            sf: 2,
            fc: 4,
            sync: '<svg data-segment="text"><text data-e="7"></text></svg>',
            pmap: [{ e: 7, a: "textContent" }],
            params: [["two"], ["three"], ["four"], ["five"]],
        },
    ],
    steps: [
        { frame: 0, pause: false, loop: false },
        { frame: 2, pause: false, loop: true },
        { frame: 4, pause: false, loop: false },
    ],
};

function materialize(action) {
    const segment = animation.segments[action.segment];
    assert.ok(segment, `selection chose missing segment ${action.segment}`);
    const values = segment.params[action.localFrame];
    assert.ok(values, `selection chose missing local frame ${action.localFrame}`);
    return segment.pmap.flatMap((binding, index) =>
        values[index] === undefined ? [] : [{ e: binding.e, a: binding.a, v: values[index] }],
    );
}

function adjacentFloat(value, direction) {
    assert.ok(Number.isFinite(value) && value > 0);
    const storage = new ArrayBuffer(8);
    const floats = new Float64Array(storage);
    const bits = new BigUint64Array(storage);
    floats[0] = value;
    bits[0] += direction > 0 ? 1n : -1n;
    return floats[0];
}

const events = [
    { kind: "advance" },
    { kind: "tick", timestamp: 0 },
    { kind: "tick", timestamp: adjacentFloat(50, -1) },
    { kind: "tick", timestamp: adjacentFloat(50, 1) },
    { kind: "pause" },
    { kind: "seek", frame: 3 },
    { kind: "playTo", frame: 1, loopAfter: false },
    { kind: "tick", timestamp: 100 },
    { kind: "tick", timestamp: 300 },
    { kind: "loopAt", frame: 2 },
];

const created = adapter.createPlayer(animation);
assert.equal(created.ok, true, created.error);
assert.equal(Object.hasOwn(created.action, "updates"), false);
assert.ok(created.memory.selectionBytes <= 16 * 1024);
assert.ok(created.memory.persistentAllocationCalls <= 400);
assert.equal(created.memory.selectionAllocationCalls, 1);
assert.equal(created.memory.pagesAfter, 1);
const liveActions = [created.action];
const liveSchedules = [created.scheduleNextFrame];
for (const event of events) {
    const dispatched = adapter.dispatch(created.player, event);
    assert.equal(dispatched.ok, true, dispatched.error);
    liveActions.push(dispatched.action);
    assert.equal(Object.hasOwn(dispatched.action, "updates"), false);
    liveSchedules.push(dispatched.scheduleNextFrame);
    assert.equal(dispatched.memory.frontierBefore, dispatched.memory.persistentCheckpoint);
    assert.equal(dispatched.memory.postRewindFrontier, dispatched.memory.persistentCheckpoint);
}
const replayed = adapter.replayTrace(animation, events);
assert.equal(replayed.ok, true, replayed.error);
assert.deepEqual(liveActions, replayed.actions, "live dispatch diverged from replayTrace");
assert.ok(
    liveActions.some((action) => materialize(action).some((update) => update.a === "opacity")),
    "attribute patch target was not materialized",
);
assert.ok(
    liveActions.some((action) => materialize(action).some((update) => update.a === "textContent")),
    "textContent patch target was not materialized",
);
for (let index = 0; index < liveActions.length; index += 1) {
    assert.equal(
        liveSchedules[index],
        ["playing", "looping", "finishingLoop"].includes(liveActions[index].playback),
        `scheduling decision ${index} disagrees with its Lean playback result`,
    );
}
adapter.disposePlayer(created.player);
adapter.disposePlayer(created.player);
assert.throws(() => adapter.dispatch(created.player, { kind: "advance" }), /disposed/);

const left = adapter.createPlayer(animation);
const right = adapter.createPlayer(animation);
assert.equal(left.ok, true, left.error);
assert.equal(right.ok, true, right.error);
const leftResult = adapter.dispatch(left.player, { kind: "seek", frame: 1 });
const rightResult = adapter.dispatch(right.player, { kind: "seek", frame: 5 });
assert.equal(leftResult.ok, true, leftResult.error);
assert.equal(rightResult.ok, true, rightResult.error);
assert.equal(leftResult.action.frame, 1);
assert.equal(rightResult.action.frame, 5);
assert.notEqual(leftResult.action.segment, rightResult.action.segment);
adapter.disposePlayer(left.player);
adapter.disposePlayer(right.player);

const otherAdapter = await createIlluminateSelectionPlayerAdapter({
    bytes: wasmBytes,
    manifest,
    build,
});
const owned = adapter.createPlayer(animation);
assert.equal(owned.ok, true, owned.error);
assert.throws(
    () => otherAdapter.dispatch(owned.player, { kind: "advance" }),
    /requires this adapter's player handle/,
);
adapter.disposePlayer(owned.player);

const unread = {
    sf: 0,
    fc: 1,
    get sync() {
        throw new Error("selection projection read sync");
    },
    get pmap() {
        throw new Error("selection projection read pmap");
    },
    get params() {
        throw new Error("selection projection read params");
    },
};
const hostOnly = adapter.createPlayer({
    fps: 20,
    totalFrames: 1,
    segments: [unread],
    steps: [{ frame: 0, pause: false, loop: false }],
});
assert.equal(hostOnly.ok, true, hostOnly.error);
adapter.disposePlayer(hostOnly.player);

function fakeScheduler() {
    let nextHandle = 1;
    const callbacks = new Map();
    const cancelled = [];
    return {
        request(callback) {
            const handle = nextHandle;
            nextHandle += 1;
            callbacks.set(handle, callback);
            return handle;
        },
        cancel(handle) {
            callbacks.delete(handle);
            cancelled.push(handle);
        },
        callbacks,
        cancelled,
    };
}

const scheduler = fakeScheduler();
const host = createFirLivePlayerHost(adapter, animation, { render() {}, dispose() {} }, scheduler);
host.advance();
assert.equal(scheduler.callbacks.size, 1);
host.dispose();
assert.equal(scheduler.callbacks.size, 0);
assert.equal(scheduler.cancelled.length, 1);

const loopAnimation = {
    fps: 60,
    totalFrames: 2,
    segments: [
        {
            sf: 0,
            fc: 2,
            sync: "<svg></svg>",
            pmap: [{ e: 0, a: "opacity" }],
            params: [["0"], ["1"]],
        },
    ],
    steps: [{ frame: 0, pause: false, loop: true }],
};
const longRunning = adapter.createPlayer(loopAnimation);
assert.equal(longRunning.ok, true, longRunning.error);
const started = adapter.dispatch(longRunning.player, { kind: "advance" });
assert.equal(started.ok, true, started.error);
assert.equal(started.action.playback, "looping");
const checkpoint = started.memory.persistentCheckpoint;
let pagesAfterWarmup;
let peakFrontier = checkpoint;
for (let index = 0; index < 10_000; index += 1) {
    const tick = adapter.dispatch(longRunning.player, {
        kind: "tick",
        timestamp: 0.125 + index * (1000 / 60),
    });
    assert.equal(tick.ok, true, tick.error);
    assert.equal(tick.memory.frontierBefore, checkpoint);
    assert.equal(tick.memory.postRewindFrontier, checkpoint);
    assert.ok(tick.memory.peakFrontier >= checkpoint);
    assert.ok(
        tick.memory.peakFrontier - checkpoint < 1024 * 1024,
        "one tick used at least 1 MiB of scratch memory",
    );
    peakFrontier = Math.max(peakFrontier, tick.memory.peakFrontier);
    if (index === 99) pagesAfterWarmup = tick.memory.pagesAfter;
    if (index >= 100) {
        assert.equal(
            tick.memory.pagesAfter,
            pagesAfterWarmup,
            `Wasm memory grew after warmup at tick ${index}`,
        );
    }
}
adapter.disposePlayer(longRunning.player);

const invalid = adapter.createPlayer({ ...animation, fps: 0 });
assert.equal(invalid.ok, false);
assert.match(invalid.error, /animation fps must be positive/);

console.log(
    JSON.stringify(
        {
            ok: true,
            packageRoot,
            firCommit: build.sources?.fir?.commit,
            wasmBytes: wasmBytes.byteLength,
            wasmSha256: sha256(wasmBytes),
            adapterApi: ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION,
            inputLayout: ILLUMINATE_SELECTION_PLAYER_INPUT_LAYOUT_VERSION,
            ownership: ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION,
            eventConstructors: [...new Set(events.map(({ kind }) => kind))].sort(),
            hostMaterializedPatchTargets: ["attribute", "textContent"],
            selectionBytes: created.memory.selectionBytes,
            persistentAllocations: created.memory.persistentAllocationCalls,
            floatBoundaryMilliseconds: {
                below: events[2].timestamp,
                above: events[3].timestamp,
            },
            concurrentPlayers: 2,
            longRunDispatches: 10_000,
            persistentCheckpoint: checkpoint,
            peakFrontier,
            maximumScratchBytes: peakFrontier - checkpoint,
            pagesAfterWarmup,
        },
        null,
        2,
    ),
);
