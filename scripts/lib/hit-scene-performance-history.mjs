import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

export {
    createHitScenePerformanceHistoryRecord,
    HIT_SCENE_PERFORMANCE_HISTORY_SCHEMA,
    parseHitScenePerformanceHistory,
} from "../../player_js/hit_scene_performance_history.js";
import {
    createHitScenePerformanceHistoryRecord,
    parseHitScenePerformanceHistory,
} from "../../player_js/hit_scene_performance_history.js";

/** Appends one compact benchmark record using a single filesystem write. */
export async function appendHitScenePerformanceHistory(filename, report, options = {}) {
    const record = createHitScenePerformanceHistoryRecord(report, options);
    await mkdir(path.dirname(filename), { recursive: true });
    await appendFile(filename, `${JSON.stringify(record)}\n`, "utf8");
    return record;
}

/** Loads an existing newline-delimited history file. */
export async function loadHitScenePerformanceHistory(filename) {
    return parseHitScenePerformanceHistory(await readFile(filename, "utf8"));
}
