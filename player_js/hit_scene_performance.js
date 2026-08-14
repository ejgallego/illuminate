// @ts-check

import { createFirHitSceneHost } from "./fir_hit_scene.js";
import { parseHitScenePerformanceHistory } from "./hit_scene_performance_history.js";
import { createVirHitSceneHost, createVirSpatialHitSceneHost } from "./vir_hit_scene.js";

/**
 * @typedef {"vir" | "fir" | "spatial" | "spatialFir"} HitScenePerformanceBackend
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

const backendOrder = /** @type {const} */ (["vir", "fir", "spatial", "spatialFir"]);
/** @type {Record<HitScenePerformanceBackend, string>} */
const backendLabels = {
    vir: "Reference · VIR",
    fir: "Reference · FIR",
    spatial: "Spatial · VIR",
    spatialFir: "Spatial · FIR",
};
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

async function loadSpatialVirCandidate() {
    const runtimeModuleUrl = new URL("./vir/sdk/js/vir-runtime.js", location.href).href;
    const runtimeModule = await import(runtimeModuleUrl);
    const wasmBytes = await fetchBytes("./vir/sdk/wasm/vir-upstream.wasm");
    const descriptorUrl = new URL(
        "./vir/module-sets/Illuminate/Diagram/HitScene/SpatialVir/SpatialVir.irpkg-set.json",
        location.href,
    );
    const descriptor = /** @type {{ packages: Array<{ path: string }> }} */ (
        await requireOk(
            await fetch(descriptorUrl, { cache: "no-store" }),
            "spatial VIR package set",
        ).then((response) => response.json())
    );
    const packageSetBytes = await Promise.all(
        descriptor.packages.map((member) => fetchBytes(new URL(member.path, descriptorUrl))),
    );
    const runtime = await runtimeModule.createVirRuntime({
        wasmBytes,
        irPackageSetBytes: packageSetBytes,
    });
    return {
        name: "spatial",
        label: "Spatial VIR",
        metadata: {
            available: true,
            measurementMode: "live browser runtime.call; diagnostic runtime.callTimed",
            wasmBytes: wasmBytes.byteLength,
            packageMembers: descriptor.packages.length,
        },
        benchmark: {
            create(/** @type {{ encodedScene: string }} */ { encodedScene }) {
                return createVirSpatialHitSceneHost(runtime, encodedScene);
            },
            query(/** @type {any} */ host, /** @type {number} */ x, /** @type {number} */ y) {
                return host.query(x, y);
            },
            dispose(/** @type {any} */ host) {
                host.dispose();
            },
        },
        createProfiled(/** @type {any} */ fixture, /** @type {any} */ observer) {
            return createVirSpatialHitSceneHost(runtime, fixture.encodedScene, observer);
        },
        create(/** @type {any} */ fixture) {
            return createVirSpatialHitSceneHost(runtime, fixture.encodedScene);
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

async function loadSpatialFirCandidate() {
    const buildResponse = await fetch("./fir-spatial-hit-scene/BUILD.json", {
        cache: "no-store",
    });
    if (buildResponse.status === 404) return null;
    const build = await requireOk(buildResponse, "spatial FIR BUILD.json").then((response) =>
        response.json(),
    );
    if (
        build.capabilities?.browserAdapter?.apiVersion !==
            "fir.illuminate-spatial-hit-scene.browser/v1" ||
        build.capabilities?.inputLayout?.version !== "lean-4.33-Illuminate.SpatialHitScene/v1"
    ) {
        return null;
    }
    const adapterUrl = new URL(
        "./fir-spatial-hit-scene/illuminate-spatial-hit-scene-browser-adapter.mjs",
        location.href,
    ).href;
    const [adapterModule, wasmBytes] = await Promise.all([
        import(adapterUrl),
        fetchBytes("./fir-spatial-hit-scene/illuminate-spatial-hit-scene.wasm"),
    ]);
    const adapter = await adapterModule.createIlluminateSpatialHitSceneAdapter({
        bytes: wasmBytes,
        build,
    });
    return {
        name: "spatialFir",
        label: "Spatial FIR",
        metadata: {
            available: true,
            measurementMode:
                "live untimed spatial FIR hitTest; separate hitTestDiagnostic phase attribution",
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
        create(/** @type {any} */ fixture) {
            return createFirHitSceneHost(adapter, fixture.encodedScene);
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
    /** @param {string} candidate @param {string} reference */
    function pairedDelta(candidate, reference) {
        if (production[candidate] === undefined || production[reference] === undefined) return null;
        return {
            median: production[candidate].query.medianMs / production[reference].query.medianMs,
            pairedQueryRatio: {
                median: summarize(
                    production[candidate].samples.map(
                        (/** @type {number} */ sample, /** @type {number} */ index) =>
                            sample / production[reference].samples[index],
                    ),
                ).medianMs,
            },
        };
    }
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
        deltas: {
            firOverVir: pairedDelta("fir", "vir"),
            spatialFirOverSpatialVir: pairedDelta("spatialFir", "spatial"),
            spatialVirOverVir: pairedDelta("spatial", "vir"),
            spatialFirOverFir: pairedDelta("spatialFir", "fir"),
        },
    };
}

/** @param {(completed: number, total: number, name: string) => void} [onProgress] */
async function runLiveMeasurement(onProgress) {
    const { fetchHitSceneBenchmarkSuite, runPairedHitSceneBenchmark } =
        await import("../scripts/lib/hit-scene-benchmark.mjs");
    const suite = await fetchHitSceneBenchmarkSuite("./hit-scene-benchmark-suite.json");
    /** @type {any[]} */
    const candidates = [await loadVirCandidate(), await loadSpatialVirCandidate()];
    const fir = await loadFirCandidate();
    if (fir !== null) candidates.push(fir);
    const spatialFir = await loadSpatialFirCandidate();
    if (spatialFir !== null) candidates.push(spatialFir);
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
                "The standalone runner compares the reference and spatial Lean algorithms through VIR and FIR.",
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
            spatial: phaseMedian(report, "spatial", phase.vir),
            spatialFir: phaseMedian(report, "spatialFir", phase.fir),
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
        const values = Object.fromEntries(
            backendOrder.map((backend) => [
                backend,
                workload.production?.[backend]?.query?.medianMs,
            ]),
        );
        const present = Object.values(values).filter(
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
        for (const backend of backendOrder) {
            const value = values[backend];
            const row = element("div", `tier-row ${backend}`);
            const track = element("i", "");
            const fill = element("b", "");
            fill.style.width = Number.isFinite(value)
                ? `${Math.max(1, (100 * value) / scale)}%`
                : "0";
            track.append(fill);
            row.append(
                element("span", "", backendLabels[backend]),
                track,
                element("output", "", milliseconds(value)),
            );
            bars.append(row);
        }
        const referenceRatio =
            Number.isFinite(values.vir) && Number.isFinite(values.fir)
                ? values.fir / values.vir
                : null;
        const spatialRatio =
            Number.isFinite(values.spatial) && Number.isFinite(values.spatialFir)
                ? values.spatialFir / values.spatial
                : null;
        const ratioSummary = [
            referenceRatio === null ? null : `reference FIR/VIR ${referenceRatio.toFixed(2)}×`,
            spatialRatio === null ? null : `spatial FIR/VIR ${spatialRatio.toFixed(2)}×`,
        ]
            .filter(Boolean)
            .join(" · ");
        card.append(
            title,
            metric("Encoded scene", `${workload.fixture.encodedBytes.toLocaleString()} B`),
            metric("Queries", workload.fixture.queryCount.toLocaleString()),
            bars,
            element("output", "tier-ratio", ratioSummary || "FIR package pair not staged"),
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

const svgNamespace = "http://www.w3.org/2000/svg";
const hitProbeBatchSize = 16;
const hitProbeWindowSize = 120;

/** @param {string} name @param {Record<string, string | number>} attributes */
function svgElement(name, attributes = {}) {
    const node = document.createElementNS(svgNamespace, name);
    for (const [key, value] of Object.entries(attributes)) {
        node.setAttribute(key, String(value));
    }
    return node;
}

/** @param {any} left @param {any} right */
function multiplyMatrix(left, right) {
    return {
        a: left.a * right.a + left.b * right.c,
        b: left.a * right.b + left.b * right.d,
        tx: left.a * right.tx + left.b * right.ty + left.tx,
        c: left.c * right.a + left.d * right.c,
        d: left.c * right.b + left.d * right.d,
        ty: left.c * right.tx + left.d * right.ty + left.ty,
    };
}

/** @param {any} matrix */
function invertMatrix(matrix) {
    const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
    return {
        a: matrix.d / determinant,
        b: -matrix.b / determinant,
        tx: (matrix.b * matrix.ty - matrix.d * matrix.tx) / determinant,
        c: -matrix.c / determinant,
        d: matrix.a / determinant,
        ty: (matrix.c * matrix.tx - matrix.a * matrix.ty) / determinant,
    };
}

/** @param {any} matrix */
function svgMatrix(matrix) {
    return `matrix(${matrix.a} ${matrix.c} ${matrix.b} ${matrix.d} ${matrix.tx} ${matrix.ty})`;
}

/** @param {any[]} commands */
function pathData(commands) {
    return commands
        .map((command) => {
            switch (command.kind) {
                case "moveTo":
                    return `M ${command.point.x} ${command.point.y}`;
                case "lineTo":
                    return `L ${command.point.x} ${command.point.y}`;
                case "curveTo":
                    return (
                        `C ${command.control1.x} ${command.control1.y} ` +
                        `${command.control2.x} ${command.control2.y} ` +
                        `${command.endpoint.x} ${command.endpoint.y}`
                    );
                case "arcTo":
                    return (
                        `A ${command.rx} ${command.ry} ${command.rotation} ` +
                        `${command.largeArc ? 1 : 0} ${command.sweep ? 1 : 0} ` +
                        `${command.endpoint.x} ${command.endpoint.y}`
                    );
                case "closePath":
                    return "Z";
                default:
                    return "";
            }
        })
        .join(" ");
}

/** @param {number | null} tag */
function hitSceneColor(tag) {
    return tag === null ? "#91a5cb" : `hsl(${(tag * 67) % 360} 78% 68%)`;
}

/** @param {SVGElement} target @param {any} tree @param {any} transform @param {number | null} tag */
function appendHitTree(target, tree, transform, tag = null) {
    if (tree === null || typeof tree !== "object") return;
    switch (tree.kind) {
        case "empty":
            return;
        case "compose":
            appendHitTree(target, tree.back, transform, tag);
            appendHitTree(target, tree.front, transform, tag);
            return;
        case "tag":
            appendHitTree(target, tree.child, transform, Number(tree.value));
            return;
        case "transform": {
            const forward = invertMatrix(tree.inverse);
            if (forward !== null) {
                appendHitTree(target, tree.child, multiplyMatrix(transform, forward), tag);
            }
            return;
        }
        case "clip":
            appendHitTree(target, tree.child, transform, tag);
            return;
        case "primitive":
            break;
        default:
            return;
    }
    const primitive = tree.value;
    if (primitive === null || typeof primitive !== "object") return;
    const color = hitSceneColor(tag);
    let shape;
    if (primitive.kind === "bounds") {
        shape = svgElement("rect", {
            x: primitive.left,
            y: primitive.bottom,
            width: primitive.right - primitive.left,
            height: primitive.top - primitive.bottom,
            rx: 0.8,
        });
        shape.setAttribute("fill", `${color}35`);
        shape.setAttribute("stroke", color);
        shape.setAttribute("stroke-width", "0.8");
    } else if (primitive.kind === "path") {
        shape = svgElement("path", { d: pathData(primitive.data ?? []) });
        shape.setAttribute("fill", primitive.hasFill ? `${color}42` : "none");
        shape.setAttribute("stroke", color);
        shape.setAttribute("stroke-width", String(Math.max(0.45, primitive.strokeWidth ?? 0)));
    } else {
        return;
    }
    shape.setAttribute("transform", svgMatrix(transform));
    shape.setAttribute("vector-effect", "non-scaling-stroke");
    if (tag !== null) shape.setAttribute("data-hit-tag", String(tag));
    target.appendChild(shape);
}

/** @param {any} fixture @param {SVGSVGElement} svg */
function renderHitProbeScene(fixture, svg) {
    const xValues = fixture.queries.map((/** @type {any} */ query) => query.x);
    const yValues = fixture.queries.map((/** @type {any} */ query) => query.y);
    const left = Math.min(...xValues);
    const right = Math.max(...xValues);
    const bottom = Math.min(...yValues);
    const top = Math.max(...yValues);
    const padding = Math.max(3, Math.max(right - left, top - bottom) * 0.06);
    svg.setAttribute(
        "viewBox",
        `${left - padding} ${-(top + padding)} ${right - left + 2 * padding} ${top - bottom + 2 * padding}`,
    );
    const world = /** @type {SVGGElement} */ (
        svgElement("g", { transform: "scale(1 -1)", "data-probe-world": "" })
    );
    appendHitTree(world, fixture.parsedScene.tree, { a: 1, b: 0, tx: 0, c: 0, d: 1, ty: 0 });
    const horizontal = svgElement("line", {
        x1: left - padding,
        x2: right + padding,
        y1: 0,
        y2: 0,
        class: "probe-axis",
    });
    const vertical = svgElement("line", {
        x1: 0,
        x2: 0,
        y1: bottom - padding,
        y2: top + padding,
        class: "probe-axis",
    });
    const cursor = svgElement("g", { "data-probe-cursor": "" });
    cursor.append(
        svgElement("circle", { r: 1.5 }),
        svgElement("line", { x1: -3, x2: 3, y1: 0, y2: 0 }),
        svgElement("line", { x1: 0, x2: 0, y1: -3, y2: 3 }),
    );
    world.append(horizontal, vertical, cursor);
    svg.replaceChildren(world);
    return {
        left: left - padding,
        right: right + padding,
        bottom: bottom - padding,
        top: top + padding,
        world,
        cursor,
    };
}

/** @param {number[]} samples */
function rollingMedian(samples) {
    const sorted = [...samples].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** @param {number[]} samples @param {number} quantile */
function rollingPercentile(samples, quantile) {
    const sorted = [...samples].sort((left, right) => left - right);
    if (sorted.length === 0) return 0;
    return sorted[Math.ceil((sorted.length - 1) * quantile)] ?? 0;
}

/** @param {number[]} samples @param {number} value */
function pushRolling(samples, value) {
    samples.push(value);
    if (samples.length > hitProbeWindowSize) samples.shift();
}

async function createHitProbeSession() {
    const { fetchHitSceneBenchmarkSuite } = await import("../scripts/lib/hit-scene-benchmark.mjs");
    const suite = await fetchHitSceneBenchmarkSuite("./hit-scene-benchmark-suite.json");
    const reference = await loadVirCandidate();
    /** @type {any[]} */
    const candidates = [
        {
            name: "vir",
            label: "Reference VIR",
            create: (/** @type {any} */ fixture) =>
                reference.benchmark.create({ encodedScene: fixture.encodedScene }),
            dispose: () => reference.dispose(),
        },
    ];
    try {
        candidates.push(await loadSpatialVirCandidate());
    } catch (error) {
        console.info("Spatial VIR live probe is unavailable", error);
    }
    const fir = await loadFirCandidate();
    if (fir !== null) {
        candidates.push({
            name: "fir",
            label: "FIR native Wasm",
            create: (/** @type {any} */ fixture) =>
                fir.benchmark.create({ encodedScene: fixture.encodedScene }),
            dispose: () => fir.dispose(),
        });
    }
    const spatialFir = await loadSpatialFirCandidate();
    if (spatialFir !== null) {
        candidates.push({
            name: "spatialFir",
            label: "Spatial FIR",
            create: (/** @type {any} */ fixture) => spatialFir.create(fixture),
            dispose: () => spatialFir.dispose(),
        });
    }
    /** @type {Array<{ candidate: any, host: any, samples: number[], comparisonSamples: Map<string, { ratios: number[], deltas: number[] }> }>} */
    let mounted = [];
    let queryNumber = 0;

    function unmount() {
        for (const item of mounted.toReversed()) item.host.dispose();
        mounted = [];
    }

    return {
        fixtures: suite.fixtures,
        candidates,
        mount(/** @type {any} */ fixture) {
            unmount();
            mounted = candidates.map((candidate) => ({
                candidate,
                host: candidate.create(fixture),
                samples: [],
                comparisonSamples: new Map(),
            }));
            queryNumber = 0;
        },
        query(/** @type {number} */ x, /** @type {number} */ y) {
            const order = mounted.map(
                (_, index) => mounted[(index + queryNumber) % mounted.length],
            );
            queryNumber += 1;
            const observations = order.map((item) => {
                const started = now();
                let result;
                for (let index = 0; index < hitProbeBatchSize; index += 1) {
                    result = item.host.query(x, y);
                }
                const duration = (now() - started) / hitProbeBatchSize;
                pushRolling(item.samples, duration);
                return {
                    item,
                    name: item.candidate.name,
                    label: item.candidate.label,
                    result,
                    duration,
                    median: rollingMedian(item.samples),
                    p95: rollingPercentile(item.samples, 0.95),
                    count: item.samples.length,
                };
            });
            const expected = observations[0]?.result;
            for (const observation of observations.slice(1)) {
                if (!sameResult(observation.result, expected)) {
                    throw new Error(
                        `live HitScene mismatch at (${x.toFixed(3)}, ${y.toFixed(3)}): ` +
                            `${observations[0].name}=${JSON.stringify(expected)}, ` +
                            `${observation.name}=${JSON.stringify(observation.result)}`,
                    );
                }
            }
            return observations.map((observation) => {
                const comparisons = Object.fromEntries(
                    observations.map((reference) => {
                        let samples = observation.item.comparisonSamples.get(reference.name);
                        if (samples === undefined) {
                            samples = { ratios: [], deltas: [] };
                            observation.item.comparisonSamples.set(reference.name, samples);
                        }
                        pushRolling(
                            samples.ratios,
                            reference.duration > 0 ? observation.duration / reference.duration : 1,
                        );
                        pushRolling(samples.deltas, observation.duration - reference.duration);
                        return [
                            reference.name,
                            {
                                ratioMedian: rollingMedian(samples.ratios),
                                ratioP95: rollingPercentile(samples.ratios, 0.95),
                                deltaMedian: rollingMedian(samples.deltas),
                            },
                        ];
                    }),
                );
                return {
                    name: observation.name,
                    label: observation.label,
                    result: observation.result,
                    duration: observation.duration,
                    median: observation.median,
                    p95: observation.p95,
                    count: observation.count,
                    comparisons,
                };
            });
        },
        dispose() {
            unmount();
            for (const candidate of candidates.toReversed()) candidate.dispose();
        },
    };
}

/** @param {any} result */
function hitResultLabel(result) {
    if (result?.kind === "tag") {
        return result.label ? `tag ${result.value} · ${result.label}` : `tag ${result.value}`;
    }
    return result?.kind ?? "unknown";
}

function installHitProbe() {
    const toggle = /** @type {HTMLButtonElement} */ (requireElement("[data-probe-toggle]"));
    const fixtureSelect = /** @type {HTMLSelectElement} */ (requireElement("[data-probe-fixture]"));
    const autoInput = /** @type {HTMLInputElement} */ (requireElement("[data-probe-auto]"));
    const status = requireElement("[data-probe-status]");
    const coordinates = requireElement("[data-probe-coordinates]");
    const backendList = requireElement("[data-probe-backends]");
    const chart = requireElement("[data-probe-chart]");
    const chartRows = requireElement("[data-probe-chart-rows]");
    const chartNote = requireElement("[data-probe-chart-note]");
    const svg = document.querySelector("[data-probe-svg]");
    if (
        !(toggle instanceof HTMLButtonElement) ||
        !(fixtureSelect instanceof HTMLSelectElement) ||
        !(autoInput instanceof HTMLInputElement) ||
        !(svg instanceof SVGSVGElement)
    ) {
        throw new Error("HitScene live probe controls are incomplete");
    }
    const probeSvg = svg;
    /** @type {Awaited<ReturnType<typeof createHitProbeSession>> | null} */
    let session = null;
    /** @type {ReturnType<typeof renderHitProbeScene> | null} */
    let scene = null;
    /** @type {number | null} */
    let animationFrame = null;
    let startedAt = 0;
    let lastQueryAt = 0;
    let disposed = false;

    function selectedFixture() {
        return (
            session?.fixtures.find(
                (/** @type {any} */ fixture) => fixture.name === fixtureSelect.value,
            ) ?? null
        );
    }

    function renderBackends() {
        backendList.replaceChildren();
        chartRows.replaceChildren();
        const candidates = session?.candidates ?? [];
        for (const candidate of candidates) {
            const card = element("article", `probe-backend ${candidate.name}`);
            card.dataset.probeBackend = candidate.name;
            card.append(
                element("strong", "", candidate.label),
                element("output", "probe-result", "waiting for a query"),
                element("small", "probe-timing", "—"),
            );
            backendList.append(card);
        }

        for (const groupSpec of [
            {
                id: "runtime-reference",
                title: "Runtime boundary · reference algorithm",
                detail: "VIR interpreter versus FIR native Wasm",
                names: ["vir", "fir"],
                reference: "vir",
            },
            {
                id: "runtime-spatial",
                title: "Runtime boundary · spatial algorithm",
                detail: "VIR interpreter versus FIR native Wasm",
                names: ["spatial", "spatialFir"],
                reference: "spatial",
            },
            {
                id: "algorithm-vir",
                title: "Algorithm · VIR interpreter",
                detail: "reference tree versus spatial tree",
                names: ["vir", "spatial"],
                reference: "vir",
            },
            {
                id: "algorithm-fir",
                title: "Algorithm · FIR native Wasm",
                detail: "reference tree versus spatial tree",
                names: ["fir", "spatialFir"],
                reference: "fir",
            },
        ]) {
            const groupCandidates = groupSpec.names
                .map((name) => candidates.find((item) => item.name === name))
                .filter((candidate) => candidate !== undefined);
            if (groupCandidates.length < 2) continue;
            const group = element("section", "probe-chart-group");
            group.dataset.probeChartGroup = groupSpec.id;
            const heading = element("header", "probe-chart-group-heading");
            heading.append(
                element("strong", "", groupSpec.title),
                element("small", "", groupSpec.detail),
            );
            group.append(heading);
            for (const candidate of groupCandidates) {
                const row = element("div", `probe-chart-row ${candidate.name}`);
                row.dataset.probeChartBackend = candidate.name;
                row.dataset.probeChartComparison = groupSpec.id;
                row.dataset.probeChartReference = groupSpec.reference;
                const label = element("div", "probe-chart-label");
                label.append(
                    element("span", "", candidate.label),
                    element("output", "", "warming…"),
                );
                const track = element("div", "probe-chart-track");
                track.append(element("i", ""), element("b", ""));
                row.append(label, track, element("small", "probe-chart-tail", "p95 warming…"));
                group.append(row);
            }
            chartRows.append(group);
        }
        chart.dataset.state = "warming";
        chartNote.textContent = `${hitProbeBatchSize}-query paired batches are warming; all bars share one zero-based scale.`;
    }

    /** @param {Array<{ name: string, label: string, median: number, p95: number, count: number, comparisons: Record<string, { ratioMedian: number, ratioP95: number, deltaMedian: number }> }>} observations */
    function renderLiveComparison(observations) {
        const maximum = Math.max(0, ...observations.map((observation) => observation.median));
        const scale = maximum > 0 ? maximum : 1;
        const minimumSamples = Math.min(...observations.map((observation) => observation.count));
        for (const observation of observations) {
            const rows = chartRows.querySelectorAll(
                `[data-probe-chart-backend="${observation.name}"]`,
            );
            for (const row of rows) {
                const fill = row.querySelector(".probe-chart-track i");
                const marker = row.querySelector(".probe-chart-track b");
                const output = row.querySelector("output");
                const tail = row.querySelector(".probe-chart-tail");
                const referenceName =
                    row instanceof HTMLElement ? row.dataset.probeChartReference : undefined;
                const reference = observations.find((item) => item.name === referenceName);
                const comparison = referenceName
                    ? observation.comparisons[referenceName]
                    : undefined;
                if (reference === undefined || comparison === undefined) continue;
                const referencePosition = Math.min(99.5, (100 * reference.median) / scale);
                if (fill instanceof HTMLElement) {
                    fill.style.width = `${Math.max(1, (100 * observation.median) / scale)}%`;
                }
                if (marker instanceof HTMLElement) marker.style.left = `${referencePosition}%`;
                if (output) {
                    output.textContent =
                        `${(observation.median * 1000).toFixed(1)} µs · ` +
                        `${comparison.ratioMedian.toFixed(2)}× ${reference.label}`;
                }
                if (tail) {
                    const delta = comparison.deltaMedian * 1000;
                    tail.textContent =
                        `p95 ${(observation.p95 * 1000).toFixed(1)} µs · ` +
                        `paired Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} µs · ` +
                        `ratio p95 ${comparison.ratioP95.toFixed(2)}×`;
                }
            }
        }
        const stable = minimumSamples >= 30;
        chart.dataset.state = stable ? "stable" : "warming";
        chartNote.textContent = stable
            ? `${minimumSamples} matched ${hitProbeBatchSize}-query batches; ratios and deltas are paired by coordinate.`
            : `Warming: ${minimumSamples}/30 matched batches before the comparison settles.`;
    }

    function chooseFixture() {
        const fixture = selectedFixture();
        if (session === null || fixture === null) return;
        session.mount(fixture);
        scene = renderHitProbeScene(fixture, probeSvg);
        renderBackends();
        queryPoint((scene.left + scene.right) / 2, (scene.bottom + scene.top) / 2);
    }

    /** @param {number} x @param {number} y */
    function queryPoint(x, y) {
        if (session === null || scene === null) return;
        const observations = session.query(x, y);
        scene.cursor.setAttribute("transform", `translate(${x} ${y})`);
        const result = observations[0]?.result;
        scene.cursor.setAttribute("data-result", result?.kind ?? "unknown");
        coordinates.textContent = `x ${x.toFixed(2)} · y ${y.toFixed(2)}`;
        for (const observation of observations) {
            const card = backendList.querySelector(`[data-probe-backend="${observation.name}"]`);
            if (!(card instanceof HTMLElement)) continue;
            const resultOutput = card.querySelector(".probe-result");
            const timing = card.querySelector(".probe-timing");
            if (resultOutput) resultOutput.textContent = hitResultLabel(observation.result);
            if (timing) {
                timing.textContent =
                    `${milliseconds(observation.duration)} last batch mean · ` +
                    `${milliseconds(observation.median)} rolling median · ` +
                    `${milliseconds(observation.p95)} p95 · ` +
                    `${observation.count} batches`;
            }
        }
        renderLiveComparison(observations);
    }

    /** @param {number} timestamp */
    function animate(timestamp) {
        animationFrame = null;
        if (session === null || scene === null || disposed) return;
        if (autoInput.checked && timestamp - lastQueryAt >= 32) {
            const elapsed = (timestamp - startedAt) / 1000;
            const centerX = (scene.left + scene.right) / 2;
            const centerY = (scene.bottom + scene.top) / 2;
            const radiusX = (scene.right - scene.left) * 0.43;
            const radiusY = (scene.top - scene.bottom) * 0.39;
            queryPoint(
                centerX + Math.cos(elapsed * 0.91) * radiusX,
                centerY + Math.sin(elapsed * 1.37) * radiusY,
            );
            lastQueryAt = timestamp;
        }
        animationFrame = requestAnimationFrame(animate);
    }

    function stop() {
        if (animationFrame !== null) cancelAnimationFrame(animationFrame);
        animationFrame = null;
        session?.dispose();
        session = null;
        scene = null;
        toggle.textContent = "Start live probe";
        toggle.dataset.state = "stopped";
        fixtureSelect.disabled = true;
        autoInput.disabled = true;
        status.textContent = "Probe stopped; retained scene handles and runtimes were released.";
        chart.dataset.state = "stopped";
        chartNote.textContent = "Probe stopped; bars retain the final rolling window.";
    }

    toggle.addEventListener("click", async function () {
        if (session !== null) {
            stop();
            return;
        }
        toggle.disabled = true;
        status.textContent = "Loading retained reference and spatial scenes through VIR and FIR…";
        await new Promise((resolve) => requestAnimationFrame(resolve));
        try {
            session = await createHitProbeSession();
            fixtureSelect.replaceChildren(
                ...session.fixtures.map((/** @type {any} */ fixture) => {
                    const option = document.createElement("option");
                    option.value = fixture.name;
                    option.textContent = `${fixture.name} · ${fixture.queries.length} oracle points`;
                    return option;
                }),
            );
            fixtureSelect.disabled = false;
            autoInput.disabled = false;
            chooseFixture();
            startedAt = performance.now();
            lastQueryAt = 0;
            animationFrame = requestAnimationFrame(animate);
            toggle.textContent = "Stop live probe";
            toggle.dataset.state = "running";
            status.textContent = `${session.candidates.length} retained backends active. Move over the scene or leave automatic motion enabled.`;
        } catch (error) {
            session?.dispose();
            session = null;
            status.textContent = `Live probe failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
            toggle.disabled = false;
        }
    });
    fixtureSelect.addEventListener("change", chooseFixture);
    probeSvg.addEventListener("pointermove", function (event) {
        if (session === null || scene === null) return;
        autoInput.checked = false;
        const point = probeSvg.createSVGPoint();
        point.x = event.clientX;
        point.y = event.clientY;
        const screen = scene.world.getScreenCTM();
        if (screen === null) return;
        const local = point.matrixTransform(screen.inverse());
        queryPoint(local.x, local.y);
    });
    window.addEventListener(
        "pagehide",
        function () {
            disposed = true;
            if (session !== null) stop();
        },
        { once: true },
    );
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
        if (response.status === 404) {
            requireElement("[data-status]").textContent =
                "No stored measurement is staged; the live probe is available below.";
            document.body.dataset.ready = "true";
        } else {
            if (!response.ok)
                throw new Error(`measurement report returned HTTP ${response.status}`);
            render(/** @type {HitScenePerformanceReport} */ (await response.json()));
        }
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
    liveStatus.textContent = "Loading the VIR/FIR 2×2 matrix and three retained-scene workloads…";
    await new Promise((resolve) => requestAnimationFrame(resolve));
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
            report.production.spatialFir === undefined
                ? "Live VIR workload suite complete; the FIR pair is not fully staged."
                : "Live 2×2 VIR/FIR reference/spatial suite complete; every result matched.";
    } catch (error) {
        liveStatus.textContent = `Live measurement failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
        liveButton.disabled = false;
        liveProgress.hidden = true;
    }
});

installHitProbe();
void main();
