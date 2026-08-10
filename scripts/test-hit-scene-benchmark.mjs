import assert from "node:assert/strict";

import {
    float64ToBits,
    loadHitSceneBenchmark,
    runPairedHitSceneBenchmark,
} from "./lib/hit-scene-benchmark.mjs";

const fixture = await loadHitSceneBenchmark("test_output/hit-scene-benchmark.json");
assert.equal(fixture.schemaVersion, "illuminate.hit-scene-benchmark/v1");
assert.equal(fixture.referenceQueryCount, 296);
assert.equal(fixture.queries.length, 301);
assert.ok(fixture.encodedScene.length > 100);
assert.equal(typeof fixture.parsedScene.tree.kind, "string");
for (const item of [
    "empty",
    "transform",
    "clip",
    "tag",
    "unlabeledTag",
    "compose",
    "bounds",
    "text",
    "styledText",
    "image",
    "line",
    "cubic",
    "arc",
    "fill",
    "stroke",
]) {
    assert.ok(fixture.coverage.includes(item), `fixture does not claim ${item} coverage`);
}
assert.deepEqual(
    new Set(fixture.queries.map(({ expected }) => expected.kind)),
    new Set(["nothing", "something", "tag"]),
);
assert.ok(
    fixture.queries.some(
        ({ expected }) => expected.kind === "tag" && expected.value === 3 && expected.label === "",
    ),
    "fixture has no unlabeled tag result",
);

const negativeZeroX = fixture.queries.find(({ name }) => name === "negative-zero-x");
const negativeZeroY = fixture.queries.find(({ name }) => name === "negative-zero-y");
assert.ok(negativeZeroX && negativeZeroY);
assert.equal(Object.is(negativeZeroX.x, -0), true);
assert.equal(Object.is(negativeZeroY.y, -0), true);
assert.equal(float64ToBits(negativeZeroX.x), "9223372036854775808");

const byCoordinates = new Map(
    fixture.queries.map((query) => [`${query.xBits}:${query.yBits}`, query.expected]),
);
const created = [];
const disposed = [];
function oracleBackend(name) {
    return {
        create({ encodedScene, parsedScene }) {
            assert.equal(encodedScene, fixture.encodedScene);
            assert.equal(parsedScene, fixture.parsedScene);
            const context = Object.freeze({ name });
            created.push(context);
            return context;
        },
        query(context, x, y) {
            assert.equal(context.name, name);
            const result = byCoordinates.get(`${float64ToBits(x)}:${float64ToBits(y)}`);
            assert.ok(result, `${name} received an unknown coordinate`);
            return result;
        },
        dispose(context) {
            disposed.push(context);
        },
    };
}

let clock = 0;
const results = await runPairedHitSceneBenchmark(
    fixture,
    { rpc: oracleBackend("rpc"), candidate: oracleBackend("candidate") },
    {
        warmupRounds: 1,
        measuredRounds: 2,
        retainSamples: true,
        now() {
            clock += 0.001;
            return clock;
        },
    },
);
assert.equal(results.rpc.query.count, fixture.queries.length * 2);
assert.equal(results.candidate.query.count, fixture.queries.length * 2);
assert.ok(results.rpc.creationMs > 0);
assert.ok(results.candidate.query.medianMs > 0);
assert.equal(results.rpc.samples.length, fixture.queries.length * 2);
assert.equal(results.candidate.samples.length, fixture.queries.length * 2);
assert.equal(created.length, 2);
assert.deepEqual(disposed, created.toReversed());

console.log(
    `hit-scene benchmark fixture passed: ${fixture.queries.length} oracle queries, ${fixture.encodedScene.length} encoded bytes`,
);
