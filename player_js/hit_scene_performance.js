// @ts-check

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
    document.body.dataset.ready = "true";
}

async function main() {
    try {
        const response = await fetch("./hit-scene-performance.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`measurement report returned HTTP ${response.status}`);
        render(/** @type {HitScenePerformanceReport} */ (await response.json()));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        requireElement("[data-status]").textContent = `Could not load measurement: ${message}`;
        document.body.dataset.ready = "error";
    }
}

void main();
