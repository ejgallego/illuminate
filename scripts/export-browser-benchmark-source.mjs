#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

function usage() {
    console.log(`Usage: node scripts/export-browser-benchmark-source.mjs [options]

Exports Illuminate-owned animation benchmark inputs into a fresh directory.

  --output PATH                 fresh caller-owned output directory
  --checkout producer=PATH      exact clean Illuminate checkout (catalog form)
  --source PATH                 exact Illuminate checkout root (direct-use alias)
  --toolchain NAME              exact elan toolchain for --source
  --allow-dirty                 permit a dirty source only for local development`);
}

function parseArgs(argv) {
    const options = {
        source: null,
        toolchain: null,
        output: null,
        producerCheckout: null,
        allowDirty: false,
    };
    /** @param {number} index @param {string} option */
    function valueAfter(index, option) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new Error(`${option} requires a value`);
        }
        return value;
    }
    /** @param {"source" | "toolchain" | "output"} name @param {string} value */
    function setOnce(name, value) {
        if (options[name] !== null) throw new Error(`duplicate --${name}`);
        options[name] = value;
    }
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === "--source") setOnce("source", valueAfter(index++, argument));
        else if (argument === "--toolchain") {
            setOnce("toolchain", valueAfter(index++, argument));
        } else if (argument === "--output") setOnce("output", valueAfter(index++, argument));
        else if (argument === "--checkout") {
            const assignment = valueAfter(index++, argument);
            const separator = assignment.indexOf("=");
            if (separator <= 0 || separator === assignment.length - 1) {
                throw new Error("--checkout requires ROLE=PATH");
            }
            const role = assignment.slice(0, separator);
            if (role !== "producer") throw new Error(`unknown checkout role: ${role}`);
            if (options.producerCheckout !== null) {
                throw new Error("duplicate --checkout producer=...");
            }
            options.producerCheckout = assignment.slice(separator + 1);
        } else if (argument === "--package") {
            valueAfter(index, argument);
            throw new Error("this source-only producer does not accept dependency packages");
        } else if (argument === "--allow-dirty") {
            if (options.allowDirty) throw new Error("duplicate --allow-dirty");
            options.allowDirty = true;
        } else if (argument === "--help" || argument === "-h") {
            usage();
            process.exit(0);
        } else throw new Error(`unknown argument: ${argument}`);
    }
    if (options.output === null) throw new Error("pass --output VALUE");
    if (options.producerCheckout !== null) {
        if (options.source !== null) {
            throw new Error("use either --checkout producer=PATH or --source, not both");
        }
        if (options.toolchain !== null) {
            throw new Error("--checkout producer=PATH derives its toolchain; omit --toolchain");
        }
        options.source = options.producerCheckout;
    } else {
        if (options.source === null)
            throw new Error("pass --checkout producer=PATH or --source PATH");
        if (options.toolchain === null) throw new Error("--source requires --toolchain NAME");
    }
    return options;
}

function command(command, args, options = {}) {
    const { capture = false, ...execOptions } = options;
    const result = execFileSync(command, args, {
        encoding: "utf8",
        stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
        ...execOptions,
    });
    return typeof result === "string" ? result.trim() : "";
}

function git(source, args) {
    return command("git", ["-C", source, ...args], { capture: true });
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

async function fileRecord(root, relativePath) {
    const bytes = await readFile(path.join(root, relativePath));
    return { path: relativePath, byteLength: bytes.byteLength, sha256: sha256(bytes) };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const source = await realpath(path.resolve(options.source));
    const output = path.resolve(options.output);
    if ((await lstat(output).catch(() => null)) !== null) {
        throw new Error(`output directory already exists: ${output}`);
    }
    assertSourceRoot(source);
    const pinnedToolchain = (await readFile(path.join(source, "lean-toolchain"), "utf8")).trim();
    const toolchain = options.toolchain ?? pinnedToolchain;
    if (toolchain !== pinnedToolchain) {
        throw new Error(
            `toolchain mismatch: source pins ${pinnedToolchain}, received ${toolchain}`,
        );
    }
    const status = git(source, ["status", "--porcelain"]);
    if (status !== "" && !options.allowDirty) {
        throw new Error("Illuminate source must be clean; --allow-dirty is local-development only");
    }

    await mkdir(path.join(output, "workload"), { recursive: true });
    try {
        const examplesPath = path.join(output, "workload/examples.json");
        command(
            "elan",
            [
                "run",
                toolchain,
                "lake",
                "--file",
                "lakefile.benchmark.lean",
                "exe",
                "illuminate-browser-benchmark-source",
                examplesPath,
            ],
            { cwd: source },
        );
        await Promise.all([
            cp(
                path.join(source, "player_js/anim_core.js"),
                path.join(output, "workload/anim_core.js"),
            ),
            cp(
                path.join(source, "scripts/lib/js-player-trace.mjs"),
                path.join(output, "workload/js-player-trace.mjs"),
            ),
            cp(
                path.join(source, "scripts/lib/vir-player-trace.mjs"),
                path.join(output, "workload/vir-player-trace.mjs"),
            ),
            cp(
                path.join(source, "scripts/browser-benchmark-source-smoke.mjs"),
                path.join(output, "smoke.mjs"),
            ),
        ]);

        const examples = JSON.parse(await readFile(examplesPath, "utf8"));
        const payloadPaths = [
            "smoke.mjs",
            "workload/anim_core.js",
            "workload/examples.json",
            "workload/js-player-trace.mjs",
            "workload/vir-player-trace.mjs",
        ];
        const files = await Promise.all(payloadPaths.map((item) => fileRecord(output, item)));
        const sourceCommit = git(source, ["rev-parse", "HEAD"]);
        const leanVersion = command("elan", ["run", toolchain, "lean", "--version"], {
            capture: true,
        });
        const build = {
            schemaVersion: 1,
            kind: "illuminate/browser-benchmark-source",
            producerProtocol: "browser-benchmarks/source-package/v1",
            source: {
                commit: sourceCommit,
                dirty: status !== "",
            },
            toolchain: {
                elan: toolchain,
                leanVersion,
            },
            workload: {
                contract: "illuminate/player-trace/v1",
                exampleCount: examples.length,
                javascriptOracle: "workload/js-player-trace.mjs",
                javascriptCore: "workload/anim_core.js",
                virProjection: "workload/vir-player-trace.mjs",
                semanticInputs: "workload/examples.json",
            },
            files,
        };
        await writeFile(path.join(output, "BUILD.json"), `${JSON.stringify(build, null, 2)}\n`);
        const checksumPaths = ["BUILD.json", ...payloadPaths];
        const checksums = await Promise.all(
            checksumPaths.map(
                async (item) => `${sha256(await readFile(path.join(output, item)))}  ${item}`,
            ),
        );
        await writeFile(path.join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);
        command("sha256sum", ["--check", "SHA256SUMS"], { cwd: output });
        command(process.execPath, ["smoke.mjs"], { cwd: output });
        console.log(`exported ${examples.length} Illuminate benchmark examples to ${output}`);
    } catch (error) {
        await rm(output, { recursive: true, force: true });
        throw error;
    }
}

function assertSourceRoot(source) {
    if (git(source, ["rev-parse", "--show-toplevel"]) !== source) {
        throw new Error(`--source must be a Git checkout root: ${source}`);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
});
