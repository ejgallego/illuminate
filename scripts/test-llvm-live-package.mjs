import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    LLVM_SELECTION_PLAYER_ADAPTER_API_VERSION,
    LLVM_SELECTION_PLAYER_HOT_EVENT_VERSION,
    LLVM_SELECTION_PLAYER_INPUT_LAYOUT_VERSION,
    LLVM_SELECTION_PLAYER_OWNERSHIP_VERSION,
    LLVM_SELECTION_PLAYER_WIRE_VERSION,
    loadLlvmSelectionPlayerAdapter,
} from "../player_js/llvm_selection_player.js";

const packageArgument = process.env.ILLUMINATE_LLVM_PLAYER_DIR;
assert.ok(
    packageArgument,
    "set ILLUMINATE_LLVM_PLAYER_DIR to an immutable FIR-LLVM selection-player package",
);
const requestedRoot = path.resolve(packageArgument);
const requestedStat = await lstat(requestedRoot);
assert.equal(
    requestedStat.isSymbolicLink(),
    false,
    "ILLUMINATE_LLVM_PLAYER_DIR must name an immutable package, not a moving symlink",
);
assert.notEqual(
    path.basename(requestedRoot),
    "illuminate-selection-player-current",
    "use an immutable package directory rather than illuminate-selection-player-current",
);
const packageRoot = await realpath(requestedRoot);
const repositoryRoot = await realpath(new URL("..", import.meta.url));
const manifestPath = path.join(packageRoot, "illuminate-selection-player.manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

function packageFile(relative, label) {
    assert.equal(typeof relative, "string", `${label} does not name a file`);
    assert.equal(path.isAbsolute(relative), false, `${label} names an absolute path`);
    const resolved = path.resolve(packageRoot, relative);
    assert.ok(
        resolved.startsWith(`${packageRoot}${path.sep}`),
        `${label} escapes the immutable package directory`,
    );
    return resolved;
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

const checksums = new Map(
    (await readFile(path.join(packageRoot, "SHA256SUMS"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => {
            const match = /^([0-9a-f]{64})  ([^\r\n]+)$/.exec(line);
            assert.ok(match, `malformed SHA256SUMS line: ${line}`);
            return [match[2], match[1]];
        }),
);
for (const filename of [
    "README.md",
    "emscripten-loader.mjs",
    "illuminate-selection-player-emscripten-adapter.mjs",
    "illuminate-selection-player.manifest.json",
    "illuminate-selection-player.mjs",
    "illuminate-selection-player.wasm",
    "smoke.mjs",
]) {
    const expected = checksums.get(filename);
    assert.ok(expected, `SHA256SUMS does not cover ${filename}`);
    assert.equal(sha256(await readFile(packageFile(filename, filename))), expected);
}

assert.equal(manifest.profile, "emscripten");
assert.equal(
    manifest.capabilities?.browserAdapter?.apiVersion,
    LLVM_SELECTION_PLAYER_ADAPTER_API_VERSION,
);
assert.deepEqual(manifest.capabilities?.browserAdapter?.methods, [
    "createPlayer",
    "dispatch",
    "dispatchTick",
    "disposePlayer",
    "replayTrace",
]);
assert.equal(
    manifest.capabilities?.inputLayout?.version,
    LLVM_SELECTION_PLAYER_INPUT_LAYOUT_VERSION,
);
assert.equal(manifest.capabilities?.ownership?.version, LLVM_SELECTION_PLAYER_OWNERSHIP_VERSION);
assert.equal(manifest.capabilities?.hotEvent?.version, LLVM_SELECTION_PLAYER_HOT_EVENT_VERSION);
assert.equal(manifest.capabilities?.hotEvent?.method, "dispatchTick(player, timestamp)");
assert.equal(manifest.capabilities?.emscriptenWire?.version, LLVM_SELECTION_PLAYER_WIRE_VERSION);
assert.notEqual(
    manifest.runtime?.crossOriginIsolated,
    true,
    "the Animation Lab is served as an ordinary static page and requires an unthreaded package",
);

const expectedSources = new Map([
    [
        "src/Illuminate/Animation/Types.lean",
        "97a030fdd3ef718912479343cadf0131616a8a9b458901e963dc3709cf5633a3",
    ],
    [
        "src/Illuminate/Animation/Player.lean",
        "e1f98f9d02118f4b61a3f935dbdf49b1c3caf7c0b52aa0f80b7232fb740cd620",
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
assert.equal(manifest.sources?.illuminate?.commit, "23f291b15b4ec1ce0e41564d040329a44acb5172");
assert.equal(manifest.sources?.illuminate?.dirty, false);
for (const [source, expectedHash] of expectedSources) {
    assert.equal(
        sha256(await readFile(path.join(repositoryRoot, source))),
        expectedHash,
        `${source} changed during LLVM generation`,
    );
    assert.equal(
        manifest.sources?.illuminate?.relevantFiles?.find(
            ({ path: candidate }) => candidate === source,
        )?.sha256,
        expectedHash,
        `${source} is absent from the LLVM manifest`,
    );
}

for (const [name, artifact] of Object.entries(manifest.artifacts ?? {})) {
    assert.equal(typeof artifact?.file, "string", `${name} does not name a file`);
    assert.ok(Number.isSafeInteger(artifact?.byteLength), `${name} does not declare a byte length`);
    assert.match(artifact?.sha256 ?? "", /^[0-9a-f]{64}$/, `${name} does not declare SHA-256`);
    const bytes = await readFile(packageFile(artifact.file, name));
    assert.equal(bytes.byteLength, artifact.byteLength, `${name} byte length mismatch`);
    assert.equal(sha256(bytes), artifact.sha256, `${name} SHA-256 mismatch`);
}
assert.equal(manifest.artifacts?.module?.file, "illuminate-selection-player.mjs");
assert.equal(manifest.artifacts?.wasm?.file, "illuminate-selection-player.wasm");

const adapterModule = await import(
    pathToFileURL(path.join(packageRoot, "illuminate-selection-player-emscripten-adapter.mjs")).href
);
assert.equal(
    adapterModule.ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION,
    LLVM_SELECTION_PLAYER_ADAPTER_API_VERSION,
);
assert.equal(
    adapterModule.ILLUMINATE_SELECTION_PLAYER_INPUT_LAYOUT_VERSION,
    LLVM_SELECTION_PLAYER_INPUT_LAYOUT_VERSION,
);
assert.equal(
    adapterModule.ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION,
    LLVM_SELECTION_PLAYER_OWNERSHIP_VERSION,
);
assert.equal(
    adapterModule.ILLUMINATE_SELECTION_PLAYER_HOT_EVENT_VERSION,
    LLVM_SELECTION_PLAYER_HOT_EVENT_VERSION,
);
assert.equal(
    adapterModule.ILLUMINATE_SELECTION_PLAYER_EMSCRIPTEN_WIRE_VERSION,
    LLVM_SELECTION_PLAYER_WIRE_VERSION,
);

const adapter = await loadLlvmSelectionPlayerAdapter({
    adapterUrl: pathToFileURL(
        path.join(packageRoot, "illuminate-selection-player-emscripten-adapter.mjs"),
    ),
    manifestUrl: pathToFileURL(manifestPath),
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

function requireResult(result, operation, diagnostics = true) {
    assert.equal(result.ok, true, `${operation}: ${result.error ?? "unknown error"}`);
    if (!diagnostics) return result;
    for (const phase of ["encodeMs", "executeMs", "decodeMs", "totalMs"]) {
        assert.ok(
            Number.isFinite(result.timings?.[phase]) && result.timings[phase] >= 0,
            `${operation} does not report ${phase}`,
        );
    }
    assert.ok(
        Number.isFinite(result.memory?.currentBytes) && result.memory.currentBytes >= 0,
        `${operation} does not report currentBytes`,
    );
    assert.ok(
        Number.isFinite(result.memory?.peakBytes) &&
            result.memory.peakBytes >= result.memory.currentBytes,
        `${operation} does not report a valid peakBytes`,
    );
    return result;
}

function adjacentFloat(value, direction) {
    const storage = new ArrayBuffer(8);
    const floats = new Float64Array(storage);
    const bits = new BigUint64Array(storage);
    floats[0] = value;
    bits[0] += direction > 0 ? 1n : -1n;
    return floats[0];
}

const created = requireResult(adapter.createPlayer(animation), "createPlayer");
assert.ok(Number.isFinite(created.timings?.projectMs) && created.timings.projectMs >= 0);
const events = [
    { kind: "advance" },
    { kind: "tick", timestamp: adjacentFloat(50, -1) },
    { kind: "tick", timestamp: 50 },
    { kind: "tick", timestamp: adjacentFloat(50, 1) },
    { kind: "pause" },
    { kind: "seek", frame: 3 },
    { kind: "playTo", frame: 1, loopAfter: false },
    { kind: "loopAt", frame: 2 },
];
const actions = [created.action];
for (const event of events) {
    const result = requireResult(
        event.kind === "tick"
            ? adapter.dispatchTick(created.player, event.timestamp)
            : adapter.dispatch(created.player, event),
        event.kind,
    );
    actions.push(result.action);
}
const replayed = requireResult(adapter.replayTrace(animation, events), "replayTrace", false);
assert.deepEqual(replayed.actions, actions, "resident dispatch diverged from replayTrace");

const left = requireResult(adapter.createPlayer(animation), "createPlayer left");
const right = requireResult(adapter.createPlayer(animation), "createPlayer right");
requireResult(adapter.dispatch(left.player, { kind: "seek", frame: 3 }), "left seek");
const rightPaused = requireResult(adapter.dispatch(right.player, { kind: "pause" }), "right pause");
assert.equal(rightPaused.action.frame, 0, "concurrent players shared state");
adapter.disposePlayer(left.player);
adapter.disposePlayer(left.player);
adapter.disposePlayer(right.player);
adapter.disposePlayer(created.player);

console.log("LLVM/Emscripten Illuminate selection-player package accepted");
