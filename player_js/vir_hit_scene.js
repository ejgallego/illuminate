// @ts-check

/**
 * @typedef {{ kind: "nothing" } | { kind: "something" } | { kind: "tag", value: number, label: string }} VirHitSceneResult
 * @typedef {{
 *   call: (name: string, ...args: unknown[]) => unknown,
 *   callTimed: (name: string, ...args: unknown[]) => { value: unknown, timings: Record<string, number> }
 * }} VirHitSceneRuntime
 * @typedef {{
 *   backend: "vir",
 *   kind: "create" | "query",
 *   adapterTimings: Record<string, number> | null,
 *   memory: null,
 *   adapterWallMs: number,
 *   totalMs: number
 * }} VirHitSceneObservation
 * @typedef {(observation: VirHitSceneObservation) => void} VirHitSceneObserver
 * @typedef {{
 *   replace: (encodedScene: string) => void,
 *   query: (x: number, y: number) => VirHitSceneResult,
 *   dispose: () => void
 * }} VirHitSceneController
 */

const hitSceneEntries = Object.freeze({
    mount: "Illuminate.HitScene.Vir.mount",
    query: "Illuminate.HitScene.Vir.query",
    dispose: "Illuminate.HitScene.Vir.dispose",
});

const spatialHitSceneEntries = Object.freeze({
    mount: "Illuminate.HitScene.SpatialVir.mount",
    query: "Illuminate.HitScene.SpatialVir.query",
    dispose: "Illuminate.HitScene.SpatialVir.dispose",
});

function virHitSceneNow() {
    return globalThis.performance?.now?.() ?? Date.now();
}

/** @param {unknown} value @param {string} label @returns {Record<string, unknown>} */
function requireObject(value, label) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @param {string} label */
function requireKind(value, label) {
    const object = requireObject(value, label);
    if (!("kind" in object) || typeof object.kind !== "string") {
        throw new Error(`${label} has no constructor kind`);
    }
    return { object, kind: object.kind };
}

/** @param {unknown} source */
function projectPoint(source) {
    const point = requireObject(source, "hit-scene point");
    return { x: point.x, y: point.y };
}

/** @param {unknown} source */
function projectPathCommand(source) {
    const { object, kind } = requireKind(source, "hit-scene path command");
    switch (kind) {
        case "moveTo":
        case "lineTo":
            return { kind, value: projectPoint(object.point) };
        case "curveTo":
            return {
                kind,
                fields: {
                    arg1: projectPoint(object.control1),
                    arg2: projectPoint(object.control2),
                    arg3: projectPoint(object.endpoint),
                },
            };
        case "arcTo":
            return {
                kind,
                fields: {
                    rx: object.rx,
                    ry: object.ry,
                    xRotation: object.rotation,
                    largeArc: object.largeArc,
                    sweep: object.sweep,
                    endpoint: projectPoint(object.endpoint),
                },
            };
        case "closePath":
            return { kind };
        default:
            throw new Error(`unknown hit-scene path command ${kind}`);
    }
}

/** @param {unknown} source */
function projectPath(source) {
    if (!Array.isArray(source)) throw new Error("encoded hit-scene path must be an array");
    return { commands: source.map(projectPathCommand) };
}

/** @param {unknown} source */
function projectPrimitive(source) {
    const { object, kind } = requireKind(source, "hit-scene primitive");
    switch (kind) {
        case "path": {
            const fields = {
                data: projectPath(object.data),
                hasFill: object.hasFill,
                strokeWidth: object.strokeWidth,
            };
            const boundNames = ["left", "right", "bottom", "top"];
            const presentBounds = boundNames.filter((name) => Object.hasOwn(object, name));
            if (presentBounds.length !== 0 && presentBounds.length !== boundNames.length) {
                throw new Error("hit-scene path has incomplete prepared bounds");
            }
            if (presentBounds.length === boundNames.length) {
                return {
                    kind,
                    fields: {
                        ...fields,
                        left: object.left,
                        right: object.right,
                        bottom: object.bottom,
                        top: object.top,
                    },
                };
            }
            return {
                kind,
                fields,
            };
        }
        case "bounds":
            return {
                kind,
                fields: {
                    left: object.left,
                    right: object.right,
                    bottom: object.bottom,
                    top: object.top,
                },
            };
        default:
            throw new Error(`unknown hit-scene primitive ${kind}`);
    }
}

/** @param {unknown} source */
function projectMatrix(source) {
    const matrix = requireObject(source, "hit-scene inverse matrix");
    return {
        a: matrix.a,
        b: matrix.b,
        tx: matrix.tx,
        c: matrix.c,
        d: matrix.d,
        ty: matrix.ty,
    };
}

/** @param {unknown} source @returns {unknown} */
function projectTree(source) {
    const { object, kind } = requireKind(source, "hit-scene tree");
    switch (kind) {
        case "empty":
            return { kind };
        case "primitive":
            return { kind, value: projectPrimitive(object.value) };
        case "tag":
            return {
                kind,
                fields: { value: object.value, child: projectTree(object.child) },
            };
        case "transform":
            return {
                kind,
                fields: {
                    inverse: projectMatrix(object.inverse),
                    child: projectTree(object.child),
                },
            };
        case "compose":
            return {
                kind,
                fields: { back: projectTree(object.back), front: projectTree(object.front) },
            };
        case "clip":
            return {
                kind,
                fields: {
                    boundary: projectPath(object.boundary),
                    child: projectTree(object.child),
                },
            };
        default:
            throw new Error(`unknown hit-scene tree constructor ${kind}`);
    }
}

/**
 * Projects Illuminate's stable transport object into VIR's canonical typed-object shape.
 * This runs once when a widget installs or replaces its immutable scene.
 *
 * @param {string | unknown} source
 */
export function projectHitSceneForVir(source) {
    const encoded = typeof source === "string" ? JSON.parse(source) : source;
    const scene = requireObject(encoded, "encoded hit scene");
    if (!Array.isArray(scene.labels)) throw new Error("encoded hit scene has no label array");
    return {
        tree: projectTree(scene.tree),
        labels: scene.labels.map(
            /** @param {unknown} entry @param {number} index */ (entry, index) => {
                const label = requireObject(entry, `hit-scene label ${index}`);
                return { fst: label.value, snd: label.label };
            },
        ),
    };
}

/** @param {unknown} source @returns {VirHitSceneResult} */
export function normalizeVirHitSceneResult(source) {
    const { object, kind } = requireKind(source, "VIR hit-scene result");
    if (kind === "nothing" || kind === "something") return { kind };
    if (kind !== "tag") throw new Error(`unknown VIR hit-scene result ${kind}`);
    const fields = requireObject(object.fields, "VIR tag result fields");
    const value = typeof fields.value === "number" ? fields.value : Number(fields.value);
    if (!Number.isSafeInteger(value) || value < 0 || typeof fields.label !== "string") {
        throw new Error("VIR tag result has invalid fields");
    }
    return { kind, value, label: fields.label };
}

/**
 * Retains one typed hit scene in VIR so repeated queries do not transfer the scene again.
 *
 * @param {VirHitSceneRuntime} runtime
 * @param {string | unknown} encodedScene
 * @param {VirHitSceneObserver | null} observer
 * @param {(() => boolean) | null} observeQuery
 * @param {{ mount: string, query: string, dispose: string }} entries
 * @returns {{ query: (x: number, y: number) => VirHitSceneResult, dispose: () => void }}
 */
function createVirHitSceneHostWithEntries(runtime, encodedScene, observer, observeQuery, entries) {
    const started = virHitSceneNow();
    const projected = projectHitSceneForVir(encodedScene);
    const projectedAt = virHitSceneNow();
    const mounted =
        observer === null
            ? { value: runtime.call(entries.mount, projected), timings: null }
            : runtime.callTimed(entries.mount, projected);
    const completed = virHitSceneNow();
    const handle = mounted.value;
    let disposed = false;
    observer?.({
        backend: "vir",
        kind: "create",
        adapterTimings: {
            projectMs: projectedAt - started,
            ...(mounted.timings ?? {}),
        },
        memory: null,
        adapterWallMs: completed - started,
        totalMs: completed - started,
    });

    function requireLive() {
        if (disposed) throw new Error("VIR hit-scene host is disposed");
    }

    return {
        query(x, y) {
            requireLive();
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                throw new Error("hit-scene coordinates must be finite numbers");
            }
            const measuring = observer !== null && (observeQuery?.() ?? true);
            const queryStarted = measuring ? virHitSceneNow() : 0;
            const observed = measuring
                ? runtime.callTimed(entries.query, handle, x, y)
                : { value: runtime.call(entries.query, handle, x, y), timings: null };
            const result = normalizeVirHitSceneResult(observed.value);
            if (measuring) {
                const queryCompleted = virHitSceneNow();
                observer?.({
                    backend: "vir",
                    kind: "query",
                    adapterTimings: observed.timings,
                    memory: null,
                    adapterWallMs: queryCompleted - queryStarted,
                    totalMs: queryCompleted - queryStarted,
                });
            }
            return result;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            runtime.call(entries.dispose, handle);
        },
    };
}

/**
 * Retains one typed hit scene in VIR so repeated queries do not transfer the scene again.
 *
 * @param {VirHitSceneRuntime} runtime
 * @param {string | unknown} encodedScene
 * @param {VirHitSceneObserver | null} [observer]
 * @param {(() => boolean) | null} [observeQuery]
 * @returns {{ query: (x: number, y: number) => VirHitSceneResult, dispose: () => void }}
 */
export function createVirHitSceneHost(runtime, encodedScene, observer = null, observeQuery = null) {
    return createVirHitSceneHostWithEntries(
        runtime,
        encodedScene,
        observer,
        observeQuery,
        hitSceneEntries,
    );
}

/**
 * Retains the same typed scene behind the experimental balanced spatial VIR entry.
 *
 * Scene projection and the query/result boundary are identical to the reference VIR host.
 *
 * @param {VirHitSceneRuntime} runtime
 * @param {string | unknown} encodedScene
 * @param {VirHitSceneObserver | null} [observer]
 * @param {(() => boolean) | null} [observeQuery]
 * @returns {{ query: (x: number, y: number) => VirHitSceneResult, dispose: () => void }}
 */
export function createVirSpatialHitSceneHost(
    runtime,
    encodedScene,
    observer = null,
    observeQuery = null,
) {
    return createVirHitSceneHostWithEntries(
        runtime,
        encodedScene,
        observer,
        observeQuery,
        spatialHitSceneEntries,
    );
}

/**
 * Owns the current VIR hit scene and releases superseded retained handles after replacement.
 *
 * @param {VirHitSceneRuntime} runtime
 * @param {VirHitSceneObserver | null} [observer]
 * @param {(() => boolean) | null} [observeQuery]
 * @returns {VirHitSceneController}
 */
export function createVirHitSceneController(runtime, observer = null, observeQuery = null) {
    /** @type {ReturnType<typeof createVirHitSceneHost> | null} */
    let current = null;
    let disposed = false;

    function requireLive() {
        if (disposed) throw new Error("VIR hit-scene controller is disposed");
    }

    return {
        replace(encodedScene) {
            requireLive();
            const replacement = createVirHitSceneHost(
                runtime,
                encodedScene,
                observer,
                observeQuery,
            );
            const previous = current;
            current = replacement;
            previous?.dispose();
        },
        query(x, y) {
            requireLive();
            if (current === null) throw new Error("VIR hit-scene controller has no scene");
            return current.query(x, y);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            current?.dispose();
            current = null;
        },
    };
}
