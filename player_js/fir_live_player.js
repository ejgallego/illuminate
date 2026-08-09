// @ts-check

/**
 * @typedef {"paused" | "playing" | "waiting" | "looping" | "finishingLoop" | "finished"} FirPlaybackStatus
 * @typedef {{ e: number, a: string, v: string }} FirAttributeUpdate
 * @typedef {{
 *   frame: number,
 *   step: number,
 *   segment: number,
 *   localFrame: number,
 *   segmentChanged: boolean,
 *   playback: FirPlaybackStatus
 * }} FirFrameSelection
 * @typedef {FirFrameSelection & { updates: FirAttributeUpdate[] }} FirFrameAction
 * @typedef {{
 *   render: (selection: FirFrameSelection) => void,
 *   dispose?: () => void
 * }} FirSelectionRenderer
 * @typedef {({ kind: "advance" } | { kind: "pause" } | { kind: "seek", frame: number } | { kind: "playTo", frame: number, loopAfter: boolean } | { kind: "loopAt", frame: number } | { kind: "tick", timestamp: number })} FirPlayerEvent
 * @typedef {Record<string, number>} FirRuntimeTimings
 * @typedef {Record<string, number | string | undefined>} FirRuntimeMemory
 * @typedef {{
 *   ok: true,
 *   action: FirFrameSelection,
 *   scheduleNextFrame: boolean,
 *   timings?: FirRuntimeTimings,
 *   memory?: FirRuntimeMemory
 * } | {
 *   ok: false,
 *   error: string
 * }} FirDispatchResult
 * @typedef {{
 *   ok: true,
 *   player: unknown,
 *   action: FirFrameSelection,
 *   scheduleNextFrame: boolean,
 *   timings?: FirRuntimeTimings,
 *   memory?: FirRuntimeMemory
 * } | {
 *   ok: false,
 *   error: string
 * }} FirCreateResult
 * @typedef {{
 *   createPlayer: (animation: AnimData) => FirCreateResult,
 *   dispatch: (player: unknown, event: FirPlayerEvent) => FirDispatchResult,
 *   dispatchTick: (player: unknown, timestamp: number) => FirDispatchResult,
 *   disposePlayer: (player: unknown) => void
 * }} FirLivePlayerAdapter
 * @typedef {{
 *   render: (action: FirFrameAction) => void,
 *   dispose?: () => void
 * }} FirActionRenderer
 * @typedef {{
 *   request: (callback: FrameRequestCallback) => number,
 *   cancel: (handle: number) => void
 * }} FirFrameScheduler
 * @typedef {{
 *   kind: "create" | "dispatch",
 *   operation: string,
 *   adapterTimings: FirRuntimeTimings | null,
 *   memory: FirRuntimeMemory | null,
 *   adapterWallMs: number,
 *   renderMs: number,
 *   totalMs: number
 * }} FirHostObservation
 * @typedef {(observation: FirHostObservation) => void} FirHostObserver
 * @typedef {{
 *   advance: () => void,
 *   pause: () => void,
 *   seek: (frame: number) => void,
 *   playTo: (frame: number, loopAfter: boolean) => void,
 *   loopAt: (frame: number) => void,
 *   snapshot: () => FirFrameSelection,
 *   dispose: () => void
 * }} FirLivePlayerHost
 */

function firHostNow() {
    return globalThis.performance?.now?.() ?? Date.now();
}

/** @param {FirCreateResult} result */
function requireFirCreateResult(result) {
    if (!result.ok) throw new Error(`FIR live player create failed: ${result.error}`);
    return result;
}

/** @param {FirDispatchResult} result @param {string} operation */
function requireFirDispatchResult(result, operation) {
    if (!result.ok) throw new Error(`FIR live player ${operation} failed: ${result.error}`);
    return result;
}

/**
 * Creates the deliberately narrow SVG host boundary for FIR-produced actions.
 * The renderer never derives a frame, segment, parameter value, or playback state.
 *
 * @param {AnimData} animation
 * @param {HTMLElement} container
 * @returns {FirActionRenderer}
 */
export function createFirDomRenderer(animation, container) {
    /** @type {number | null} */
    let installedSegment = null;
    /** @type {Element[]} */
    let elements = [];

    return {
        render(action) {
            const segment = animation.segments[action.segment];
            if (segment === undefined) {
                throw new Error(`FIR action selected missing segment ${action.segment}`);
            }
            if (installedSegment !== action.segment || action.segmentChanged) {
                container.innerHTML = segment.sync;
                elements = [];
                for (const element of container.querySelectorAll("[data-e]")) {
                    const value = element.getAttribute("data-e");
                    const index = value === null ? Number.NaN : Number.parseInt(value, 10);
                    if (Number.isSafeInteger(index) && index >= 0) elements[index] = element;
                }
                installedSegment = action.segment;
            }
            for (const update of action.updates) {
                const element = elements[update.e];
                if (element === undefined) {
                    throw new Error(
                        `FIR action targeted missing data-e=${update.e} in segment ${action.segment}`,
                    );
                }
                if (update.a === "textContent") element.textContent = update.v;
                else element.setAttribute(update.a, update.v);
            }
        },
        dispose() {
            installedSegment = null;
            elements = [];
        },
    };
}

/**
 * Applies a Lean-selected segment and local frame from the browser-owned SVG patch table.
 * Timing, pause, loop, seek, and segment-selection semantics remain native decisions.
 *
 * @param {AnimData} animation
 * @param {HTMLElement} container
 * @returns {FirSelectionRenderer}
 */
export function createSelectionDomRenderer(animation, container) {
    /** @type {number | null} */
    let installedSegment = null;
    /** @type {Element[]} */
    let elements = [];

    return {
        render(selection) {
            const segment = animation.segments[selection.segment];
            if (segment === undefined) {
                throw new Error(`FIR selection chose missing segment ${selection.segment}`);
            }
            if (installedSegment !== selection.segment || selection.segmentChanged) {
                container.innerHTML = segment.sync;
                elements = [];
                for (const element of container.querySelectorAll("[data-e]")) {
                    const value = element.getAttribute("data-e");
                    const index = value === null ? Number.NaN : Number.parseInt(value, 10);
                    if (Number.isSafeInteger(index) && index >= 0) elements[index] = element;
                }
                installedSegment = selection.segment;
            }
            const values = segment.params[selection.localFrame];
            if (values === undefined || values.length !== segment.pmap.length) {
                throw new Error(
                    `FIR selection chose invalid local frame ${selection.localFrame} in segment ${selection.segment}`,
                );
            }
            for (let index = 0; index < segment.pmap.length; index += 1) {
                const binding = segment.pmap[index];
                const element = elements[binding.e];
                if (element === undefined) {
                    throw new Error(
                        `FIR selection targeted missing data-e=${binding.e} in segment ${selection.segment}`,
                    );
                }
                const value = values[index];
                if (binding.a === "textContent") element.textContent = value;
                else element.setAttribute(binding.a, value);
            }
        },
        dispose() {
            installedSegment = null;
            elements = [];
        },
    };
}

/** Backwards-compatible name for the shared JavaScript-object selection renderer. */
export const createFirSelectionDomRenderer = createSelectionDomRenderer;

/**
 * Owns browser callback scheduling around a persistent FIR player handle.
 * The adapter supplies `scheduleNextFrame`; the host does not reconstruct Lean playback semantics.
 *
 * @param {FirLivePlayerAdapter} adapter
 * @param {AnimData} animation
 * @param {FirSelectionRenderer} renderer
 * @param {FirFrameScheduler} [scheduler]
 * @param {FirHostObserver | null} [observer]
 * @param {(() => boolean) | null} [observeDispatch]
 * @returns {FirLivePlayerHost}
 */
export function createFirLivePlayerHost(
    adapter,
    animation,
    renderer,
    scheduler = {
        request: window.requestAnimationFrame.bind(window),
        cancel: window.cancelAnimationFrame.bind(window),
    },
    observer = null,
    observeDispatch = null,
) {
    const createStarted = firHostNow();
    const created = requireFirCreateResult(adapter.createPlayer(animation));
    const adapterCreated = firHostNow();
    const player = created.player;
    let action = created.action;
    /** @type {number | null} */
    let pendingFrame = null;
    let disposed = false;

    const initialRenderStarted = firHostNow();
    renderer.render(action);
    const initialRendered = firHostNow();
    observer?.({
        kind: "create",
        operation: "create",
        adapterTimings: created.timings ?? null,
        memory: created.memory ?? null,
        adapterWallMs: adapterCreated - createStarted,
        renderMs: initialRendered - initialRenderStarted,
        totalMs: initialRendered - createStarted,
    });

    function requireLive() {
        if (disposed) throw new Error("FIR live player host is disposed");
    }

    function cancelPending() {
        if (pendingFrame !== null) {
            scheduler.cancel(pendingFrame);
            pendingFrame = null;
        }
    }

    function schedule() {
        if (!disposed && pendingFrame === null) pendingFrame = scheduler.request(tick);
    }

    /** @param {FirDispatchResult} result @param {string} operation @param {{ started: number, adapterCompleted: number } | null} measurement */
    function consume(result, operation, measurement) {
        const completed = requireFirDispatchResult(result, operation);
        action = completed.action;
        const renderStarted = measurement === null ? 0 : firHostNow();
        renderer.render(action);
        if (measurement !== null) {
            const rendered = firHostNow();
            observer?.({
                kind: "dispatch",
                operation,
                adapterTimings: completed.timings ?? null,
                memory: completed.memory ?? null,
                adapterWallMs: measurement.adapterCompleted - measurement.started,
                renderMs: rendered - renderStarted,
                totalMs: rendered - measurement.started,
            });
        }
        if (completed.scheduleNextFrame) schedule();
        else cancelPending();
    }

    /** @param {FirPlayerEvent} event */
    function dispatch(event) {
        requireLive();
        const measuring = observer !== null && (observeDispatch?.() ?? true);
        const started = measuring ? firHostNow() : 0;
        const result = adapter.dispatch(player, event);
        const measurement = measuring ? { started, adapterCompleted: firHostNow() } : null;
        consume(result, event.kind, measurement);
    }

    /** @param {number} timestamp */
    function tick(timestamp) {
        pendingFrame = null;
        if (disposed) return;
        requireLive();
        const measuring = observer !== null && (observeDispatch?.() ?? true);
        const started = measuring ? firHostNow() : 0;
        const result = adapter.dispatchTick(player, timestamp);
        const measurement = measuring ? { started, adapterCompleted: firHostNow() } : null;
        consume(result, "tick", measurement);
    }

    if (created.scheduleNextFrame) schedule();

    return {
        advance() {
            dispatch({ kind: "advance" });
        },
        pause() {
            dispatch({ kind: "pause" });
        },
        seek(frame) {
            dispatch({ kind: "seek", frame });
        },
        playTo(frame, loopAfter) {
            dispatch({ kind: "playTo", frame, loopAfter });
        },
        loopAt(frame) {
            dispatch({ kind: "loopAt", frame });
        },
        snapshot() {
            requireLive();
            return action;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            cancelPending();
            renderer.dispose?.();
            adapter.disposePlayer(player);
        },
    };
}
