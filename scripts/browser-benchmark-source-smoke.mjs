import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

import { replayLegacyPlayerTrace } from "./workload/js-player-trace.mjs";
import { prepareVirPlayerAnimation, prepareVirPlayerEvents } from "./workload/vir-player-trace.mjs";

const examples = JSON.parse(await readFile(new URL("./workload/examples.json", import.meta.url)));
assert.equal(examples.length, 16);
assert.ok(examples.some(({ title }) => title === "Pause-driven slide show"));
assert.ok(examples.some(({ title }) => title === "Morphing arrows and final loop"));

const coreSource = await readFile(new URL("./workload/anim_core.js", import.meta.url), "utf8");
const helpers = vm.createContext({});
vm.runInContext(coreSource, helpers);

let actionCount = 0;
const patchTargets = new Set();
for (const { title, data } of examples) {
    assert.ok(Number.isSafeInteger(data.totalFrames) && data.totalFrames > 0, `${title} frames`);
    const events = [
        { kind: "seek", frame: Math.floor((data.totalFrames - 1) / 2) },
        { kind: "playTo", frame: data.totalFrames - 1, loopAfter: false },
        { kind: "tick", timestamp: 0.125 },
        { kind: "tick", timestamp: 1000 / 60 + 0.125 },
    ];
    const oracle = replayLegacyPlayerTrace(data, events, helpers);
    assert.equal(oracle.ok, true);
    assert.equal(oracle.actions.length, events.length + 1);
    actionCount += oracle.actions.length;
    for (const segment of data.segments) {
        assert.equal(typeof segment.sync, "string");
        for (const binding of segment.pmap) patchTargets.add(binding.a);
    }
    const projected = prepareVirPlayerAnimation(data);
    assert.equal(
        projected.segments.some((segment) => "sync" in segment),
        false,
    );
    assert.equal(prepareVirPlayerEvents(events).length, events.length);
}
assert.ok(patchTargets.has("textContent"));
assert.ok([...patchTargets].some((target) => target !== "textContent"));

console.log(
    JSON.stringify({
        ok: true,
        examples: examples.length,
        actions: actionCount,
        patchTargetKinds: ["textContent", "attribute"],
    }),
);
