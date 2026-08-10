// @ts-check
import * as React from "react";
import { useRpcSession } from "@leanprover/infoview";
import {
    createVirRuntime,
    IR_PACKAGE_SET_FORMAT,
    IR_PACKAGE_SET_VERSION,
    // @ts-ignore -- bundled from the repository-local VIR checkout by scripts/build-vir-widget.mjs.
} from "../vir/web/src/vir-runtime.js";

const e = React.createElement;
const serviceCache = new Map();
let nextMountId = 0;

/**
 * @typedef {{ animData: AnimData, wasmPath: string, packageSetPath: string, autoReloadMs?: number }} AnimateVirProps
 * @typedef {{ path: string, revision: string, dataBase64?: string }} VirAssetResponse
 * @typedef {{ format: string, version: number, packages: Array<{ path: string }> }} VirPackageSetDescriptor
 * @typedef {{
 *   descriptor: VirAssetResponse,
 *   memberPaths: string[],
 *   members: VirAssetResponse[]
 * }} VirPackageSetAssets
 * @typedef {{ call(name: string, ...args: unknown[]): unknown, dispose(): void }} VirRuntime
 * @typedef {{
 *   key: string,
 *   baseKey: string,
 *   runtime: VirRuntime,
 *   refs: number,
 *   stale: boolean,
 *   idleTimer: ReturnType<typeof setTimeout> | null
 * }} RuntimeService
 */

/** Decodes a base64 RPC payload without retaining the intermediate string. @param {string} data */
export function decodeVirAsset(data) {
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
    var text = new TextDecoder().decode(decodeVirAsset(dataBase64));
    var descriptor = /** @type {VirPackageSetDescriptor} */ (JSON.parse(text));
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
    if (new Set(paths).size !== paths.length) {
        throw new Error("duplicate VIR package-set member path");
    }
    return paths;
}

/** @param {import("@leanprover/infoview").RpcSession} rpc @param {string} packageSetPath */
async function readPackageSetAssets(rpc, packageSetPath) {
    var descriptor = await readAsset(rpc, packageSetPath);
    if (!descriptor.dataBase64) {
        throw new Error("VIR package-set RPC returned no descriptor data");
    }
    var memberPaths = packageSetMemberPaths(packageSetPath, descriptor.dataBase64);
    var members = await Promise.all(
        memberPaths.map(function (path) {
            return readAsset(rpc, path);
        }),
    );
    if (
        members.some(function (member) {
            return !member.dataBase64;
        })
    ) {
        throw new Error("VIR package-set RPC returned no member data");
    }
    return /** @type {VirPackageSetAssets} */ ({ descriptor, memberPaths, members });
}

/** @param {import("@leanprover/infoview").RpcSession} rpc @param {string} packageSetPath */
async function statPackageSetAssets(rpc, packageSetPath) {
    var descriptor = await readAsset(rpc, packageSetPath);
    if (!descriptor.dataBase64) {
        throw new Error("VIR package-set RPC returned no descriptor data");
    }
    var memberPaths = packageSetMemberPaths(packageSetPath, descriptor.dataBase64);
    var members = await Promise.all(
        memberPaths.map(function (path) {
            return statAsset(rpc, path);
        }),
    );
    return [descriptor, ...members];
}

/** @param {RuntimeService} service */
function disposeService(service) {
    if (service.idleTimer !== null) {
        clearTimeout(service.idleTimer);
        service.idleTimer = null;
    }
    if (serviceCache.get(service.key) === service) {
        serviceCache.delete(service.key);
    }
    service.runtime.dispose();
}

/** @param {RuntimeService} service */
function releaseService(service) {
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
 * @param {import("@leanprover/infoview").RpcSession} rpc
 * @param {string} wasmPath
 * @param {string} packageSetPath
 * @returns {Promise<RuntimeService>}
 */
async function acquireService(rpc, wasmPath, packageSetPath) {
    var assets = await Promise.all([
        readAsset(rpc, wasmPath),
        readPackageSetAssets(rpc, packageSetPath),
    ]);
    var wasm = assets[0];
    var packageSet = assets[1];
    if (!wasm.dataBase64) {
        throw new Error("VIR Wasm RPC returned no data");
    }
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

/**
 * VIR-backed animation player component for the Lean InfoView.
 * @param {AnimateVirProps} props
 * @returns {React.ReactElement}
 */
export default function AnimateVirWidget(props) {
    var rpc = useRpcSession();
    var rpcRef = React.useRef(rpc);
    var mountIdRef = React.useRef("");
    if (mountIdRef.current === "") {
        mountIdRef.current = "illuminate-vir-animation-" + String(nextMountId++);
    }
    var mountId = mountIdRef.current;
    var _revision = React.useState("");
    var revision = _revision[0];
    var setRevision = _revision[1];
    var _status = React.useState("Loading animation…");
    var status = _status[0];
    var setStatus = _status[1];
    var animationKey = JSON.stringify(props.animData);

    React.useEffect(
        function () {
            rpcRef.current = rpc;
        },
        [rpc],
    );

    React.useEffect(
        function () {
            var disposed = false;
            /** @type {ReturnType<typeof setInterval> | null} */
            var interval = null;
            var check = function () {
                Promise.all([
                    statAsset(rpcRef.current, props.wasmPath),
                    statPackageSetAssets(rpcRef.current, props.packageSetPath),
                ])
                    .then(function (assets) {
                        if (!disposed) {
                            var packageAssets = assets[1];
                            setRevision(
                                JSON.stringify(
                                    [assets[0], ...packageAssets].map(function (asset) {
                                        return asset.revision;
                                    }),
                                ),
                            );
                        }
                    })
                    .catch(function (error) {
                        if (!disposed) setStatus(String(error));
                    });
            };
            check();
            var reloadMs = props.autoReloadMs || 0;
            if (reloadMs > 0) interval = setInterval(check, reloadMs);
            return function () {
                disposed = true;
                if (interval !== null) clearInterval(interval);
            };
        },
        [props.wasmPath, props.packageSetPath, props.autoReloadMs],
    );

    React.useEffect(
        function () {
            if (revision === "") return undefined;
            var disposed = false;
            /** @type {RuntimeService | null} */
            var service = null;
            /** @type {unknown | null} */
            var handle = null;
            setStatus("Loading animation…");
            acquireService(rpcRef.current, props.wasmPath, props.packageSetPath)
                .then(function (loaded) {
                    if (disposed) {
                        releaseService(loaded);
                        return;
                    }
                    service = loaded;
                    handle = loaded.runtime.call(
                        "Illuminate.Animation.Vir.mountInfoView",
                        "#" + mountId,
                        animationKey,
                    );
                    setStatus("");
                })
                .catch(function (error) {
                    if (!disposed) setStatus(String(error));
                });
            return function () {
                disposed = true;
                if (service !== null) {
                    if (handle !== null) {
                        service.runtime.call("Illuminate.Animation.Vir.disposePlayer", handle);
                    }
                    releaseService(service);
                }
            };
        },
        [revision, animationKey, props.wasmPath, props.packageSetPath, mountId],
    );

    return e(
        "section",
        {
            style: { minWidth: 0 },
            "data-illuminate-vir-state": status === "" ? "ready" : "loading",
            onClick: function (/** @type {React.SyntheticEvent} */ event) {
                event.stopPropagation();
            },
            onContextMenu: function (/** @type {React.SyntheticEvent} */ event) {
                event.stopPropagation();
            },
        },
        e("div", { id: mountId }),
        status === "" ? null : e("pre", { style: { margin: 0, whiteSpace: "pre-wrap" } }, status),
    );
}
