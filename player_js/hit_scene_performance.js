// @ts-check

import { createFirHitSceneHost } from "./fir_hit_scene.js";
import { parseHitScenePerformanceHistory } from "./hit_scene_performance_history.js";
import { createVirHitSceneHost } from "./vir_hit_scene.js";

/**
 * @typedef {"vir" | "fir"} HitScenePerformanceBackend
 * @typedef {{ count: number, meanMs: number, medianMs: number, p95Ms: number, maxMs: number }} TimingSummary
 * @typedef {{ creationMs: number, query: TimingSummary }} ProductionResult
 * @typedef {{ medianMs: number }} PhaseSummary
 * @typedef {{ phases: Record<string, PhaseSummary> }} DiagnosticResult
 * @typedef {{
 *   generatedAt: string,
 *   protocol: { samplesPerBackend: number },
 *   production: Partial<Record<HitScenePerformanceBackend, ProductionResult>>,
 *   diagnostics?: Partial<Record<HitScenePerformanceBackend, DiagnosticResult>>,
 *   deltas?: { firOverVir?: { median: number, pairedQueryRatio?: { median: number } } | null },
 *   caveats: string[]
 * }} HitScenePerformanceReport
 */

const backendOrder = /** @type {const} */ (["vir", "fir"]);
/** @type {Record<HitScenePerformanceBackend, string>} */
const backendLabels = { vir: "VIR interpreter", fir: "FIR native Wasm" };
/** @type {Array<{ label: string, vir: string | null, fir: string | null }>} */
const phaseGroups = [
    { label: "Input / marshal", vir: "marshalMs", fir: "inputMs" },
    { label: "Lean execution", vir: "executeMs", fir: "executeMs" },
    { label: "Result decode", vir: "decodeMs", fir: "decodeMs" },
    { label: "Host imports", vir: "hostMs", fir: null },
    { label: "Scratch rewind", vir: null, fir: "rewindMs" },
    { label: "Adapter residual", vir: null, fir: "residualMs" },
];

function now() {
    return performance.now();
}

/** @param {Response} response @param {string} label */
async function requireOk(response, label) {
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return response;
}

/** @param {string | URL} url */
async function fetchBytes(url) {
    const response = await requireOk(await fetch(url, { cache: "no-store" }), String(url));
    return new Uint8Array(await response.arrayBuffer());
}

/** @param {number[]} values @returns {TimingSummary} */
function summarize(values) {
    const sorted = [...values].sort((left, right) => left - right);
    /** @param {number} fraction */
    const percentile = (fraction) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
    return {
        count: values.length,
        meanMs: values.reduce((sum, value) => sum + value, 0) / values.length,
        medianMs: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: sorted.at(-1) ?? 0,
    };
}

/** @param {Array<{ adapterWallMs: number, adapterTimings: Record<string, number> | null }>} observations */
function summarizeObservations(observations) {
    const names = [
        ...new Set(
            observations.flatMap((observation) => Object.keys(observation.adapterTimings ?? {})),
        ),
    ];
    return {
        wall: summarize(observations.map((observation) => observation.adapterWallMs)),
        phases: Object.fromEntries(
            names.map((name) => [
                name,
                summarize(
                    observations
                        .map((observation) => observation.adapterTimings?.[name])
                        .filter((value) => value !== undefined),
                ),
            ]),
        ),
    };
}

/** @param {unknown} actual @param {unknown} expected */
function sameResult(actual, expected) {
    if (
        typeof actual !== "object" ||
        actual === null ||
        typeof expected !== "object" ||
        expected === null ||
        !("kind" in actual) ||
        !("kind" in expected)
    ) {
        return false;
    }
    return (
        actual.kind === expected.kind &&
        (expected.kind !== "tag" ||
            ("value" in actual &&
                "value" in expected &&
                "label" in actual &&
                "label" in expected &&
                actual.value === expected.value &&
                actual.label === expected.label))
    );
}

/** @param {Array<any>} candidates @param {any} fixture */
function profileCandidates(candidates, fixture) {
    const profiled = candidates.map((candidate) => {
        /** @type {any[]} */
        const observations = [];
        const host = candidate.createProfiled(fixture, (/** @type {any} */ observation) => {
            if (observation.kind === "query") observations.push(observation);
        });
        return { candidate, host, observations };
    });
    try {
        for (let round = 0; round < 3; round += 1) {
            for (const query of fixture.queries) {
                for (const entry of profiled) {
                    if (!sameResult(entry.host.query(query.x, query.y), query.expected)) {
                        throw new Error(
                            `${entry.candidate.name} changed result during ${query.name}`,
                        );
                    }
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

async function loadVirCandidate() {
    const runtimeModuleUrl = new URL("./vir/sdk/js/vir-runtime.js", location.href).href;
    const runtimeModule = await import(runtimeModuleUrl);
    const wasmBytes = await fetchBytes("./vir/sdk/wasm/vir-upstream.wasm");
    const descriptorUrl = new URL(
        "./vir/module-sets/Illuminate/Diagram/HitScene/Vir.irpkg-set.json",
        location.href,
    );
    const descriptor = /** @type {{ packages: Array<{ path: string }> }} */ (
        await requireOk(await fetch(descriptorUrl, { cache: "no-store" }), "VIR package set").then(
            (response) => response.json(),
        )
    );
    const packageSetBytes = await Promise.all(
        descriptor.packages.map((member) => fetchBytes(new URL(member.path, descriptorUrl))),
    );
    const runtime = await runtimeModule.createVirRuntime({
        wasmBytes,
        irPackageSetBytes: packageSetBytes,
    });
    return {
        name: "vir",
        metadata: {
            available: true,
            measurementMode: "live browser runtime.call; diagnostic runtime.callTimed",
            wasmBytes: wasmBytes.byteLength,
            packageMembers: descriptor.packages.length,
        },
        benchmark: {
            create(/** @type {{ encodedScene: string }} */ { encodedScene }) {
                return createVirHitSceneHost(runtime, encodedScene);
            },
            query(/** @type {any} */ host, /** @type {number} */ x, /** @type {number} */ y) {
                return host.query(x, y);
            },
            dispose(/** @type {any} */ host) {
                host.dispose();
            },
        },
        createProfiled(/** @type {any} */ fixture, /** @type {any} */ observer) {
            return createVirHitSceneHost(runtime, fixture.encodedScene, observer);
        },
        dispose() {
            runtime.dispose();
        },
    };
}

async function loadFirCandidate() {
    const buildResponse = await fetch("./fir-hit-scene/BUILD.json", { cache: "no-store" });
    if (buildResponse.status === 404) return null;
    const build = await requireOk(buildResponse, "FIR BUILD.json").then((response) =>
        response.json(),
    );
    if (build.capabilities?.inputLayout?.version !== "lean-4.32-Illuminate.HitScene/v2") {
        return null;
    }
    const adapterUrl = new URL(
        "./fir-hit-scene/illuminate-hit-scene-browser-adapter.mjs",
        location.href,
    ).href;
    const [adapterModule, manifest, wasmBytes] = await Promise.all([
        import(adapterUrl),
        requireOk(
            await fetch("./fir-hit-scene/illuminate-hit-scene.wasm.json", {
                cache: "no-store",
            }),
            "FIR manifest",
        ).then((response) => response.json()),
        fetchBytes("./fir-hit-scene/illuminate-hit-scene.wasm"),
    ]);
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
                "live untimed FIR hitTest; separate hitTestDiagnostic phase attribution",
            wasmBytes: wasmBytes.byteLength,
            firCommit: build.sources?.fir?.commit,
            illuminateCommit: build.sources?.illuminate?.commit,
        },
        benchmark: {
            create(/** @type {{ encodedScene: string }} */ { encodedScene }) {
                return createFirHitSceneHost(adapter, encodedScene);
            },
            query(/** @type {any} */ host, /** @type {number} */ x, /** @type {number} */ y) {
                return host.query(x, y);
            },
            dispose(/** @type {any} */ host) {
                host.dispose();
            },
        },
        createProfiled(/** @type {any} */ fixture, /** @type {any} */ observer) {
            return createFirHitSceneHost(adapter, fixture.encodedScene, observer);
        },
        dispose() {},
    };
}

/** @param {any[]} candidates @param {any} fixture @param {any} runPairedHitSceneBenchmark */
async function measureLiveFixture(candidates, fixture, runPairedHitSceneBenchmark) {
    const production = /** @type {any} */ (
        await runPairedHitSceneBenchmark(
            fixture,
            Object.fromEntries(
                candidates.map((candidate) => [candidate.name, candidate.benchmark]),
            ),
            { warmupRounds: 1, measuredRounds: 5, retainSamples: true, now },
        )
    );
    const diagnostics = profileCandidates(candidates, fixture);
    const firAvailable = candidates.some((candidate) => candidate.name === "fir");
    const firOverVir = firAvailable
        ? {
              median: production.fir.query.medianMs / production.vir.query.medianMs,
              pairedQueryRatio: {
                  median: summarize(
                      production.fir.samples.map(
                          (/** @type {number} */ sample, /** @type {number} */ index) =>
                              sample / production.vir.samples[index],
                      ),
                  ).medianMs,
              },
          }
        : null;
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

/** @param {(completed: number, total: number, name: string) => void} [onProgress] */
async function runLiveMeasurement(onProgress) {
    const { fetchHitSceneBenchmarkSuite, runPairedHitSceneBenchmark } =
        await import("../scripts/lib/hit-scene-benchmark.mjs");
    const suite = await fetchHitSceneBenchmarkSuite("./hit-scene-benchmark-suite.json");
    /** @type {any[]} */
    const candidates = [await loadVirCandidate()];
    const fir = await loadFirCandidate();
    if (fir !== null) candidates.push(fir);
    try {
        const workloads = [];
        for (const [index, fixture] of suite.fixtures.entries()) {
            workloads.push(
                await measureLiveFixture(candidates, fixture, runPairedHitSceneBenchmark),
            );
            onProgress?.(index + 1, suite.fixtures.length, fixture.name);
        }
        const primary =
            workloads.find((workload) => workload.fixture.geometryClass === "mixed") ??
            workloads[0];
        if (primary === undefined) throw new Error("live workload suite is empty");
        return {
            schemaVersion: "illuminate.hit-scene-tier-performance/v1",
            generatedAt: new Date().toISOString(),
            environment: { browser: navigator.userAgent },
            fixture: primary.fixture,
            protocol: {
                warmupRounds: 1,
                measuredRounds: 5,
                profileRounds: 2,
                samplesPerBackend: primary.fixture.queryCount * 5,
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
            workloads,
            caveats: [
                "This report was measured live in the current browser tab.",
                "The existing JavaScript widget has no independent hit-test algorithm; its baseline is Lean server RPC in the InfoView.",
                "The standalone runner compares browser-resident Lean through VIR and FIR only.",
                "Production samples use normal public query paths; detailed phase timing is collected in a separate pass.",
            ],
        };
    } finally {
        for (const candidate of candidates.toReversed()) candidate.dispose();
    }
}

/** @param {number | null | undefined} value */
function milliseconds(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    if (value < 0.001) return `${(value * 1000).toFixed(2)} µs`;
    return `${value.toFixed(3)} ms`;
}

/** @param {number} value */
function ratio(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)}×` : "—";
}

/**
 * @param {keyof HTMLElementTagNameMap} tag
 * @param {string} className
 * @param {string} [text]
 */
function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

/** @param {string} label @param {string} value */
function metric(label, value) {
    const node = element("div", "metric");
    node.append(element("small", "", label), element("strong", "", value));
    return node;
}

/**
 * @param {HitScenePerformanceReport} report
 * @param {HitScenePerformanceBackend} backend
 * @param {string | null} phase
 */
function phaseMedian(report, backend, phase) {
    if (phase === null) return null;
    return report.diagnostics?.[backend]?.phases?.[phase]?.medianMs ?? null;
}

/** @param {string} selector */
function requireElement(selector) {
    const node = document.querySelector(selector);
    if (!(node instanceof HTMLElement)) throw new Error(`missing report element ${selector}`);
    return node;
}

/** @param {HitScenePerformanceReport} report */
function render(report) {
    const production = report.production ?? {};
    const available = backendOrder.filter((backend) => production[backend] !== undefined);
    const medians = available.map((backend) => {
        const result = production[backend];
        if (result === undefined) throw new Error(`missing measured backend ${backend}`);
        return result.query.medianMs;
    });
    const fastest = Math.min(...medians);
    const slowest = Math.max(...medians);

    requireElement("[data-generated]").textContent =
        `${new Date(report.generatedAt).toLocaleString()} · ` +
        `${report.protocol.samplesPerBackend.toLocaleString()} samples per backend`;

    const cards = requireElement("[data-backend-cards]");
    cards.replaceChildren();
    for (const backend of backendOrder) {
        const result = production[backend];
        const card = element("article", `backend-card ${backend}${result ? "" : " unavailable"}`);
        const title = element("div", "backend-title");
        title.append(
            element("h2", "", backendLabels[backend]),
            element("span", "badge", result ? "measured" : "package not staged"),
        );
        card.append(title);
        if (result) {
            card.append(
                metric("Median query", milliseconds(result.query.medianMs)),
                metric("Mean query", milliseconds(result.query.meanMs)),
                metric("95th percentile", milliseconds(result.query.p95Ms)),
                metric("Maximum", milliseconds(result.query.maxMs)),
                metric("One-time creation", milliseconds(result.creationMs)),
            );
            const comparison = element("div", "relative-bar");
            const fill = element("i", "");
            fill.style.width = `${Math.max(4, (100 * result.query.medianMs) / slowest)}%`;
            comparison.append(fill);
            card.append(
                comparison,
                element(
                    "output",
                    "relative-label",
                    result.query.medianMs === fastest
                        ? "1.00× reference (fastest)"
                        : `${ratio(result.query.medianMs / fastest)} the fastest median`,
                ),
            );
        } else {
            card.append(
                element(
                    "p",
                    "empty",
                    "Stage the immutable FIR HitScene package and rerun the measurement command.",
                ),
            );
        }
        cards.append(card);
    }

    const headline = requireElement("[data-headline-ratio]");
    const delta = report.deltas?.firOverVir;
    const firOverVir = delta?.pairedQueryRatio?.median ?? delta?.median;
    headline.textContent = firOverVir
        ? `FIR ${ratio(1 / firOverVir)} faster than VIR on the mixed workload`
        : "FIR comparison pending";

    const phases = requireElement("[data-phase-grid]");
    phases.replaceChildren();
    for (const phase of phaseGroups) {
        /** @type {Record<HitScenePerformanceBackend, number | null>} */
        const values = {
            vir: phaseMedian(report, "vir", phase.vir),
            fir: phaseMedian(report, "fir", phase.fir),
        };
        const presentValues = Object.values(values).filter(
            /** @returns {value is number} */ (value) => value !== null && Number.isFinite(value),
        );
        const scale = Math.max(0.000001, ...presentValues);
        const group = element("article", "phase-group");
        const bars = element("div", "phase-bars");
        for (const backend of backendOrder) {
            const value = values[backend];
            const column = element("div", `phase-column ${backend}`);
            column.append(element("output", "", milliseconds(value)));
            const track = element("i", "");
            const fill = element("b", "");
            fill.style.height = value === null ? "0" : `${Math.max(1, (100 * value) / scale)}%`;
            track.append(fill);
            column.append(track, element("small", "", backend.toUpperCase()));
            bars.append(column);
        }
        group.append(bars, element("h3", "", phase.label));
        phases.append(group);
    }

    const notes = requireElement("[data-caveats]");
    notes.replaceChildren(
        ...report.caveats.map((note) => {
            const item = document.createElement("li");
            item.textContent = note;
            return item;
        }),
    );
    Reflect.set(window, "__illuminateHitSceneReport", report);
    document.body.dataset.ready = "true";
}

/** @param {any} profile */
function renderWorkloadProfile(profile) {
    const container = requireElement("[data-workloads]");
    container.replaceChildren();
    const maximum = Math.max(
        ...profile.workloads.map((/** @type {any} */ workload) => workload.aggregate.wall.medianMs),
    );
    for (const workload of profile.workloads) {
        const wall = workload.aggregate.wall.medianMs;
        const execute = workload.aggregate.phases.executeMs?.medianMs ?? 0;
        const card = element("article", "workload-card");
        const title = element("div", "workload-title");
        title.append(
            element("h3", "", workload.name),
            element("span", "badge", workload.geometryClass),
        );
        const bar = element("div", "workload-bar");
        const fill = element("i", "");
        fill.style.width = `${Math.max(1, (100 * wall) / maximum)}%`;
        bar.append(fill);
        const queryClasses = Object.entries(workload.byQueryClass ?? {});
        const classMaximum = Math.max(
            0.000001,
            ...queryClasses.map(([, result]) => result.wall.medianMs),
        );
        const breakdown = element("div", "query-classes");
        for (const [name, result] of queryClasses) {
            const row = element("div", "query-class");
            const label = element("span", "", name);
            const classBar = element("i", "");
            const classFill = element("b", "");
            classFill.style.width = `${Math.max(1, (100 * result.wall.medianMs) / classMaximum)}%`;
            classBar.append(classFill);
            row.append(label, classBar, element("output", "", milliseconds(result.wall.medianMs)));
            breakdown.append(row);
        }
        card.append(
            title,
            metric("Instrumented median", milliseconds(wall)),
            metric("Lean execution", milliseconds(execute)),
            metric("Encoded scene", `${workload.encodedBytes.toLocaleString()} B`),
            metric("Queries", workload.queryCount.toLocaleString()),
            bar,
            breakdown,
        );
        container.append(card);
    }
}

/** @param {any} report */
function renderTierPerformance(report) {
    const container = requireElement("[data-workloads]");
    container.replaceChildren();
    for (const workload of report.workloads ?? []) {
        const vir = workload.production?.vir?.query?.medianMs;
        const fir = workload.production?.fir?.query?.medianMs;
        const present = [vir, fir].filter(
            /** @returns {value is number} */ (value) => Number.isFinite(value),
        );
        const scale = Math.max(0.000001, ...present);
        const card = element("article", "workload-card");
        const title = element("div", "workload-title");
        title.append(
            element("h3", "", workload.fixture.name),
            element("span", "badge", workload.fixture.geometryClass),
        );
        const bars = element("div", "tier-bars");
        for (const [backend, value] of [
            ["vir", vir],
            ["fir", fir],
        ]) {
            const row = element("div", `tier-row ${backend}`);
            const track = element("i", "");
            const fill = element("b", "");
            fill.style.width = Number.isFinite(value)
                ? `${Math.max(1, (100 * value) / scale)}%`
                : "0";
            track.append(fill);
            row.append(
                element("span", "", backend.toUpperCase()),
                track,
                element("output", "", milliseconds(value)),
            );
            bars.append(row);
        }
        const speedup = Number.isFinite(vir) && Number.isFinite(fir) ? vir / fir : null;
        card.append(
            title,
            metric("Encoded scene", `${workload.fixture.encodedBytes.toLocaleString()} B`),
            metric("Queries", workload.fixture.queryCount.toLocaleString()),
            bars,
            element(
                "output",
                "tier-ratio",
                speedup === null ? "FIR package not staged" : `FIR ${speedup.toFixed(1)}× faster`,
            ),
        );
        container.append(card);
    }
}

/** @param {any} report */
function renderSpatialPerformance(report) {
    if (report.schemaVersion !== "illuminate.vir-spatial-hit-scene-performance/v2") {
        throw new Error(`unsupported spatial report ${String(report.schemaVersion)}`);
    }
    const panel = requireElement("[data-spatial-panel]");
    const summary = requireElement("[data-spatial-summary]");
    const container = requireElement("[data-spatial-workloads]");
    const spatialStability = report.stability?.spatial;
    const stabilityText = spatialStability
        ? ` ${spatialStability.simultaneousInstances} simultaneous spatial instances stayed at ` +
          `${(spatialStability.memoryAfterQueries / (1024 * 1024)).toFixed(1)} MiB through ` +
          `${spatialStability.measuredQueries.toLocaleString()} path queries and peer disposal.`
        : "";
    summary.textContent =
        `Measured ${new Date(report.generatedAt).toLocaleString()} with ` +
        `${report.protocol.measuredRounds} production and ${report.protocol.profileRounds} ` +
        `diagnostic rounds. Blue is reference VIR; purple is spatial VIR.${stabilityText}`;
    container.replaceChildren();
    for (const workload of report.workloads ?? []) {
        const reference = workload.timing.reference.query.medianMs;
        const spatial = workload.timing.spatial.query.medianMs;
        const scale = Math.max(reference, spatial, 0.000001);
        const card = element("article", "workload-card");
        const title = element("div", "workload-title");
        title.append(
            element("h3", "", workload.name),
            element("span", "badge", workload.geometryClass),
        );
        const bars = element("div", "tier-bars");
        for (const [backend, value] of [
            ["reference", reference],
            ["spatial", spatial],
        ]) {
            const row = element("div", `tier-row ${backend}`);
            const track = element("i", "");
            const fill = element("b", "");
            fill.style.width = `${Math.max(1, (100 * value) / scale)}%`;
            track.append(fill);
            row.append(
                element("span", "", backend === "reference" ? "REF" : "IDX"),
                track,
                element("output", "", milliseconds(value)),
            );
            bars.append(row);
        }
        const classRows = element("div", "spatial-classes");
        const classes = Object.entries(workload.classRatios?.byQueryAndResultClass ?? {}).sort(
            ([, left], [, right]) =>
                right.referenceExecute.medianMs - left.referenceExecute.medianMs,
        );
        for (const [name, result] of classes) {
            const classScale = Math.max(
                result.referenceExecute.medianMs,
                result.spatialExecute.medianMs,
                0.000001,
            );
            const row = element("div", "spatial-class");
            const classBars = element("div", "spatial-class-bars");
            for (const value of [
                result.referenceExecute.medianMs,
                result.spatialExecute.medianMs,
            ]) {
                const track = element("i", "");
                const fill = element("b", "");
                fill.style.width = `${Math.max(1, (100 * value) / classScale)}%`;
                track.append(fill);
                classBars.append(track);
            }
            row.title =
                `${name} · ${result.samplesPerBackend} samples/backend · ` +
                `reference ${milliseconds(result.referenceExecute.medianMs)} · ` +
                `spatial ${milliseconds(result.spatialExecute.medianMs)}`;
            row.append(
                element("span", "", name),
                classBars,
                element("output", "", `${result.executeSpeedupMedian.toFixed(2)}×`),
            );
            classRows.append(row);
        }
        card.append(
            title,
            metric("Encoded scene", `${workload.encodedBytes.toLocaleString()} B`),
            metric("Queries", workload.queryCount.toLocaleString()),
            bars,
            element(
                "output",
                "tier-ratio",
                `Spatial ${(reference / spatial).toFixed(2)}× faster at median`,
            ),
            classRows,
        );
        container.append(card);
    }
    panel.hidden = false;
}

/** @param {any} workload */
function workloadRatio(workload) {
    const delta = workload.deltas?.firOverVir;
    const value = delta?.pairedQueryRatio?.median ?? delta?.median;
    return Number.isFinite(value) && value > 0 ? value : null;
}

/** @param {any[]} records */
function renderHistory(records) {
    const panel = requireElement("[data-history-panel]");
    const container = requireElement("[data-history]");
    const usable = records.filter((record) => record.workloads.some(workloadRatio));
    if (usable.length === 0) {
        panel.hidden = true;
        return;
    }

    /** @type {Map<string, number>} */
    const baselines = new Map();
    for (const record of usable) {
        for (const workload of record.workloads) {
            const value = workloadRatio(workload);
            if (value !== null && !baselines.has(workload.fixture.name)) {
                baselines.set(workload.fixture.name, value);
            }
        }
    }
    const recent = usable.slice(-12).toReversed();
    const maximum = Math.max(
        1,
        ...recent.flatMap((record) => record.workloads.map(workloadRatio).filter(Number.isFinite)),
    );
    requireElement("[data-history-summary]").textContent =
        `${usable.length.toLocaleString()} recorded paired run${usable.length === 1 ? "" : "s"}. ` +
        "The first retained ratio for each workload is its baseline; the vertical mark is 1×.";
    container.replaceChildren();
    for (const record of recent) {
        const row = element("article", "history-run");
        const heading = element("div", "history-heading");
        const revision = record.source?.commit?.slice(0, 8) ?? "unknown source";
        heading.append(
            element("strong", "", record.label ?? new Date(record.generatedAt).toLocaleString()),
            element("span", "", `${revision} · ${new Date(record.generatedAt).toLocaleString()}`),
        );
        const ratios = element("div", "history-ratios");
        for (const workload of record.workloads) {
            const value = workloadRatio(workload);
            if (value === null) continue;
            const baseline = baselines.get(workload.fixture.name) ?? value;
            const change = (100 * (value - baseline)) / baseline;
            const cell = element("div", "history-ratio");
            const title = element("div", "history-ratio-title");
            title.append(
                element("span", "", workload.fixture.name),
                element(
                    "output",
                    "",
                    value <= 1
                        ? `FIR ${(1 / value).toFixed(2)}× faster`
                        : `FIR/VIR ${value.toFixed(2)}×`,
                ),
            );
            const track = element("div", "history-track");
            const fill = element("i", "");
            fill.style.width = `${Math.max(1, (100 * value) / maximum)}%`;
            const unit = element("b", "");
            unit.style.left = `${Math.min(99.5, 100 / maximum)}%`;
            track.append(fill, unit);
            cell.append(
                title,
                track,
                element(
                    "small",
                    "",
                    `${value.toFixed(3)}× FIR/VIR · ${change >= 0 ? "+" : ""}${change.toFixed(1)}% vs baseline`,
                ),
            );
            ratios.append(cell);
        }
        row.append(heading, ratios);
        container.append(row);
    }
    panel.hidden = false;
}

async function loadHistory() {
    try {
        const response = await fetch("./hit-scene-performance-history.jsonl", {
            cache: "no-store",
        });
        if (response.status === 404) return;
        renderHistory(
            parseHitScenePerformanceHistory(
                await requireOk(response, "HitScene performance history").then((item) =>
                    item.text(),
                ),
            ),
        );
    } catch (error) {
        const panel = requireElement("[data-history-panel]");
        requireElement("[data-history-summary]").textContent =
            `Could not load recorded history: ${error instanceof Error ? error.message : String(error)}`;
        panel.hidden = false;
    }
}

async function loadWorkloadProfile() {
    const tierResponse = await fetch("./hit-scene-tier-performance.json", {
        cache: "no-store",
    });
    if (tierResponse.ok) {
        renderTierPerformance(
            await requireOk(tierResponse, "FIR/VIR tier report").then((item) => item.json()),
        );
        return;
    }
    const response = await fetch("./vir-hit-scene-profile.json", { cache: "no-store" });
    if (response.status === 404) return;
    renderWorkloadProfile(
        await requireOk(response, "VIR workload profile").then((item) => item.json()),
    );
}

async function loadSpatialPerformance() {
    const response = await fetch("./vir-spatial-hit-scene-performance.json", {
        cache: "no-store",
    });
    if (response.status === 404) return;
    renderSpatialPerformance(
        await requireOk(response, "VIR spatial performance report").then((item) => item.json()),
    );
}

async function main() {
    try {
        const response = await fetch("./hit-scene-performance.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`measurement report returned HTTP ${response.status}`);
        render(/** @type {HitScenePerformanceReport} */ (await response.json()));
        await loadWorkloadProfile();
        await loadSpatialPerformance();
        await loadHistory();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        requireElement("[data-status]").textContent = `Could not load measurement: ${message}`;
        document.body.dataset.ready = "error";
    }
}

const liveButton = requireElement("[data-run-live]");
liveButton.addEventListener("click", async function () {
    if (!(liveButton instanceof HTMLButtonElement)) return;
    const liveStatus = requireElement("[data-live-status]");
    const liveProgress = requireElement("[data-live-progress]");
    liveButton.disabled = true;
    liveProgress.hidden = false;
    if (liveProgress instanceof HTMLProgressElement) {
        liveProgress.max = 3;
        liveProgress.value = 0;
    }
    liveStatus.textContent = "Loading VIR, FIR, and the three retained-scene workloads…";
    try {
        const report = await runLiveMeasurement(function (completed, total, name) {
            if (liveProgress instanceof HTMLProgressElement) {
                liveProgress.max = total;
                liveProgress.value = completed;
            }
            liveStatus.textContent = `Measured ${name} (${completed} of ${total} workloads).`;
        });
        render(/** @type {HitScenePerformanceReport} */ (report));
        renderTierPerformance(report);
        liveStatus.textContent =
            report.production.fir === undefined
                ? "Live VIR workload suite complete; no FIR package is staged."
                : "Live paired VIR/FIR workload suite complete; every result matched.";
    } catch (error) {
        liveStatus.textContent = `Live measurement failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
        liveButton.disabled = false;
        liveProgress.hidden = true;
    }
});

void main();
