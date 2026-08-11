// @ts-check

/**
 * @typedef {{ kind: "nothing" } | { kind: "something" } | { kind: "tag", value: number, label: string }} HitSceneResult
 * @typedef {Record<string, number>} HitSceneRuntimeTimings
 * @typedef {Record<string, number | string | undefined>} HitSceneRuntimeMemory
 * @typedef {{
 *   scene: unknown,
 *   timings?: HitSceneRuntimeTimings,
 *   memory?: HitSceneRuntimeMemory,
 *   ok?: true
 * } | {
 *   ok: false,
 *   error: string
 * }} FirHitSceneCreateResult
 * @typedef {{
 *   result: HitSceneResult,
 *   timings?: HitSceneRuntimeTimings,
 *   memory?: HitSceneRuntimeMemory,
 *   ok?: true
 * } | ({
 *   timings?: HitSceneRuntimeTimings,
 *   memory?: HitSceneRuntimeMemory,
 *   ok?: true
 * } & HitSceneResult) | {
 *   ok: false,
 *   error: string
 * }} FirHitSceneQueryResult
 * @typedef {{
 *   createHitScene: (encodedScene: string) => FirHitSceneCreateResult,
 *   hitTest: (scene: unknown, x: number, y: number) => FirHitSceneQueryResult,
 *   hitTestDiagnostic?: (scene: unknown, x: number, y: number) => FirHitSceneQueryResult,
 *   disposeHitScene: (scene: unknown) => void
 * }} FirHitSceneAdapter
 * @typedef {{
 *   backend: "fir" | "rpc",
 *   kind: "create" | "query",
 *   adapterTimings: HitSceneRuntimeTimings | null,
 *   memory: HitSceneRuntimeMemory | null,
 *   adapterWallMs: number,
 *   totalMs: number
 * }} HitSceneObservation
 * @typedef {(observation: HitSceneObservation) => void} HitSceneObserver
 * @typedef {{
 *   query: (x: number, y: number) => HitSceneResult,
 *   dispose: () => void
 * }} FirHitSceneHost
 * @typedef {{
 *   replace: (encodedScene: string) => void,
 *   query: (x: number, y: number) => HitSceneResult,
 *   dispose: () => void
 * }} FirHitSceneController
 */

function hitSceneNow() {
    return globalThis.performance?.now?.() ?? Date.now();
}

/** @param {unknown} value @returns {asserts value is HitSceneResult} */
function assertHitSceneResult(value) {
    if (typeof value !== "object" || value === null || !("kind" in value)) {
        throw new Error("hit-scene query returned no structured result");
    }
    if (value.kind === "nothing" || value.kind === "something") return;
    if (
        value.kind === "tag" &&
        "value" in value &&
        typeof value.value === "number" &&
        Number.isSafeInteger(value.value) &&
        value.value >= 0 &&
        "label" in value &&
        typeof value.label === "string"
    ) {
        return;
    }
    throw new Error(`hit-scene query returned invalid constructor ${String(value.kind)}`);
}

/** @param {FirHitSceneCreateResult} result */
function requireHitSceneCreate(result) {
    if (result.ok === false) throw new Error(`FIR hit-scene creation failed: ${result.error}`);
    if (!("scene" in result)) throw new Error("FIR hit-scene creation returned no scene handle");
    return result;
}

/** @param {FirHitSceneQueryResult} response */
function requireHitSceneQuery(response) {
    if (response.ok === false) throw new Error(`FIR hit-scene query failed: ${response.error}`);
    const result = "result" in response ? response.result : response;
    assertHitSceneResult(result);
    return { response, result };
}

/**
 * Owns one immutable, browser-resident FIR hit scene.
 * Scene projection happens once at construction. Each query forwards only its two coordinates.
 *
 * @param {FirHitSceneAdapter} adapter
 * @param {string} encodedScene
 * @param {HitSceneObserver | null} [observer]
 * @returns {FirHitSceneHost}
 */
export function createFirHitSceneHost(adapter, encodedScene, observer = null) {
    if (typeof encodedScene !== "string" || encodedScene.length === 0) {
        throw new Error("FIR hit-scene host requires an encoded scene");
    }
    const started = hitSceneNow();
    const created = requireHitSceneCreate(adapter.createHitScene(encodedScene));
    const completed = hitSceneNow();
    const scene = created.scene;
    const query =
        observer !== null && adapter.hitTestDiagnostic !== undefined
            ? adapter.hitTestDiagnostic.bind(adapter)
            : adapter.hitTest.bind(adapter);
    let disposed = false;

    observer?.({
        backend: "fir",
        kind: "create",
        adapterTimings: created.timings ?? null,
        memory: created.memory ?? null,
        adapterWallMs: completed - started,
        totalMs: completed - started,
    });

    function requireLive() {
        if (disposed) throw new Error("FIR hit-scene host is disposed");
    }

    return {
        query(x, y) {
            requireLive();
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                throw new Error("hit-scene coordinates must be finite numbers");
            }
            const queryStarted = hitSceneNow();
            const { response, result } = requireHitSceneQuery(query(scene, x, y));
            const queryCompleted = hitSceneNow();
            observer?.({
                backend: "fir",
                kind: "query",
                adapterTimings: response.timings ?? null,
                memory: response.memory ?? null,
                adapterWallMs: queryCompleted - queryStarted,
                totalMs: queryCompleted - queryStarted,
            });
            return result;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            adapter.disposeHitScene(scene);
        },
    };
}

/**
 * Owns the current hit scene for a parameterized widget. Replacement is atomic from the
 * host's perspective: the previous scene stays live if constructing its successor fails.
 *
 * @param {FirHitSceneAdapter} adapter
 * @param {HitSceneObserver | null} [observer]
 * @returns {FirHitSceneController}
 */
export function createFirHitSceneController(adapter, observer = null) {
    /** @type {FirHitSceneHost | null} */
    let current = null;
    let disposed = false;

    function requireLive() {
        if (disposed) throw new Error("FIR hit-scene controller is disposed");
    }

    return {
        replace(encodedScene) {
            requireLive();
            const replacement = createFirHitSceneHost(adapter, encodedScene, observer);
            const previous = current;
            current = replacement;
            previous?.dispose();
        },
        query(x, y) {
            requireLive();
            if (current === null) throw new Error("FIR hit-scene controller has no scene");
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

/**
 * Measures the existing cached Lean-RPC query without changing its request or result representation.
 *
 * @param {(request: { id: number, x: number, y: number }) => Promise<HitSceneResult>} call
 * @param {number} id
 * @param {number} x
 * @param {number} y
 * @param {HitSceneObserver | null} [observer]
 */
export async function queryPreparedHitSceneRpc(call, id, x, y, observer = null) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error("hit-scene coordinates must be finite numbers");
    }
    const started = hitSceneNow();
    const result = await call({ id, x, y });
    const completed = hitSceneNow();
    assertHitSceneResult(result);
    observer?.({
        backend: "rpc",
        kind: "query",
        adapterTimings: null,
        memory: null,
        adapterWallMs: completed - started,
        totalMs: completed - started,
    });
    return result;
}
