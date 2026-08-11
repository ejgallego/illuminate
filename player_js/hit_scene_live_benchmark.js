// @ts-check

/**
 * @typedef {{ kind: string, value?: number, label?: string }} HitSceneResult
 * @typedef {{ count: number, meanMs: number, medianMs: number, p95Ms: number, maxMs: number }} HitSceneTimingSummary
 * @typedef {{
 *   samplesPerBackend: number,
 *   rpc: HitSceneTimingSummary,
 *   vir: HitSceneTimingSummary,
 *   rpcOverVir: number
 * }} ResidentRpcBenchmarkResult
 */

/** @param {HitSceneResult} left @param {HitSceneResult} right */
export function sameHitSceneResult(left, right) {
    return (
        left.kind === right.kind &&
        (right.kind !== "tag" || (left.value === right.value && left.label === right.label))
    );
}

/** @param {number[]} samples @returns {HitSceneTimingSummary} */
function summarize(samples) {
    const sorted = [...samples].sort((left, right) => left - right);
    const percentile = (/** @type {number} */ fraction) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
    return {
        count: samples.length,
        meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
        medianMs: percentile(0.5),
        p95Ms: percentile(0.95),
        maxMs: sorted.at(-1) ?? 0,
    };
}

/**
 * Runs the same retained-scene queries through cached Lean RPC and browser-resident VIR.
 * The first round warms both paths; measured rounds alternate which backend runs first.
 *
 * @param {{
 *   points: Array<{ x: number, y: number }>,
 *   queryRpc: (x: number, y: number) => Promise<HitSceneResult>,
 *   queryVir: (x: number, y: number) => HitSceneResult,
 *   warmupRounds?: number,
 *   measuredRounds?: number,
 *   now?: () => number,
 *   isCurrent?: () => boolean,
 *   onProgress?: (completedRounds: number, totalRounds: number) => void
 * }} options
 * @returns {Promise<ResidentRpcBenchmarkResult>}
 */
export async function runResidentRpcHitSceneBenchmark(options) {
    const warmupRounds = options.warmupRounds ?? 1;
    const measuredRounds = options.measuredRounds ?? 4;
    const now = options.now ?? (() => performance.now());
    if (options.points.length === 0) throw new Error("hit-scene benchmark needs query points");
    if (!Number.isSafeInteger(warmupRounds) || warmupRounds < 0) {
        throw new Error("warmupRounds must be a nonnegative integer");
    }
    if (!Number.isSafeInteger(measuredRounds) || measuredRounds <= 0) {
        throw new Error("measuredRounds must be a positive integer");
    }

    /** @type {number[]} */
    const rpcSamples = [];
    /** @type {number[]} */
    const virSamples = [];
    const totalRounds = warmupRounds + measuredRounds;
    for (let round = 0; round < totalRounds; round += 1) {
        if (options.isCurrent !== undefined && !options.isCurrent()) {
            throw new Error("diagram changed during the live hit-scene benchmark");
        }
        const measured = round >= warmupRounds;
        const rpcFirst = round % 2 === 0;
        for (const point of options.points) {
            /** @type {HitSceneResult | null} */
            let rpcResult = null;
            /** @type {HitSceneResult | null} */
            let virResult = null;
            for (const backend of rpcFirst ? ["rpc", "vir"] : ["vir", "rpc"]) {
                const started = now();
                if (backend === "rpc") rpcResult = await options.queryRpc(point.x, point.y);
                else virResult = options.queryVir(point.x, point.y);
                const duration = now() - started;
                if (measured) {
                    if (backend === "rpc") rpcSamples.push(duration);
                    else virSamples.push(duration);
                }
            }
            if (
                rpcResult === null ||
                virResult === null ||
                !sameHitSceneResult(rpcResult, virResult)
            ) {
                throw new Error(
                    `cached RPC and VIR disagreed at (${point.x.toFixed(3)}, ${point.y.toFixed(3)})`,
                );
            }
        }
        options.onProgress?.(round + 1, totalRounds);
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const rpc = summarize(rpcSamples);
    const vir = summarize(virSamples);
    return {
        samplesPerBackend: rpcSamples.length,
        rpc,
        vir,
        rpcOverVir: vir.medianMs > 0 ? rpc.medianMs / vir.medianMs : Number.POSITIVE_INFINITY,
    };
}
