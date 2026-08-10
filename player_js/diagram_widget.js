// @ts-check
import * as React from "react";
import { useRpcSession } from "@leanprover/infoview";
import { createVirHitSceneController } from "./vir_hit_scene.js";
import {
    acquireVirRuntimeService,
    releaseVirRuntimeService,
    statVirRuntimeRevision,
} from "./vir_infoview_runtime.js";
const e = React.createElement;

/**
 * @typedef {{ kind: 'slider', name: string, min: number, max: number, initial: number }} SliderParam
 * @typedef {{ kind: 'textInput', name: string, initial: string }} TextInputParam
 * @typedef {{ kind: 'checkbox', name: string, initial: boolean }} CheckboxParam
 * @typedef {SliderParam | TextInputParam | CheckboxParam} GadgetParam
 * @typedef {{
 *   exprId: number,
 *   initialSvg: string,
 *   initialHitScene: string,
 *   parameters: GadgetParam[],
 *   wasmPath: string,
 *   packageSetPath: string,
 *   autoReloadMs?: number
 * }} DiagramProps
 * @typedef {{ kind: string, value?: number, label?: string }} HitInfo
 * @typedef {(number | string | boolean)} ParamValue
 * @typedef {"rpc" | "vir"} HitBackend
 */

/**
 * Renders a single gadget control (slider, text input, or checkbox).
 * @param {GadgetParam} p
 * @param {number} i
 * @param {ParamValue[]} values
 * @param {(v: ParamValue[]) => void} setValues
 * @returns {React.ReactElement | null}
 */
function renderControl(p, i, values, setValues) {
    var val = values[i];
    if (p.kind === "slider") {
        return e(
            "div",
            { key: i, style: { marginBottom: "6px" } },
            e(
                "label",
                { style: { fontSize: "12px", display: "block", marginBottom: "2px" } },
                p.name + ": " + Number(val).toFixed(2),
            ),
            e("input", {
                type: "range",
                min: p.min,
                max: p.max,
                step: (p.max - p.min) / 200,
                value: /** @type {number} */ (val),
                style: { width: "100%" },
                onInput: /** @param {React.FormEvent<HTMLInputElement>} ev */ function (ev) {
                    var v = values.slice();
                    v[i] = parseFloat(/** @type {HTMLInputElement} */ (ev.target).value);
                    setValues(v);
                },
            }),
        );
    } else if (p.kind === "textInput") {
        return e(
            "div",
            { key: i, style: { marginBottom: "6px" } },
            e(
                "label",
                { style: { fontSize: "12px", display: "block", marginBottom: "2px" } },
                p.name + ":",
            ),
            e("input", {
                type: "text",
                value: /** @type {string} */ (val),
                style: { width: "100%", fontSize: "12px", padding: "2px 4px" },
                onInput: /** @param {React.FormEvent<HTMLInputElement>} ev */ function (ev) {
                    var v = values.slice();
                    v[i] = /** @type {HTMLInputElement} */ (ev.target).value;
                    setValues(v);
                },
            }),
        );
    } else if (p.kind === "checkbox") {
        return e(
            "div",
            { key: i, style: { marginBottom: "6px" } },
            e(
                "label",
                { style: { fontSize: "12px", cursor: "pointer" } },
                e("input", {
                    type: "checkbox",
                    checked: !!val,
                    onChange: /** @param {React.ChangeEvent<HTMLInputElement>} ev */ function (ev) {
                        var v = values.slice();
                        v[i] = ev.target.checked;
                        setValues(v);
                    },
                    style: { marginRight: "4px" },
                }),
                p.name,
            ),
        );
    }
    return null;
}

/**
 * Diagram widget component for the Lean infoview.
 * @param {DiagramProps} props
 * @returns {React.ReactElement}
 */
export default function (props) {
    var rs = useRpcSession();
    var rpcRef = React.useRef(rs);
    var params = props.parameters || [];
    var hasParams = params.length > 0;
    /** @type {ParamValue[]} */
    var initials = React.useMemo(function () {
        return params.map(function (p) {
            return p.initial;
        });
    }, []);
    var _vals = React.useState(initials);
    var values = _vals[0];
    var setValues = _vals[1];
    var _svg = React.useState(props.initialSvg || "");
    var svg = _svg[0];
    var setSvg = _svg[1];
    var latestHitScene = React.useRef(props.initialHitScene || "");
    /** @type {React.MutableRefObject<ReturnType<typeof createVirHitSceneController> | null>} */
    var virControllerRef = React.useRef(null);
    var _backend = React.useState(/** @type {HitBackend} */ ("vir"));
    var backend = _backend[0];
    var setBackend = _backend[1];
    var backendRef = React.useRef(backend);
    var _virStatus = React.useState("loading");
    var virStatus = _virStatus[0];
    var setVirStatus = _virStatus[1];
    var _revision = React.useState("");
    var revision = _revision[0];
    var setRevision = _revision[1];

    React.useEffect(
        function () {
            rpcRef.current = rs;
        },
        [rs],
    );

    React.useEffect(
        function () {
            backendRef.current = backend;
        },
        [backend],
    );

    // Reset SVG when switching to a different diagram
    React.useEffect(
        function () {
            setSvg(props.initialSvg || "");
            latestHitScene.current = props.initialHitScene || "";
            try {
                virControllerRef.current?.replace(latestHitScene.current);
            } catch (error) {
                setVirStatus(error instanceof Error ? error.message : String(error));
                backendRef.current = "rpc";
                setBackend("rpc");
            }
        },
        [props.exprId],
    );
    /** @type {React.MutableRefObject<ReturnType<typeof setTimeout> | null>} */
    var timer = React.useRef(null);
    var latestValues = React.useRef(initials);
    /** @type {React.MutableRefObject<HTMLDivElement | null>} */
    var svgRef = React.useRef(null);
    var _hitInfo = React.useState(/** @type {HitInfo | null} */ (null));
    var hitInfo = _hitInfo[0];
    var setHitInfo = _hitInfo[1];
    /** @type {React.MutableRefObject<ReturnType<typeof setTimeout> | null>} */
    var hitTimer = React.useRef(null);

    // Track container pixel width for scale-invariant stroke resolution
    var _pw = React.useState(0);
    var pixelWidth = _pw[0];
    var setPixelWidth = _pw[1];
    var latestPixelWidth = React.useRef(0);

    // Watch staged VIR assets only while VIR is requested. Missing assets fall back to RPC.
    React.useEffect(
        function () {
            if (backend !== "vir") return undefined;
            var disposed = false;
            /** @type {ReturnType<typeof setInterval> | null} */
            var interval = null;
            setVirStatus("loading");
            var check = function () {
                statVirRuntimeRevision(rpcRef.current, props.wasmPath, props.packageSetPath)
                    .then(function (nextRevision) {
                        if (!disposed) setRevision(nextRevision);
                    })
                    .catch(function (error) {
                        if (disposed) return;
                        setVirStatus(error instanceof Error ? error.message : String(error));
                        backendRef.current = "rpc";
                        setBackend("rpc");
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
        [backend, props.wasmPath, props.packageSetPath, props.autoReloadMs],
    );

    // Own one retained HitScene controller while the VIR backend is active.
    React.useEffect(
        function () {
            if (backend !== "vir" || revision === "") return undefined;
            var disposed = false;
            /** @type {Awaited<ReturnType<typeof acquireVirRuntimeService>> | null} */
            var service = null;
            /** @type {ReturnType<typeof createVirHitSceneController> | null} */
            var controller = null;
            setVirStatus("loading");
            acquireVirRuntimeService(rpcRef.current, props.wasmPath, props.packageSetPath)
                .then(function (loaded) {
                    if (disposed) {
                        releaseVirRuntimeService(loaded);
                        return;
                    }
                    service = loaded;
                    controller = createVirHitSceneController(loaded.runtime);
                    controller.replace(latestHitScene.current);
                    virControllerRef.current = controller;
                    setVirStatus("ready");
                })
                .catch(function (error) {
                    if (disposed) return;
                    setVirStatus(error instanceof Error ? error.message : String(error));
                    backendRef.current = "rpc";
                    setBackend("rpc");
                });
            return function () {
                disposed = true;
                if (virControllerRef.current === controller) virControllerRef.current = null;
                controller?.dispose();
                if (service !== null) releaseVirRuntimeService(service);
            };
        },
        [backend, revision, props.wasmPath, props.packageSetPath],
    );

    // Measure container width immediately on mount and on subsequent resizes
    React.useEffect(function () {
        var container = svgRef.current;
        if (!container) return;
        var measure = function () {
            var w = /** @type {HTMLDivElement} */ (container).clientWidth;
            if (w > 0 && Math.abs(w - latestPixelWidth.current) > 1) {
                latestPixelWidth.current = w;
                setPixelWidth(w);
            }
        };
        // Fire immediately to avoid flash of unresolved px strokes
        measure();
        if (typeof ResizeObserver === "undefined") return;
        var ro = new ResizeObserver(function () {
            measure();
        });
        ro.observe(container);
        return function () {
            ro.disconnect();
        };
    }, []);

    // Re-evaluate diagram when parameters or pixel width change
    React.useEffect(
        function () {
            if (pixelWidth === 0 && !hasParams) return;
            latestValues.current = values;
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(function () {
                rpcRef.current
                    .call("Illuminate.evalParamDiagram", {
                        id: props.exprId,
                        values: latestValues.current,
                        pixelWidth: latestPixelWidth.current,
                    })
                    .then(function (/** @type {{ svg: string, hitScene: string }} */ resp) {
                        latestHitScene.current = resp.hitScene;
                        if (virControllerRef.current !== null) {
                            try {
                                virControllerRef.current.replace(resp.hitScene);
                            } catch (error) {
                                setVirStatus(
                                    error instanceof Error ? error.message : String(error),
                                );
                                backendRef.current = "rpc";
                                setBackend("rpc");
                            }
                        }
                        setSvg(resp.svg);
                    })
                    .catch(function (/** @type {unknown} */ err) {
                        console.error("RPC error:", err);
                    });
            }, 50);
            return function () {
                if (timer.current) clearTimeout(timer.current);
            };
        },
        [values, pixelWidth],
    );

    // Mouse move handler for hit testing
    var onMouseMove = React.useCallback(
        /** @param {React.MouseEvent} ev */ function (ev) {
            var container = svgRef.current;
            if (!container) return;
            /** @type {SVGSVGElement | null} */
            var svgEl = container.querySelector("svg");
            if (!svgEl) return;
            // Map client coordinates to SVG user space
            var ctm = svgEl.getScreenCTM();
            if (!ctm) return;
            var inv = ctm.inverse();
            var svgX = inv.a * ev.clientX + inv.c * ev.clientY + inv.e;
            var svgY = inv.b * ev.clientX + inv.d * ev.clientY + inv.f;
            // The SVG wraps content in <g transform="scale(1,-1)">,
            // so negate y to get diagram coordinates
            var diagX = svgX;
            var diagY = -svgY;
            if (hitTimer.current) clearTimeout(hitTimer.current);
            hitTimer.current = setTimeout(function () {
                var controller = virControllerRef.current;
                if (backendRef.current === "vir" && controller !== null) {
                    try {
                        setHitInfo(controller.query(diagX, diagY));
                    } catch (error) {
                        setVirStatus(error instanceof Error ? error.message : String(error));
                        backendRef.current = "rpc";
                        setBackend("rpc");
                        setHitInfo(null);
                    }
                    return;
                }
                rpcRef.current
                    .call("Illuminate.hitTestPreparedDiagram", {
                        id: props.exprId,
                        x: diagX,
                        y: diagY,
                    })
                    .then(function (/** @type {HitInfo} */ resp) {
                        setHitInfo(resp);
                    })
                    .catch(function () {
                        setHitInfo(null);
                    });
            }, 30);
        },
        [],
    );

    var onMouseLeave = React.useCallback(function () {
        if (hitTimer.current) clearTimeout(hitTimer.current);
        setHitInfo(null);
    }, []);

    React.useEffect(function () {
        return function () {
            if (hitTimer.current) clearTimeout(hitTimer.current);
        };
    }, []);

    // Format hit info for display
    /** @type {string | null} */
    var hitLabel = null;
    if (hitInfo && hitInfo.kind !== "nothing") {
        if (hitInfo.label) {
            hitLabel = hitInfo.label;
        } else if (hitInfo.kind === "tag") {
            hitLabel = "tag " + hitInfo.value;
        } else {
            hitLabel = hitInfo.kind;
        }
    }

    var controls = hasParams
        ? params.map(function (p, i) {
              return renderControl(p, i, values, setValues);
          })
        : null;

    return e(
        "div",
        { style: { padding: "4px", background: "white", position: "relative" } },
        e(
            "div",
            {
                style: {
                    display: "flex",
                    gap: "8px",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: "6px",
                },
            },
            controls ? e("div", { style: { flex: "1 1 auto" } }, controls) : e("span"),
            e(
                "label",
                { style: { color: "#596275", fontSize: "10px", whiteSpace: "nowrap" } },
                "Hit testing ",
                e(
                    "select",
                    {
                        value: backend,
                        onChange: function (
                            /** @type {React.ChangeEvent<HTMLSelectElement>} */ event,
                        ) {
                            var nextBackend = /** @type {HitBackend} */ (event.target.value);
                            backendRef.current = nextBackend;
                            setBackend(nextBackend);
                        },
                        style: { fontSize: "10px" },
                        title: backend === "vir" ? virStatus : "Lean server RPC",
                    },
                    e(
                        "option",
                        { value: "vir" },
                        virStatus === "ready"
                            ? "VIR (in-browser Lean)"
                            : virStatus === "loading"
                              ? "VIR (loading)"
                              : "VIR (unavailable)",
                    ),
                    e("option", { value: "rpc" }, "Lean server RPC"),
                ),
            ),
        ),
        e("div", {
            ref: svgRef,
            style: { width: "100%" },
            dangerouslySetInnerHTML: { __html: svg },
            onMouseMove: onMouseMove,
            onMouseLeave: onMouseLeave,
        }),
        hitLabel
            ? e(
                  "div",
                  {
                      style: {
                          position: "absolute",
                          bottom: "4px",
                          right: "8px",
                          background: "rgba(0,0,0,0.75)",
                          color: "white",
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "11px",
                          pointerEvents: "none",
                      },
                  },
                  hitLabel,
              )
            : null,
    );
}
