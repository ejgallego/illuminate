// @ts-check

/**
 * @typedef {"fir" | "rpc"} HitSceneTimingBackend
 * @typedef {{
 *   backend: HitSceneTimingBackend,
 *   kind: "create" | "query",
 *   adapterTimings: Record<string, number> | null,
 *   totalMs: number
 * }} HitSceneTimingObservation
 * @typedef {{ count: number, meanMs: number, maxMs: number, phases: Record<string, number> }} HitSceneTimingSummary
 */

const queryPhases = [
    ["inputMs", "Input"],
    ["encodeMs", "Input encode"],
    ["executeMs", "Lean entry"],
    ["decodeMs", "Result decode"],
    ["rewindMs", "Scratch rewind"],
    ["residualMs", "Adapter residual"],
];

/** @returns {{ count: number, totalMs: number, maxMs: number, phases: Record<string, number> }} */
function emptyTimingAccumulator() {
    return { count: 0, totalMs: 0, maxMs: 0, phases: {} };
}

/** Creates an allocation-light accumulator shared by the widget and standalone diagnostics. */
export function createHitSceneTimingStore() {
    const accumulators = {
        rpc: emptyTimingAccumulator(),
        fir: emptyTimingAccumulator(),
    };

    /** @param {HitSceneTimingBackend} backend @returns {HitSceneTimingSummary} */
    function summarize(backend) {
        const value = accumulators[backend];
        const divisor = Math.max(1, value.count);
        return {
            count: value.count,
            meanMs: value.totalMs / divisor,
            maxMs: value.maxMs,
            phases: Object.fromEntries(
                Object.entries(value.phases).map(([name, total]) => [name, total / divisor]),
            ),
        };
    }

    return {
        /** @param {HitSceneTimingObservation} observation */
        record(observation) {
            if (observation.kind !== "query") return;
            if (!Number.isFinite(observation.totalMs) || observation.totalMs < 0) return;
            const value = accumulators[observation.backend];
            value.count += 1;
            value.totalMs += observation.totalMs;
            value.maxMs = Math.max(value.maxMs, observation.totalMs);
            for (const [name, duration] of Object.entries(observation.adapterTimings ?? {})) {
                if (Number.isFinite(duration) && duration >= 0 && name.endsWith("Ms")) {
                    value.phases[name] = (value.phases[name] ?? 0) + duration;
                }
            }
        },
        snapshot() {
            return { rpc: summarize("rpc"), fir: summarize("fir") };
        },
        reset() {
            accumulators.rpc = emptyTimingAccumulator();
            accumulators.fir = emptyTimingAccumulator();
        },
    };
}

/** @param {number} value */
function milliseconds(value) {
    return `${value.toFixed(3)} ms`;
}

/**
 * Mounts a dormant side-by-side timing panel. The caller decides when to record observations;
 * no timers, animation frames, or pointer listeners are installed here.
 *
 * @param {HTMLElement} container
 * @param {{ firAvailable?: boolean }} [options]
 */
export function createHitSceneComparisonPanel(container, options = {}) {
    const store = createHitSceneTimingStore();
    let firAvailable = options.firAvailable ?? false;
    container.innerHTML = `
      <section class="illuminate-hit-comparison" data-detailed="false">
        <style>
          .illuminate-hit-comparison { padding: 10px; color: #dce5ff; background: #10182b; border: 1px solid #263453; border-radius: 10px; font: 11px system-ui, sans-serif; }
          .illuminate-hit-comparison > header { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
          .illuminate-hit-comparison > header div { display: grid; gap: 2px; }
          .illuminate-hit-comparison > header small, .illuminate-hit-comparison article small { color: #8292b3; }
          .illuminate-hit-comparison button { padding: 5px 8px; color: #c7d3ec; background: #17213a; border: 1px solid #344362; border-radius: 6px; cursor: pointer; }
          .illuminate-hit-totals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)) auto; gap: 8px; align-items: center; margin-top: 10px; }
          .illuminate-hit-totals article { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 8px; padding: 8px; background: #151f37; border-radius: 7px; }
          .illuminate-hit-totals article small, .illuminate-hit-totals article i { grid-column: 1 / -1; }
          .illuminate-hit-totals article i, .illuminate-hit-phases i { display: block; height: 5px; overflow: hidden; background: #0d1426; border-radius: 999px; }
          .illuminate-hit-totals article b, .illuminate-hit-phases b { display: block; width: 0; height: 100%; background: #668fff; border-radius: inherit; transition: width .15s ease; }
          .illuminate-hit-totals [data-hit-backend="rpc"] b, .illuminate-hit-phases [data-hit-phase-bar="rpc"] { background: #f4cc55; }
          .illuminate-hit-totals > output { color: #9ab4ff; font: 700 11px ui-monospace, monospace; }
          .illuminate-hit-phases { display: grid; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid #263453; }
          .illuminate-hit-phases[hidden] { display: none; }
          .illuminate-hit-phases > div { display: grid; grid-template-columns: minmax(80px, .65fr) minmax(60px, 1fr) 70px minmax(60px, 1fr) 70px; gap: 7px; align-items: center; }
          .illuminate-hit-phases output { color: #98a8c8; font: 9px ui-monospace, monospace; text-align: right; }
        </style>
        <header>
          <div><strong>Hit-test runtime comparison</strong><small>cached Lean RPC versus resident FIR Wasm</small></div>
          <button type="button" data-hit-details aria-expanded="false">Show per-query phases</button>
        </header>
        <div class="illuminate-hit-totals">
          <article data-hit-backend="rpc"><span>Cached Lean RPC</span><strong data-hit-mean>—</strong><small data-hit-count>no queries</small><i><b data-hit-total-bar></b></i></article>
          <article data-hit-backend="fir"><span>FIR native Wasm</span><strong data-hit-mean>—</strong><small data-hit-count>package not staged</small><i><b data-hit-total-bar></b></i></article>
          <output data-hit-ratio>—</output>
        </div>
        <div class="illuminate-hit-phases" data-hit-phases hidden></div>
      </section>`;
    const root = /** @type {HTMLElement} */ (container.firstElementChild);
    const phaseContainer = /** @type {HTMLElement} */ (root.querySelector("[data-hit-phases]"));
    phaseContainer.innerHTML = queryPhases
        .map(
            ([name, label]) => `
          <div data-hit-phase="${name}"><span>${label}</span>
            <i><b data-hit-phase-bar="rpc"></b></i><output data-hit-phase-value="rpc">—</output>
            <i><b data-hit-phase-bar="fir"></b></i><output data-hit-phase-value="fir">—</output>
          </div>`,
        )
        .join("");

    function render() {
        const snapshot = store.snapshot();
        const totalScale = Math.max(snapshot.rpc.meanMs, snapshot.fir.meanMs, 0.001);
        for (const backend of /** @type {const} */ (["rpc", "fir"])) {
            const summary = snapshot[backend];
            const article = /** @type {HTMLElement} */ (
                root.querySelector(`[data-hit-backend="${backend}"]`)
            );
            const mean = /** @type {HTMLElement} */ (article.querySelector("[data-hit-mean]"));
            const count = /** @type {HTMLElement} */ (article.querySelector("[data-hit-count]"));
            const bar = /** @type {HTMLElement} */ (article.querySelector("[data-hit-total-bar]"));
            mean.textContent = summary.count === 0 ? "—" : milliseconds(summary.meanMs);
            count.textContent =
                summary.count === 0
                    ? backend === "fir" && !firAvailable
                        ? "package not staged"
                        : "no queries"
                    : `${summary.count} queries · max ${milliseconds(summary.maxMs)}`;
            bar.style.width = `${(100 * summary.meanMs) / totalScale}%`;
        }
        const ratio = /** @type {HTMLOutputElement} */ (root.querySelector("[data-hit-ratio]"));
        ratio.textContent =
            snapshot.rpc.count > 0 && snapshot.fir.count > 0 && snapshot.rpc.meanMs > 0
                ? `${(snapshot.fir.meanMs / snapshot.rpc.meanMs).toFixed(2)}× FIR / RPC`
                : "—";
        const phaseScale = Math.max(
            0.001,
            ...queryPhases.flatMap(([name]) => [
                snapshot.rpc.phases[name] ?? 0,
                snapshot.fir.phases[name] ?? 0,
            ]),
        );
        for (const [name] of queryPhases) {
            const row = /** @type {HTMLElement} */ (
                phaseContainer.querySelector(`[data-hit-phase="${name}"]`)
            );
            for (const backend of /** @type {const} */ (["rpc", "fir"])) {
                const value = snapshot[backend].phases[name];
                const bar = /** @type {HTMLElement} */ (
                    row.querySelector(`[data-hit-phase-bar="${backend}"]`)
                );
                const output = /** @type {HTMLOutputElement} */ (
                    row.querySelector(`[data-hit-phase-value="${backend}"]`)
                );
                bar.style.width = `${(100 * (value ?? 0)) / phaseScale}%`;
                output.textContent = value === undefined ? "—" : milliseconds(value);
            }
        }
    }

    const details = /** @type {HTMLButtonElement} */ (root.querySelector("[data-hit-details]"));
    function toggleDetails() {
        const expanded = details.getAttribute("aria-expanded") !== "true";
        details.setAttribute("aria-expanded", String(expanded));
        details.textContent = expanded ? "Hide per-query phases" : "Show per-query phases";
        phaseContainer.hidden = !expanded;
        root.dataset.detailed = String(expanded);
    }
    details.addEventListener("click", toggleDetails);
    render();

    return {
        /** @param {HitSceneTimingObservation} observation */
        record(observation) {
            store.record(observation);
            render();
        },
        /** @param {boolean} value */
        setFirAvailable(value) {
            firAvailable = value;
            render();
        },
        reset() {
            store.reset();
            render();
        },
        snapshot: store.snapshot,
        dispose() {
            details.removeEventListener("click", toggleDetails);
            container.replaceChildren();
        },
    };
}
