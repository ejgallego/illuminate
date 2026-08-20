// @ts-check

/** Shared semantic API implemented by both FIR-native and FIR-LLVM packages. */
export const LLVM_SELECTION_PLAYER_ADAPTER_API_VERSION = "fir.illuminate-player.browser/v4";
/** Compact selection-only input layout accepted by the compiled player. */
export const LLVM_SELECTION_PLAYER_INPUT_LAYOUT_VERSION =
    "lean-4.32-Illuminate.Animation.SelectionAnimation/v4";
/** Resident-player ownership contract required by the browser host. */
export const LLVM_SELECTION_PLAYER_OWNERSHIP_VERSION =
    "fir.illuminate-player.persistent-checkpoint/v2";
/** Scalar tick operation required on the animation-frame hot path. */
export const LLVM_SELECTION_PLAYER_HOT_EVENT_VERSION = "fir.illuminate-player.hot-event/v1";
/** LLVM/Emscripten transport contract, separate from the shared semantic API. */
export const LLVM_SELECTION_PLAYER_WIRE_VERSION = "fir.illuminate-player.emscripten-wire/v1";

/**
 * @typedef {{
 *   createPlayer: (animation: AnimData) => unknown,
 *   dispatch: (player: unknown, event: unknown) => unknown,
 *   dispatchTick: (player: unknown, timestamp: number) => unknown,
 *   disposePlayer: (player: unknown) => void,
 *   replayTrace: (animation: AnimData, events: unknown[]) => unknown
 * }} LlvmSelectionPlayerAdapter
 */

/** @param {unknown} value @param {string} name */
function requireFunction(value, name) {
    if (typeof value !== "function") {
        throw new Error(`LLVM selection-player package does not export ${name}`);
    }
}

/**
 * Loads a producer-owned LLVM/Emscripten adapter without translating its state-machine results.
 *
 * @param {{ adapterUrl: URL, manifestUrl: URL }} assets
 * @returns {Promise<LlvmSelectionPlayerAdapter>}
 */
export async function loadLlvmSelectionPlayerAdapter(assets) {
    var module = await import(assets.adapterUrl.href);
    if (
        module.ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION !==
            LLVM_SELECTION_PLAYER_ADAPTER_API_VERSION ||
        module.ILLUMINATE_SELECTION_PLAYER_INPUT_LAYOUT_VERSION !==
            LLVM_SELECTION_PLAYER_INPUT_LAYOUT_VERSION ||
        module.ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION !==
            LLVM_SELECTION_PLAYER_OWNERSHIP_VERSION ||
        module.ILLUMINATE_SELECTION_PLAYER_HOT_EVENT_VERSION !==
            LLVM_SELECTION_PLAYER_HOT_EVENT_VERSION ||
        module.ILLUMINATE_SELECTION_PLAYER_EMSCRIPTEN_WIRE_VERSION !==
            LLVM_SELECTION_PLAYER_WIRE_VERSION
    ) {
        throw new Error("staged LLVM selection-player package has an unsupported contract");
    }
    requireFunction(
        module.loadEmscriptenIlluminateSelectionPlayerAdapter,
        "loadEmscriptenIlluminateSelectionPlayerAdapter",
    );
    var adapter = /** @type {LlvmSelectionPlayerAdapter} */ (
        await module.loadEmscriptenIlluminateSelectionPlayerAdapter(assets.manifestUrl)
    );
    requireFunction(adapter.createPlayer, "adapter.createPlayer");
    requireFunction(adapter.dispatch, "adapter.dispatch");
    requireFunction(adapter.dispatchTick, "adapter.dispatchTick");
    requireFunction(adapter.disposePlayer, "adapter.disposePlayer");
    requireFunction(adapter.replayTrace, "adapter.replayTrace");
    return adapter;
}
