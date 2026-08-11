import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    appendHitScenePerformanceHistory,
    createHitScenePerformanceHistoryRecord,
    loadHitScenePerformanceHistory,
    parseHitScenePerformanceHistory,
} from "./lib/hit-scene-performance-history.mjs";

const report = {
    schemaVersion: "illuminate.hit-scene-tier-performance/v1",
    generatedAt: "2026-08-11T10:00:00.000Z",
    source: { commit: "abc123", dirty: false },
    environment: { node: "v24.0.0", cpu: "test" },
    protocol: { measuredRounds: 2 },
    benchmarkArtifact: { sha256: "fixture-sha" },
    backends: { vir: { wasmSha256: "vir-sha" }, fir: { wasmSha256: "fir-sha" } },
    workloads: [
        {
            fixture: { name: "mixed-medium" },
            production: {
                vir: { query: { medianMs: 2 }, samples: [1, 2, 3] },
                fir: { query: { medianMs: 1 }, samples: [1, 1, 1] },
            },
            diagnostics: {
                vir: { phases: { executeMs: { medianMs: 1.5 } }, raw: [{ timings: {} }] },
            },
            deltas: { firOverVir: { pairedQueryRatio: { median: 0.5 } } },
        },
    ],
};

const compact = createHitScenePerformanceHistoryRecord(report, { label: "acceptance" });
assert.equal(compact.label, "acceptance");
assert.equal(compact.workloads[0].production.vir.samples, undefined);
assert.equal(compact.workloads[0].diagnostics.vir.raw, undefined);
assert.equal(compact.workloads[0].production.vir.query.medianMs, 2);
assert.throws(() => parseHitScenePerformanceHistory("{}\n"), /unsupported/);
assert.throws(() => parseHitScenePerformanceHistory("not json\n"), /invalid JSON/);

const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "illuminate-hit-scene-history-"));
try {
    const filename = path.join(temporaryRoot, "history.jsonl");
    await appendHitScenePerformanceHistory(filename, report, { label: "first" });
    await appendHitScenePerformanceHistory(
        filename,
        { ...report, generatedAt: "2026-08-11T10:01:00.000Z" },
        { label: "second" },
    );
    const source = await readFile(filename, "utf8");
    assert.equal(source.trim().split("\n").length, 2);
    const records = await loadHitScenePerformanceHistory(filename);
    assert.deepEqual(
        records.map(({ label }) => label),
        ["first", "second"],
    );
} finally {
    await rm(temporaryRoot, { recursive: true });
}

console.log("hit-scene performance history contract passed");
