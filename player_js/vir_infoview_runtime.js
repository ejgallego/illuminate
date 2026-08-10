// @ts-check
import {
    createVirRuntime,
    IR_PACKAGE_SET_FORMAT,
    IR_PACKAGE_SET_VERSION,
    // @ts-ignore -- bundled from the repository-local VIR checkout by scripts/build-vir-widget.mjs.
} from "../vir/web/src/vir-runtime.js";

const serviceCache = new Map();

/**
 * @typedef {{ path: string, revision: string, dataBase64?: string }} VirAssetResponse
 * @typedef {{ format: string, version: number, packages: Array<{ path: string }> }} VirPackageSetDescriptor
 * @typedef {{ descriptor: VirAssetResponse, members: VirAssetResponse[] }} VirPackageSetAssets
 * @typedef {{
 *   call(name: string, ...args: unknown[]): unknown,
 *   callTimed(name: string, ...args: unknown[]): { value: unknown, timings: Record<string, number> },
 *   dispose(): void
 * }} VirRuntime
 * @typedef {{
 *   key: string,
 *   baseKey: string,
 *   runtime: VirRuntime,
 *   refs: number,
 *   stale: boolean,
 *   idleTimer: ReturnType<typeof setTimeout> | null
 * }} VirRuntimeService
 */

/** Decodes a base64 RPC payload. @param {string} data */
function decodeVirAsset(data) {
    var binary = atob(data);
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

/** @param {import("@leanprover/infoview").RpcSession} rpc @param {string} path */
async function statAsset(rpc, path) {
    return /** @type {Promise<VirAssetResponse>} */ (
        rpc.call("Illuminate.statVirAsset", { path: path })
    );
}

/** @param {import("@leanprover/infoview").RpcSession} rpc @param {string} path */
async function readAsset(rpc, path) {
    return /** @type {Promise<VirAssetResponse>} */ (
        rpc.call("Illuminate.readVirAsset", { path: path })
    );
}

/** @param {string} packageSetPath @param {string} dataBase64 */
function packageSetMemberPaths(packageSetPath, dataBase64) {
    var descriptor = /** @type {VirPackageSetDescriptor} */ (
        JSON.parse(new TextDecoder().decode(decodeVirAsset(dataBase64)))
    );
    if (
        descriptor.format !== IR_PACKAGE_SET_FORMAT ||
        descriptor.version !== IR_PACKAGE_SET_VERSION ||
        !Array.isArray(descriptor.packages) ||
        descriptor.packages.length === 0
    ) {
        throw new Error("invalid VIR package-set descriptor");
    }
    var separator = packageSetPath.lastIndexOf("/");
    var basePath = separator < 0 ? "" : packageSetPath.slice(0, separator + 1);
    var paths = descriptor.packages.map(function (member) {
        var path = member && member.path;
        if (
            typeof path !== "string" ||
            path === "" ||
            path.startsWith("/") ||
            path.split("/").some(function (component) {
                return component === "" || component === "." || component === "..";
            })
        ) {
            throw new Error("invalid VIR package-set member path");
        }
        return basePath + path;
    });
    if (new Set(paths).size !== paths.length) throw new Error("duplicate VIR package member");
    return paths;
}

/** @param {import("@leanprover/infoview").RpcSession} rpc @param {string} packageSetPath */
async function readPackageSetAssets(rpc, packageSetPath) {
    var descriptor = await readAsset(rpc, packageSetPath);
    if (!descriptor.dataBase64) throw new Error("VIR package-set RPC returned no data");
    var paths = packageSetMemberPaths(packageSetPath, descriptor.dataBase64);
    var members = await Promise.all(
        paths.map(function (path) {
            return readAsset(rpc, path);
        }),
    );
    if (
        members.some(function (member) {
            return !member.dataBase64;
        })
    ) {
        throw new Error("VIR package member RPC returned no data");
    }
    return /** @type {VirPackageSetAssets} */ ({ descriptor, members });
}

/** @param {import("@leanprover/infoview").RpcSession} rpc @param {string} packageSetPath */
async function statPackageSetAssets(rpc, packageSetPath) {
    var descriptor = await readAsset(rpc, packageSetPath);
    if (!descriptor.dataBase64) throw new Error("VIR package-set RPC returned no data");
    var paths = packageSetMemberPaths(packageSetPath, descriptor.dataBase64);
    return [
        descriptor,
        ...(await Promise.all(
            paths.map(function (path) {
                return statAsset(rpc, path);
            }),
        )),
    ];
}

/** @param {VirRuntimeService} service */
function disposeService(service) {
    if (service.idleTimer !== null) clearTimeout(service.idleTimer);
    if (serviceCache.get(service.key) === service) serviceCache.delete(service.key);
    service.runtime.dispose();
}

/** Releases one shared InfoView runtime lease. @param {VirRuntimeService} service */
export function releaseVirRuntimeService(service) {
    service.refs = Math.max(0, service.refs - 1);
    if (service.refs !== 0) return;
    if (service.stale) {
        disposeService(service);
    } else {
        service.idleTimer = setTimeout(function () {
            if (service.refs === 0) disposeService(service);
        }, 60_000);
    }
}

/**
 * Computes a revision key for one staged runtime and package-set pair.
 * @param {import("@leanprover/infoview").RpcSession} rpc
 * @param {string} wasmPath
 * @param {string} packageSetPath
 */
export async function statVirRuntimeRevision(rpc, wasmPath, packageSetPath) {
    var assets = await Promise.all([
        statAsset(rpc, wasmPath),
        statPackageSetAssets(rpc, packageSetPath),
    ]);
    return JSON.stringify(
        [assets[0], ...assets[1]].map(function (asset) {
            return asset.revision;
        }),
    );
}

/**
 * Acquires a shared, revision-keyed VIR runtime for an InfoView widget.
 * @param {import("@leanprover/infoview").RpcSession} rpc
 * @param {string} wasmPath
 * @param {string} packageSetPath
 * @returns {Promise<VirRuntimeService>}
 */
export async function acquireVirRuntimeService(rpc, wasmPath, packageSetPath) {
    var assets = await Promise.all([
        readAsset(rpc, wasmPath),
        readPackageSetAssets(rpc, packageSetPath),
    ]);
    var wasm = assets[0];
    var packageSet = assets[1];
    if (!wasm.dataBase64) throw new Error("VIR Wasm RPC returned no data");
    var baseKey = JSON.stringify([wasmPath, packageSetPath]);
    var key = JSON.stringify([
        baseKey,
        wasm.revision,
        packageSet.descriptor.revision,
        ...packageSet.members.map(function (member) {
            return member.revision;
        }),
    ]);
    var service = serviceCache.get(key);
    if (!service) {
        var runtime = /** @type {VirRuntime} */ (
            await createVirRuntime({
                wasmBytes: decodeVirAsset(wasm.dataBase64),
                irPackageSetBytes: packageSet.members.map(function (member) {
                    return decodeVirAsset(/** @type {string} */ (member.dataBase64));
                }),
            })
        );
        service = { key, baseKey, runtime, refs: 0, stale: false, idleTimer: null };
        serviceCache.set(key, service);
        for (var candidate of serviceCache.values()) {
            if (candidate !== service && candidate.baseKey === baseKey) {
                candidate.stale = true;
                if (candidate.refs === 0) disposeService(candidate);
            }
        }
    }
    if (service.idleTimer !== null) {
        clearTimeout(service.idleTimer);
        service.idleTimer = null;
    }
    service.refs += 1;
    return service;
}
