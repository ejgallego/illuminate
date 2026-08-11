import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createFirHitSceneHost } from "../player_js/fir_hit_scene.js";
import { createVirHitSceneHost } from "../player_js/vir_hit_scene.js";
import {
    loadHitSceneBenchmark,
    loadHitSceneBenchmarkSuite,
    runPairedHitSceneBenchmark,
} from "./lib/hit-scene-benchmark.mjs";
import { appendHitScenePerformanceHistory } from "./lib/hit-scene-performance-history.mjs";
import { createVirRuntime } from "../test_output/vir/sdk/js/vir-runtime-node.js";

const execFileAsync = promisify(execFile);

const quick = process.argv.includes("--quick");
const requireFir = process.argv.includes("--require-fir");
const virOnly = process.argv.includes("--vir-only");
const suiteMode = process.argv.includes("--suite");
const outputArgument = process.argv.find((argument) => argument.startsWith("--output="));
const historyArgument = process.argv.find((argument) => argument.startsWith("--history="));
const labelArgument = process.argv.find((argument) => argument.startsWith("--label="));
const outputPath =
    outputArgument?.slice("--output=".length) ||
    (suiteMode
        ? "test_output/hit-scene-tier-performance.json"
        : "test_output/hit-scene-performance.json");
const warmupRounds = quick ? 1 : 2;
const measuredRounds = quick ? 2 : 10;
const profileRounds = quick ? 1 : 5;
const firStageRoot = path.resolve("test_output/fir-hit-scene");
const fixturePath = suiteMode
    ? "test_output/hit-scene-benchmark-suite.json"
    : "test_output/hit-scene-benchmark.json";

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

function quantile(values, fraction) {
    assert.ok(values.length > 0, "cannot summarize an empty timing series");
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor((sorted.length - 1) * fraction)];
}

function summarize(values) {
    return {
        count: values.length,
        meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
        medianMs: quantile(values, 0.5),
        p95Ms: quantile(values, 0.95),
        maxMs: Math.max(...values),
    };
}

function summarizeRatios(values) {
    const summary = summarize(values);
    return {
        count: summary.count,
        mean: summary.meanMs,
        median: summary.medianMs,
        p95: summary.p95Ms,
        maximum: summary.maxMs,
    };
}

function summarizeObservations(observations) {
    assert.ok(observations.length > 0, "profile pass produced no query observations");
    const phaseNames = [
        ...new Set(
            observations.flatMap((observation) =>
                Object.entries(observation.adapterTimings ?? {})
                    .filter(([, value]) => Number.isFinite(value))
                    .map(([name]) => name),
            ),
        ),
    ].sort();
    return {
        wall: summarize(observations.map(({ adapterWallMs }) => adapterWallMs)),
        phases: Object.fromEntries(
            phaseNames.map((name) => [
                name,
                summarize(
                    observations
                        .map(({ adapterTimings }) => adapterTimings?.[name])
                        .filter((value) => Number.isFinite(value)),
                ),
            ]),
        ),
        lastMemory: observations.at(-1)?.memory ?? null,
        raw: observations.map(({ adapterWallMs, adapterTimings, memory }) => ({
            wallMs: adapterWallMs,
            timings: adapterTimings,
            memory,
        })),
    };
}

function sameResult(actual, expected) {
    return (
        actual.kind === expected.kind &&
        (expected.kind !== "tag" ||
            (actual.value === expected.value && actual.label === expected.label))
    );
}

async function fileExists(filename) {
    try {
        await access(filename);
        return true;
    } catch {
        return false;
    }
}

async function loadVir() {
    const wasmBytes = await readFile("test_output/vir/sdk/wasm/vir-upstream.wasm");
    const descriptorUrl = new URL(
        "../test_output/vir/module-sets/Illuminate/Diagram/HitScene/Vir.irpkg-set.json",
        import.meta.url,
    );
    const descriptorBytes = await readFile(descriptorUrl);
    const descriptor = JSON.parse(descriptorBytes.toString("utf8"));
    const packageSetBytes = await Promise.all(
        descriptor.packages.map((member) => readFile(new URL(member.path, descriptorUrl))),
    );
    const runtime = await createVirRuntime({ wasmBytes, irPackageSetBytes: packageSetBytes });
    return {
        name: "vir",
        metadata: {
            available: true,
            measurementMode: "runtime.call for production; runtime.callTimed for diagnostics",
            wasmBytes: wasmBytes.byteLength,
            wasmSha256: sha256(wasmBytes),
            packageMembers: descriptor.packages.length,
            packageSetSha256: sha256(Buffer.concat([descriptorBytes, ...packageSetBytes])),
        },
        benchmark: {
            create({ encodedScene }) {
                return createVirHitSceneHost(runtime, encodedScene);
            },
            query(host, x, y) {
                return host.query(x, y);
            },
            dispose(host) {
                host.dispose();
            },
        },
        createProfiled(fixture, observer) {
            return createVirHitSceneHost(runtime, fixture.encodedScene, observer);
        },
        dispose() {
            runtime.dispose();
        },
    };
}

async function loadFir() {
    const filenames = {
        adapter: path.join(firStageRoot, "illuminate-hit-scene-browser-adapter.mjs"),
        build: path.join(firStageRoot, "BUILD.json"),
        manifest: path.join(firStageRoot, "illuminate-hit-scene.wasm.json"),
        wasm: path.join(firStageRoot, "illuminate-hit-scene.wasm"),
    };
    if (!(await fileExists(filenames.build))) return null;
    const [adapterModule, buildBytes, manifest, wasmBytes] = await Promise.all([
        import(pathToFileURL(filenames.adapter).href),
        readFile(filenames.build),
        readFile(filenames.manifest, "utf8").then(JSON.parse),
        readFile(filenames.wasm),
    ]);
    const build = JSON.parse(buildBytes.toString("utf8"));
    assert.equal(
        build.capabilities?.browserAdapter?.apiVersion,
        "fir.illuminate-hit-scene.browser/v1",
    );
    assert.equal(
        build.capabilities?.inputLayout?.version,
        "lean-4.32-Illuminate.HitScene/v2",
        "staged FIR HitScene package uses an obsolete prepared-path layout; use --vir-only until v2 is staged",
    );
    const adapter = await adapterModule.createIlluminateHitSceneAdapter({
        bytes: wasmBytes,
        manifest,
        build,
    });
    return {
        name: "fir",
        metadata: {
            available: true,
            measurementMode:
                "untimed adapter hitTest for production; hitTestDiagnostic for phase attribution",
            wasmBytes: wasmBytes.byteLength,
            wasmSha256: sha256(wasmBytes),
            buildSha256: sha256(buildBytes),
            firCommit: build.sources?.fir?.commit,
            illuminateCommit: build.sources?.illuminate?.commit,
        },
        benchmark: {
            create({ encodedScene }) {
                return createFirHitSceneHost(adapter, encodedScene);
            },
            query(host, x, y) {
                return host.query(x, y);
            },
            dispose(host) {
                host.dispose();
            },
        },
        createProfiled(fixture, observer) {
            return createFirHitSceneHost(adapter, fixture.encodedScene, observer);
        },
        dispose() {},
    };
}

function profileCandidates(candidates, fixture) {
    const profiled = candidates.map((candidate) => {
        const observations = [];
        const host = candidate.createProfiled(fixture, (observation) => {
            if (observation.kind === "query") observations.push(observation);
        });
        return { candidate, host, observations };
    });
    try {
        for (let round = 0; round < 1 + profileRounds; round += 1) {
            const order = profiled.map((_, index) => profiled[(index + round) % profiled.length]);
            for (const query of fixture.queries) {
                for (const entry of order) {
                    assert.ok(sameResult(entry.host.query(query.x, query.y), query.expected));
                }
            }
            if (round === 0) {
                for (const entry of profiled) entry.observations.length = 0;
            }
        }
        return Object.fromEntries(
            profiled.map(({ candidate, observations }) => [
                candidate.name,
                summarizeObservations(observations),
            ]),
        );
    } finally {
        for (const entry of profiled.toReversed()) entry.host.dispose();
    }
}

const fixtureBytes = await readFile(fixturePath);
const fixtures = suiteMode
    ? (await loadHitSceneBenchmarkSuite(fixturePath)).fixtures
    : [await loadHitSceneBenchmark(fixturePath)];
const candidates = [await loadVir()];
assert.ok(!(virOnly && requireFir), "--vir-only and --require-fir are mutually exclusive");
const fir = virOnly ? null : await loadFir();
if (fir !== null) candidates.push(fir);
if (requireFir) assert.ok(fir, "stage the immutable FIR HitScene package before measuring");

async function measureFixture(fixture) {
    const production = await runPairedHitSceneBenchmark(
        fixture,
        Object.fromEntries(candidates.map((candidate) => [candidate.name, candidate.benchmark])),
        { warmupRounds, measuredRounds, retainSamples: true, now: () => performance.now() },
    );
    const diagnostics = profileCandidates(candidates, fixture);
    const firOverVir =
        fir === null
            ? null
            : {
                  median: production.fir.query.medianMs / production.vir.query.medianMs,
                  mean: production.fir.query.meanMs / production.vir.query.meanMs,
                  p95: production.fir.query.p95Ms / production.vir.query.p95Ms,
                  creation: production.fir.creationMs / production.vir.creationMs,
                  execute:
                      diagnostics.fir.phases.executeMs.medianMs /
                      diagnostics.vir.phases.executeMs.medianMs,
                  pairedQueryRatio: summarizeRatios(
                      production.fir.samples.map(
                          (sample, index) => sample / production.vir.samples[index],
                      ),
                  ),
                  pairedQueryDeltaMs: summarize(
                      production.fir.samples.map(
                          (sample, index) => sample - production.vir.samples[index],
                      ),
                  ),
              };
    return {
        fixture: {
            name: fixture.name,
            geometryClass: fixture.geometryClass,
            schemaVersion: fixture.schemaVersion,
            encodedBytes: fixture.encodedScene.length,
            queryCount: fixture.queries.length,
        },
        production,
        diagnostics,
        deltas: { firOverVir },
    };
}

try {
    const measurements = [];
    for (const fixture of fixtures) measurements.push(await measureFixture(fixture));
    const primary =
        measurements.find(({ fixture }) => fixture.geometryClass === "mixed") ?? measurements[0];
    assert.ok(primary, "hit-scene measurement suite is empty");
    let source = null;
    try {
        const [{ stdout: commit }, { stdout: status }] = await Promise.all([
            execFileAsync("git", ["rev-parse", "HEAD"]),
            execFileAsync("git", ["status", "--short"]),
        ]);
        source = { commit: commit.trim(), dirty: status.trim().length > 0 };
    } catch {
        source = null;
    }
    const cpu = os.cpus()[0];
    const report = {
        schemaVersion: suiteMode
            ? "illuminate.hit-scene-tier-performance/v1"
            : "illuminate.hit-scene-performance/v1",
        generatedAt: new Date().toISOString(),
        source,
        environment: {
            node: process.version,
            platform: process.platform,
            architecture: process.arch,
            cpu: cpu?.model ?? "unknown",
            logicalCpuCount: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
        },
        benchmarkArtifact: {
            path: fixturePath,
            sha256: sha256(fixtureBytes),
            byteLength: fixtureBytes.byteLength,
        },
        fixture: primary.fixture,
        protocol: {
            warmupRounds,
            measuredRounds,
            profileRounds,
            samplesPerBackend: primary.fixture.queryCount * measuredRounds,
            balancedQueryBackendOrder: candidates.length > 1,
            pairedQuerySamples: candidates.length > 1,
            creationExcludedFromQuerySamples: true,
            productionAndDiagnosticsSeparated: true,
        },
        backends: Object.fromEntries(
            candidates.map((candidate) => [candidate.name, candidate.metadata]),
        ),
        production: primary.production,
        diagnostics: primary.diagnostics,
        deltas: primary.deltas,
        ...(suiteMode ? { workloads: measurements } : {}),
        caveats: [
            "Production wall time uses each adapter's normal public query path.",
            "VIR detailed timing is disabled in production samples and enabled only for diagnostics.",
            "FIR detailed timing is disabled in production samples and enabled only for diagnostics.",
            "The FIR/VIR headline uses paired measurements of the same query and round; absolute times remain sensitive to ambient machine load.",
            "RPC is measured only inside the Lean infoview and is not represented by this Node report.",
        ],
    };
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
    const historyPath = historyArgument?.slice("--history=".length);
    if (historyPath) {
        await appendHitScenePerformanceHistory(historyPath, report, {
            label: labelArgument?.slice("--label=".length) || null,
        });
    }
    console.log(
        JSON.stringify(
            {
                ok: true,
                outputPath: path.resolve(outputPath),
                historyPath: historyPath ? path.resolve(historyPath) : null,
                workloads: measurements.map((measurement) => ({
                    name: measurement.fixture.name,
                    backends: Object.fromEntries(
                        Object.entries(measurement.production).map(([name, result]) => [
                            name,
                            result.query,
                        ]),
                    ),
                    firOverVir: measurement.deltas.firOverVir,
                })),
            },
            null,
            2,
        ),
    );
} finally {
    for (const candidate of candidates.toReversed()) candidate.dispose();
}
