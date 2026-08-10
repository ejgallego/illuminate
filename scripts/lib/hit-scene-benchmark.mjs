export const HIT_SCENE_BENCHMARK_SCHEMA = "illuminate.hit-scene-benchmark/v1";

const bitStorage = new ArrayBuffer(8);
const bitView = new DataView(bitStorage);

/** Converts an unsigned decimal binary64 payload to a JavaScript number. */
export function float64FromBits(source) {
    const bits = BigInt(source);
    assertUnsigned64(bits, source);
    bitView.setBigUint64(0, bits, true);
    return bitView.getFloat64(0, true);
}

/** Returns the unsigned decimal binary64 payload of a JavaScript number. */
export function float64ToBits(value) {
    bitView.setFloat64(0, value, true);
    return bitView.getBigUint64(0, true).toString();
}

function assertUnsigned64(bits, source) {
    if (bits < 0n || bits > 0xffffffffffffffffn) {
        throw new Error(`binary64 payload is outside UInt64: ${source}`);
    }
}

function validateExpected(value, index) {
    if (typeof value !== "object" || value === null) {
        throw new Error(`query ${index} has no expected result object`);
    }
    if (value.kind === "nothing" || value.kind === "something") {
        return Object.freeze({ kind: value.kind });
    }
    if (
        value.kind === "tag" &&
        Number.isSafeInteger(value.value) &&
        value.value >= 0 &&
        typeof value.label === "string"
    ) {
        return Object.freeze({ kind: "tag", value: value.value, label: value.label });
    }
    throw new Error(`query ${index} has invalid expected constructor ${String(value.kind)}`);
}

/** Parses and validates a Lean-generated hit-scene benchmark fixture. */
export function parseHitSceneBenchmark(source) {
    const value = typeof source === "string" ? JSON.parse(source) : source;
    if (value?.schemaVersion !== HIT_SCENE_BENCHMARK_SCHEMA) {
        throw new Error(`unsupported hit-scene benchmark schema ${String(value?.schemaVersion)}`);
    }
    if (typeof value.encodedScene !== "string" || value.encodedScene.length === 0) {
        throw new Error("hit-scene benchmark has no encoded scene");
    }
    const parsedScene = JSON.parse(value.encodedScene);
    if (!Array.isArray(value.queries) || value.queries.length === 0) {
        throw new Error("hit-scene benchmark has no queries");
    }
    if (value.queryCount !== value.queries.length) {
        throw new Error(
            `hit-scene benchmark declares ${value.queryCount} queries but contains ${value.queries.length}`,
        );
    }
    const names = new Set();
    const queries = value.queries.map((query, index) => {
        if (typeof query.name !== "string" || query.name.length === 0) {
            throw new Error(`query ${index} has no name`);
        }
        if (names.has(query.name)) throw new Error(`duplicate hit-scene query ${query.name}`);
        names.add(query.name);
        if (typeof query.xBits !== "string" || typeof query.yBits !== "string") {
            throw new Error(`query ${query.name} has no binary64 payloads`);
        }
        const x = float64FromBits(query.xBits);
        const y = float64FromBits(query.yBits);
        if (float64ToBits(x) !== query.xBits || float64ToBits(y) !== query.yBits) {
            throw new Error(`query ${query.name} did not round-trip its binary64 payloads`);
        }
        return Object.freeze({
            name: query.name,
            xBits: query.xBits,
            yBits: query.yBits,
            x,
            y,
            expected: validateExpected(query.expected, index),
        });
    });
    return Object.freeze({
        schemaVersion: value.schemaVersion,
        description: String(value.description ?? ""),
        encodedScene: value.encodedScene,
        parsedScene,
        referenceQueryCount: value.referenceQueryCount,
        coverage: Object.freeze([...(value.coverage ?? [])]),
        queries: Object.freeze(queries),
    });
}

/** Loads a benchmark fixture from a filesystem path. */
export async function loadHitSceneBenchmark(path) {
    const { readFile } = await import("node:fs/promises");
    return parseHitSceneBenchmark(await readFile(path, "utf8"));
}

/** Fetches a benchmark fixture in a browser. */
export async function fetchHitSceneBenchmark(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`failed to fetch hit-scene benchmark: ${response.status}`);
    return parseHitSceneBenchmark(await response.json());
}

function sameResult(left, right) {
    return (
        left?.kind === right.kind &&
        (right.kind !== "tag" || (left.value === right.value && left.label === right.label))
    );
}

function percentile(sorted, fraction) {
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function summarize(samples) {
    const sorted = [...samples].sort((left, right) => left - right);
    const total = samples.reduce((sum, value) => sum + value, 0);
    return Object.freeze({
        count: samples.length,
        meanMs: samples.length === 0 ? 0 : total / samples.length,
        medianMs: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
        maxMs: sorted.at(-1) ?? 0,
    });
}

async function settle(value) {
    return value !== null && typeof value === "object" && typeof value.then === "function"
        ? await value
        : value;
}

/**
 * Runs balanced correctness and latency rounds over interchangeable RPC, VIR, or FIR backends.
 *
 * Each backend supplies `create`, `query`, and `dispose`. `create` receives both the canonical
 * encoded scene and its parsed JavaScript object so a runtime can use its natural one-time
 * boundary without changing the fixture. Query order rotates per round. Creation is measured
 * independently and is never included in steady-state samples.
 */
export async function runPairedHitSceneBenchmark(
    fixture,
    backends,
    {
        warmupRounds = 2,
        measuredRounds = 10,
        retainSamples = false,
        now = () => performance.now(),
    } = {},
) {
    const entries = Object.entries(backends);
    if (entries.length === 0) throw new Error("hit-scene benchmark requires at least one backend");
    if (!Number.isSafeInteger(warmupRounds) || warmupRounds < 0) {
        throw new Error("warmupRounds must be a nonnegative integer");
    }
    if (!Number.isSafeInteger(measuredRounds) || measuredRounds <= 0) {
        throw new Error("measuredRounds must be a positive integer");
    }

    const mounted = [];
    try {
        for (const [name, backend] of entries) {
            const started = now();
            const context = await settle(
                backend.create({
                    encodedScene: fixture.encodedScene,
                    parsedScene: fixture.parsedScene,
                }),
            );
            const completed = now();
            mounted.push({ name, backend, context, creationMs: completed - started, samples: [] });
        }

        for (const query of fixture.queries) {
            for (const mountedBackend of mounted) {
                const actual = await settle(
                    mountedBackend.backend.query(mountedBackend.context, query.x, query.y),
                );
                if (!sameResult(actual, query.expected)) {
                    throw new Error(
                        `${mountedBackend.name} mismatch at ${query.name} ` +
                            `(xBits=${query.xBits}, yBits=${query.yBits}): ` +
                            `expected ${JSON.stringify(query.expected)}, got ${JSON.stringify(actual)}`,
                    );
                }
            }
        }

        for (let round = 0; round < warmupRounds + measuredRounds; round += 1) {
            const order = mounted.map((_, index) => mounted[(index + round) % mounted.length]);
            for (const query of fixture.queries) {
                for (const mountedBackend of order) {
                    const started = now();
                    const actual = await settle(
                        mountedBackend.backend.query(mountedBackend.context, query.x, query.y),
                    );
                    const completed = now();
                    if (!sameResult(actual, query.expected)) {
                        throw new Error(
                            `${mountedBackend.name} changed result during ${query.name}`,
                        );
                    }
                    if (round >= warmupRounds) mountedBackend.samples.push(completed - started);
                }
            }
        }

        return Object.freeze(
            Object.fromEntries(
                mounted.map(({ name, creationMs, samples }) => [
                    name,
                    Object.freeze({
                        creationMs,
                        query: summarize(samples),
                        ...(retainSamples ? { samples: Object.freeze([...samples]) } : {}),
                    }),
                ]),
            ),
        );
    } finally {
        for (const mountedBackend of mounted.reverse()) {
            await settle(mountedBackend.backend.dispose(mountedBackend.context));
        }
    }
}
