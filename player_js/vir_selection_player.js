// @ts-check

/**
 * @typedef {{
 *   call: (name: string, ...args: unknown[]) => unknown,
 *   callTimed?: (name: string, ...args: unknown[]) => { value: unknown, timings: Record<string, number> }
 * }} VirSelectionRuntime
 * @typedef {{
 *   frame: number,
 *   step: number,
 *   segment: number,
 *   localFrame: number,
 *   segmentChanged: boolean,
 *   playback: "paused" | "playing" | "waiting" | "looping" | "finishingLoop" | "finished"
 * }} VirFrameSelection
 * @typedef {({ kind: "advance" } | { kind: "pause" } | { kind: "seek", frame: number } | { kind: "playTo", frame: number, loopAfter: boolean } | { kind: "loopAt", frame: number } | { kind: "tick", timestamp: number })} VirSelectionEvent
 * @typedef {{ action: VirFrameSelection, scheduleNextFrame: boolean }} VirSelectionOutput
 * @typedef {{ render: (selection: VirFrameSelection) => void, dispose?: () => void }} VirSelectionRenderer
 * @typedef {{ request: (callback: FrameRequestCallback) => number, cancel: (handle: number) => void }} VirSelectionScheduler
 * @typedef {{
 *   kind: "create" | "dispatch",
 *   operation: string,
 *   runtimeTimings: Record<string, number> | null,
 *   runtimeWallMs: number,
 *   projectMs: number,
 *   renderMs: number,
 *   totalMs: number
 * }} VirSelectionObservation
 * @typedef {(observation: VirSelectionObservation) => void} VirSelectionObserver
 * @typedef {{
 *   advance: () => void,
 *   pause: () => void,
 *   seek: (frame: number) => void,
 *   playTo: (frame: number, loopAfter: boolean) => void,
 *   loopAt: (frame: number) => void,
 *   snapshot: () => VirFrameSelection,
 *   dispose: () => void
 * }} VirSelectionPlayerHost
 */

const VIR_SELECTION_MOUNT = "Illuminate.Animation.Vir.mountSelectionPlayer";
const VIR_SELECTION_SNAPSHOT = "Illuminate.Animation.Vir.selectionPlayerSnapshot";
const VIR_SELECTION_DISPATCH = "Illuminate.Animation.Vir.dispatchSelectionPlayer";
const VIR_SELECTION_DISPOSE = "Illuminate.Animation.Vir.disposeSelectionPlayer";

function virSelectionNow() {
    return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Projects only the timeline fields needed by Lean. SVG fragments, patch bindings,
 * and parameter rows remain reachable through the original JavaScript object.
 *
 * @param {AnimData} animation
 */
export function projectVirSelectionAnimation(animation) {
    return {
        timeline: {
            fps: animation.fps,
            totalFrames: animation.totalFrames,
            segments: animation.segments.map((segment) => ({
                startFrame: segment.sf,
                frameCount: segment.fc,
                paramMap: [],
                params: [],
            })),
            steps: animation.steps.map((step) => ({
                frame: step.frame,
                pause: step.pause,
                loop: step.loop,
            })),
        },
    };
}

/** @param {VirSelectionEvent} event */
export function projectVirSelectionEvent(event) {
    switch (event.kind) {
        case "advance":
        case "pause":
            return { kind: event.kind };
        case "seek":
        case "loopAt":
            return { kind: event.kind, value: event.frame };
        case "playTo":
            return {
                kind: "playTo",
                fields: { frame: event.frame, loopAfter: event.loopAfter },
            };
        case "tick":
            return { kind: "tick", value: event.timestamp };
    }
}

/** @param {unknown} result @param {string} operation */
function requireVirSelectionMount(result, operation) {
    if (typeof result !== "object" || result === null || !("kind" in result)) {
        throw new Error(`VIR selection ${operation} returned an invalid result`);
    }
    if (result.kind === "error") {
        const message = "value" in result ? result.value : "unknown error";
        throw new Error(`VIR selection ${operation} failed: ${String(message)}`);
    }
    if (result.kind !== "ok" || !("value" in result)) {
        throw new Error(`VIR selection ${operation} returned an invalid Except value`);
    }
    return result.value;
}

/** @param {unknown} value @param {string} operation @returns {VirSelectionOutput} */
function requireVirSelectionOutput(value, operation) {
    if (
        typeof value !== "object" ||
        value === null ||
        !("action" in value) ||
        !("scheduleNextFrame" in value)
    ) {
        throw new Error(`VIR selection ${operation} returned an invalid transition`);
    }
    return /** @type {VirSelectionOutput} */ (value);
}

/**
 * @param {VirSelectionRuntime} runtime
 * @param {boolean} timed
 * @param {string} name
 * @param {unknown[]} args
 */
function callVirSelection(runtime, timed, name, args) {
    const started = virSelectionNow();
    if (timed && runtime.callTimed !== undefined) {
        const result = runtime.callTimed(name, ...args);
        return {
            value: result.value,
            timings: result.timings,
            wallMs: virSelectionNow() - started,
        };
    }
    return {
        value: runtime.call(name, ...args),
        timings: null,
        wallMs: virSelectionNow() - started,
    };
}

/** @param {Array<Record<string, number> | null>} values */
function sumVirSelectionTimings(values) {
    /** @type {Record<string, number>} */
    const result = {};
    for (const value of values) {
        if (value === null) continue;
        for (const [name, duration] of Object.entries(value)) {
            result[name] = (result[name] ?? 0) + duration;
        }
    }
    return result;
}

/**
 * Owns browser scheduling around a persistent, selection-only VIR player.
 * The original animation object remains exclusively in the host renderer.
 *
 * @param {VirSelectionRuntime} runtime
 * @param {AnimData} animation
 * @param {VirSelectionRenderer} renderer
 * @param {VirSelectionScheduler} [scheduler]
 * @param {VirSelectionObserver | null} [observer]
 * @param {(() => boolean) | null} [observeDispatch]
 * @returns {VirSelectionPlayerHost}
 */
export function createVirSelectionPlayerHost(
    runtime,
    animation,
    renderer,
    scheduler = {
        request: window.requestAnimationFrame.bind(window),
        cancel: window.cancelAnimationFrame.bind(window),
    },
    observer = null,
    observeDispatch = null,
) {
    const createStarted = virSelectionNow();
    const projectStarted = virSelectionNow();
    const projected = projectVirSelectionAnimation(animation);
    const projectMs = virSelectionNow() - projectStarted;
    const mounted = callVirSelection(runtime, true, VIR_SELECTION_MOUNT, [projected]);
    const player = requireVirSelectionMount(mounted.value, "mount");
    const initial = callVirSelection(runtime, true, VIR_SELECTION_SNAPSHOT, [player]);
    let output = requireVirSelectionOutput(initial.value, "snapshot");
    /** @type {number | null} */
    let pendingFrame = null;
    let disposed = false;

    const initialRenderStarted = virSelectionNow();
    renderer.render(output.action);
    const initialRendered = virSelectionNow();
    observer?.({
        kind: "create",
        operation: "create",
        runtimeTimings: sumVirSelectionTimings([mounted.timings, initial.timings]),
        runtimeWallMs: mounted.wallMs + initial.wallMs,
        projectMs,
        renderMs: initialRendered - initialRenderStarted,
        totalMs: initialRendered - createStarted,
    });

    function requireLive() {
        if (disposed) throw new Error("VIR selection player host is disposed");
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

    /** @param {VirSelectionEvent} event */
    function dispatch(event) {
        requireLive();
        const measuring = observer !== null && (observeDispatch?.() ?? true);
        const started = measuring ? virSelectionNow() : 0;
        const call = callVirSelection(runtime, measuring, VIR_SELECTION_DISPATCH, [
            player,
            projectVirSelectionEvent(event),
        ]);
        output = requireVirSelectionOutput(call.value, event.kind);
        const renderStarted = measuring ? virSelectionNow() : 0;
        renderer.render(output.action);
        if (measuring) {
            const rendered = virSelectionNow();
            observer?.({
                kind: "dispatch",
                operation: event.kind,
                runtimeTimings: call.timings,
                runtimeWallMs: call.wallMs,
                projectMs: 0,
                renderMs: rendered - renderStarted,
                totalMs: rendered - started,
            });
        }
        if (output.scheduleNextFrame) schedule();
        else cancelPending();
    }

    /** @param {number} timestamp */
    function tick(timestamp) {
        pendingFrame = null;
        if (!disposed) dispatch({ kind: "tick", timestamp });
    }

    if (output.scheduleNextFrame) schedule();

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
            return output.action;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            cancelPending();
            renderer.dispose?.();
            runtime.call(VIR_SELECTION_DISPOSE, player);
        },
    };
}
