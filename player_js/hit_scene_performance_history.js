// @ts-check

export const HIT_SCENE_PERFORMANCE_HISTORY_SCHEMA =
    "illuminate.hit-scene-performance-history-record/v1";

/** @param {any} result */
function withoutSamples(result) {
    if (result === undefined) return undefined;
    const { samples: _samples, ...summary } = result;
    return summary;
}

/** @param {any} result */
function withoutRawDiagnostics(result) {
    if (result === undefined) return undefined;
    const { raw: _raw, ...summary } = result;
    return summary;
}

/** @param {any} measurement */
function compactMeasurement(measurement) {
    return {
        fixture: measurement.fixture,
        production: Object.fromEntries(
            Object.entries(measurement.production ?? {}).map(([backend, result]) => [
                backend,
                withoutSamples(result),
            ]),
        ),
        diagnostics: Object.fromEntries(
            Object.entries(measurement.diagnostics ?? {}).map(([backend, result]) => [
                backend,
                withoutRawDiagnostics(result),
            ]),
        ),
        deltas: measurement.deltas ?? {},
    };
}

/** @param {any} record @param {number} lineNumber */
function validateRecord(record, lineNumber) {
    if (record?.schemaVersion !== HIT_SCENE_PERFORMANCE_HISTORY_SCHEMA) {
        throw new Error(
            `unsupported hit-scene performance history schema on line ${lineNumber}: ` +
                String(record?.schemaVersion),
        );
    }
    if (
        typeof record.generatedAt !== "string" ||
        !Number.isFinite(Date.parse(record.generatedAt))
    ) {
        throw new Error(`invalid hit-scene performance timestamp on line ${lineNumber}`);
    }
    if (!Array.isArray(record.workloads) || record.workloads.length === 0) {
        throw new Error(`hit-scene performance history line ${lineNumber} has no workloads`);
    }
    return record;
}

/**
 * Builds the compact, append-only record for one Node benchmark report.
 * @param {any} report
 * @param {{ label?: string | null }} [options]
 */
export function createHitScenePerformanceHistoryRecord(report, { label = null } = {}) {
    const measurements = Array.isArray(report.workloads) ? report.workloads : [report];
    return validateRecord(
        {
            schemaVersion: HIT_SCENE_PERFORMANCE_HISTORY_SCHEMA,
            generatedAt: report.generatedAt,
            label,
            source: report.source ?? null,
            environment: report.environment,
            protocol: report.protocol,
            backends: report.backends,
            benchmarkArtifact: report.benchmarkArtifact ?? null,
            workloads: measurements.map(compactMeasurement),
        },
        1,
    );
}

/** Parses newline-delimited HitScene performance history records. @param {string} source */
export function parseHitScenePerformanceHistory(source) {
    return source
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line, index) => {
            try {
                return validateRecord(JSON.parse(line), index + 1);
            } catch (error) {
                if (error instanceof SyntaxError) {
                    throw new Error(
                        `invalid JSON on hit-scene performance history line ${index + 1}`,
                    );
                }
                throw error;
            }
        });
}
