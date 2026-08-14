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
const directOutput = path.join(temporary, "direct-package");

function run(args, stdio = "inherit") {
    return execFileSync(process.execPath, args, { cwd: source, stdio });
}

function expectFailure(args, pattern) {
    let failure = null;
    try {
        run(args, "pipe");
    } catch (error) {
        failure = error;
    }
    assert.ok(failure, `command unexpectedly succeeded: ${args.join(" ")}`);
    assert.match(`${failure.message}\n${failure.stderr ?? ""}`, pattern);
}

try {
    const args = [
        "scripts/export-browser-benchmark-source.mjs",
        "--output",
        output,
        "--checkout",
        `producer=${source}`,
        "--allow-dirty",
    ];
    run(args);
    const build = JSON.parse(await readFile(path.join(output, "BUILD.json"), "utf8"));
    assert.equal(build.producerProtocol, "browser-benchmarks/source-package/v1");
    assert.equal(build.toolchain.elan, toolchain);
    assert.equal(build.workload.exampleCount, 16);
    assert.equal(Object.hasOwn(build.source, "repository"), false);
    assert.deepEqual(build.files.map(({ path: item }) => item).sort(), [
        "smoke.mjs",
        "workload/anim_core.js",
        "workload/examples.json",
        "workload/js-player-trace.mjs",
        "workload/vir-player-trace.mjs",
    ]);
    expectFailure(args, /output directory already exists/);

    const directArgs = [
        "scripts/export-browser-benchmark-source.mjs",
        "--source",
        source,
        "--toolchain",
        toolchain,
        "--output",
        directOutput,
        "--allow-dirty",
    ];
    run(directArgs);
    for (const item of [
        "BUILD.json",
        "SHA256SUMS",
        "smoke.mjs",
        "workload/anim_core.js",
        "workload/examples.json",
        "workload/js-player-trace.mjs",
        "workload/vir-player-trace.mjs",
    ]) {
        assert.deepEqual(
            await readFile(path.join(output, item)),
            await readFile(path.join(directOutput, item)),
            `${item} differs between generic and direct invocation`,
        );
    }

    const base = [
        "scripts/export-browser-benchmark-source.mjs",
        "--output",
        path.join(temporary, "rejected"),
    ];
    expectFailure(
        [...base, "--checkout", `producer=${source}`, "--source", source, "--allow-dirty"],
        /either --checkout producer=PATH or --source/,
    );
    expectFailure(
        [...base, "--checkout", `dependency=${source}`, "--allow-dirty"],
        /unknown checkout role: dependency/,
    );
    expectFailure(
        [...base, "--checkout", `producer=${source}`, "--package", `fir=${source}`],
        /does not accept dependency packages/,
    );
    console.log("Illuminate browser benchmark source producer passed");
} finally {
    await rm(temporary, { recursive: true, force: true });
}
