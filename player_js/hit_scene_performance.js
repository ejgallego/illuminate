// @ts-check

import { createFirHitSceneHost } from "./fir_hit_scene.js";
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
        const host = candidate.createProfiled((/** @type {any} */ observation) => {
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

/** @param {any} fixture */
async function loadVirCandidate(fixture) {
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
        createProfiled(/** @type {any} */ observer) {
            return createVirHitSceneHost(runtime, fixture.encodedScene, observer);
        },
        dispose() {
            runtime.dispose();
        },
    };
}

/** @param {any} fixture */
async function loadFirCandidate(fixture) {
    const buildResponse = await fetch("./fir-hit-scene/BUILD.json", { cache: "no-store" });
    if (buildResponse.status === 404) return null;
    const build = await requireOk(buildResponse, "FIR BUILD.json").then((response) =>
        response.json(),
    );
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
            measurementMode: "live browser FIR adapter hitTest",
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
        createProfiled(/** @type {any} */ observer) {
            return createFirHitSceneHost(adapter, fixture.encodedScene, observer);
        },
        dispose() {},
    };
}

async function runLiveMeasurement() {
    const { fetchHitSceneBenchmark, runPairedHitSceneBenchmark } =
        await import("../scripts/lib/hit-scene-benchmark.mjs");
    const fixture = await fetchHitSceneBenchmark("./hit-scene-benchmark.json");
    /** @type {any[]} */
    const candidates = [await loadVirCandidate(fixture)];
    const fir = await loadFirCandidate(fixture);
    if (fir !== null) candidates.push(fir);
    try {
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
        const firOverVir =
            fir === null
                ? null
                : {
                      median: production.fir.query.medianMs / production.vir.query.medianMs,
                      pairedQueryRatio: {
                          median: summarize(
                              production.fir.samples.map(
                                  (/** @type {number} */ sample, /** @type {number} */ index) =>
                                      sample / production.vir.samples[index],
                              ),
                          ).medianMs,
                      },
                  };
        return {
            schemaVersion: "illuminate.hit-scene-performance/v1",
            generatedAt: new Date().toISOString(),
            environment: { browser: navigator.userAgent },
            fixture: {
                schemaVersion: fixture.schemaVersion,
                encodedBytes: fixture.encodedScene.length,
                queryCount: fixture.queries.length,
            },
            protocol: {
                warmupRounds: 1,
                measuredRounds: 5,
                profileRounds: 2,
                samplesPerBackend: fixture.queries.length * 5,
                balancedQueryBackendOrder: candidates.length > 1,
                pairedQuerySamples: candidates.length > 1,
                creationExcludedFromQuerySamples: true,
                productionAndDiagnosticsSeparated: true,
            },
            backends: Object.fromEntries(
                candidates.map((candidate) => [candidate.name, candidate.metadata]),
            ),
            production,
            diagnostics,
            deltas: { firOverVir },
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
                    `${ratio(result.query.medianMs / fastest)} fastest`,
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
    headline.textContent = delta
        ? `${ratio(delta.pairedQueryRatio?.median ?? delta.median)} FIR / VIR paired median`
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

async function loadWorkloadProfile() {
    const response = await fetch("./vir-hit-scene-profile.json", { cache: "no-store" });
    if (response.status === 404) return;
    renderWorkloadProfile(
        await requireOk(response, "VIR workload profile").then((item) => item.json()),
    );
}

async function main() {
    try {
        const response = await fetch("./hit-scene-performance.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`measurement report returned HTTP ${response.status}`);
        render(/** @type {HitScenePerformanceReport} */ (await response.json()));
        await loadWorkloadProfile();
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
    liveButton.disabled = true;
    liveStatus.textContent = "Loading runtimes and measuring 301 queries…";
    try {
        const report = await runLiveMeasurement();
        render(/** @type {HitScenePerformanceReport} */ (report));
        liveStatus.textContent =
            report.production.fir === undefined
                ? "Live VIR measurement complete; no FIR package is staged."
                : "Live paired VIR/FIR measurement complete.";
    } catch (error) {
        liveStatus.textContent = `Live measurement failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
        liveButton.disabled = false;
    }
});

void main();
