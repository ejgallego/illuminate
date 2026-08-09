/** Converts browser animation data to Illuminate's SVG-free PlayerAnimation shape. */
export function prepareVirPlayerAnimation(animation) {
    return {
        fps: animation.fps,
        totalFrames: animation.totalFrames,
        segments: animation.segments.map((segment) => ({
            startFrame: segment.sf,
            frameCount: segment.fc,
            paramMap: segment.pmap.map((binding) => ({
                element: binding.e,
                target:
                    binding.a === "textContent"
                        ? { kind: "textContent" }
                        : { kind: "attribute", value: binding.a },
            })),
            params: segment.params,
        })),
        steps: animation.steps,
    };
}

/** Converts the browser event vocabulary to VIR custom-inductive values. */
export function prepareVirPlayerEvents(events) {
    return events.map((event) => {
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
            default:
                throw new Error(`unsupported player event: ${String(event.kind)}`);
        }
    });
}

function naturalNumber(value, label) {
    const result = typeof value === "number" ? value : Number(value);
    if (!Number.isSafeInteger(result) || result < 0) {
        throw new Error(`${label} is not a safe natural number`);
    }
    return result;
}

function patchTargetName(target, label) {
    if (target?.kind === "textContent") return "textContent";
    if (target?.kind === "attribute" && typeof target.value === "string") {
        return target.value;
    }
    throw new Error(`${label} has an invalid patch target`);
}

function normalizeAction(action, actionIndex) {
    const label = `actions[${actionIndex}]`;
    return {
        frame: naturalNumber(action.frame, `${label}.frame`),
        step: naturalNumber(action.step, `${label}.step`),
        segment: naturalNumber(action.segment, `${label}.segment`),
        localFrame: naturalNumber(action.localFrame, `${label}.localFrame`),
        segmentChanged: action.segmentChanged,
        updates: action.updates.map((update, updateIndex) => ({
            e: naturalNumber(update.element, `${label}.updates[${updateIndex}].element`),
            a: patchTargetName(update.target, `${label}.updates[${updateIndex}].target`),
            v: update.value,
        })),
        playback: action.playback,
    };
}

/** Normalizes the typed VIR result to the legacy differential-test action shape. */
export function normalizeVirTraceResult(result) {
    if (result?.kind === "error") {
        return { ok: false, error: result.value };
    }
    if (result?.kind !== "ok" || !Array.isArray(result.value)) {
        throw new Error("typed VIR trace returned an invalid Except value");
    }
    return {
        ok: true,
        actions: result.value.map(normalizeAction),
    };
}
