import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const toolchain = (await readFile(path.join(source, "lean-toolchain"), "utf8")).trim();
const temporary = await mkdtemp(path.join(os.tmpdir(), "illuminate-browser-source-"));
const output = path.join(temporary, "package");

try {
    const args = [
        "scripts/export-browser-benchmark-source.mjs",
        "--source",
        source,
        "--toolchain",
        toolchain,
        "--output",
        output,
        "--allow-dirty",
    ];
    execFileSync(process.execPath, args, { cwd: source, stdio: "inherit" });
    const build = JSON.parse(await readFile(path.join(output, "BUILD.json"), "utf8"));
    assert.equal(build.producerProtocol, "browser-benchmarks/source-package/v1");
    assert.equal(build.toolchain.elan, toolchain);
    assert.equal(build.workload.exampleCount, 16);
    assert.deepEqual(build.files.map(({ path: item }) => item).sort(), [
        "smoke.mjs",
        "workload/anim_core.js",
        "workload/examples.json",
        "workload/js-player-trace.mjs",
        "workload/vir-player-trace.mjs",
    ]);
    assert.throws(
        () => execFileSync(process.execPath, args, { cwd: source, stdio: "pipe" }),
        /Command failed/,
        "producer overwrote an existing output directory",
    );
    console.log("Illuminate browser benchmark source producer passed");
} finally {
    await rm(temporary, { recursive: true, force: true });
}
