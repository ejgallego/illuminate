// @ts-check
import * as React from "react";
import { useRpcSession } from "@leanprover/infoview";
import { createSelectionDomRenderer } from "./fir_live_player.js";
import {
    acquireVirRuntimeService,
    releaseVirRuntimeService,
    statVirRuntimeRevision,
} from "./vir_infoview_runtime.js";
import { createVirSelectionPlayerHost } from "./vir_selection_player.js";

const e = React.createElement;

/**
 * @typedef {{ animData: AnimData, wasmPath: string, packageSetPath: string, autoReloadMs?: number }} AnimateVirProps
 * @typedef {"paused" | "playing" | "waiting" | "looping" | "finishingLoop" | "finished"} AnimatePlayback
 * @typedef {{
 *   frame: number,
 *   step: number,
 *   segment: number,
 *   localFrame: number,
 *   segmentChanged: boolean,
 *   playback: AnimatePlayback
 * }} AnimateSelection
 */

/** @param {AnimatePlayback} playback */
function isActive(playback) {
    return playback === "playing" || playback === "looping" || playback === "finishingLoop";
}

/**
 * VIR-backed selection-only animation player for the Lean InfoView.
 *
 * The browser keeps the original SVG and patch tables. Lean retains only the compact
 * timeline and playback state, and returns the selected segment/local frame.
 *
 * @param {AnimateVirProps} props
 * @returns {React.ReactElement}
 */
export default function AnimateVirWidget(props) {
    var rpc = useRpcSession();
    var rpcRef = React.useRef(rpc);
    /** @type {React.MutableRefObject<HTMLDivElement | null>} */
    var containerRef = React.useRef(null);
    /** @type {React.MutableRefObject<ReturnType<typeof createVirSelectionPlayerHost> | null>} */
    var playerRef = React.useRef(null);
    /** @type {React.MutableRefObject<AnimatePlayback>} */
    var playbackRef = React.useRef("paused");
    var _revision = React.useState("");
    var revision = _revision[0];
    var setRevision = _revision[1];
    var _status = React.useState("Loading animation…");
    var status = _status[0];
    var setStatus = _status[1];
    var _frame = React.useState(0);
    var frame = _frame[0];
    var setFrame = _frame[1];
    var _playback = React.useState(/** @type {AnimatePlayback} */ ("paused"));
    var playback = _playback[0];
    var setPlayback = _playback[1];

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
                statVirRuntimeRevision(rpcRef.current, props.wasmPath, props.packageSetPath)
                    .then(function (nextRevision) {
                        if (!disposed) setRevision(nextRevision);
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
            const container = containerRef.current;
            if (revision === "" || container === null) return undefined;
            var disposed = false;
            /** @type {Awaited<ReturnType<typeof acquireVirRuntimeService>> | null} */
            var service = null;
            /** @type {ReturnType<typeof createVirSelectionPlayerHost> | null} */
            var player = null;
            setStatus("Loading animation…");
            acquireVirRuntimeService(rpcRef.current, props.wasmPath, props.packageSetPath)
                .then(function (loaded) {
                    if (disposed) {
                        releaseVirRuntimeService(loaded);
                        return;
                    }
                    service = loaded;
                    var domRenderer = createSelectionDomRenderer(props.animData, container);
                    player = createVirSelectionPlayerHost(loaded.runtime, props.animData, {
                        render(selection) {
                            domRenderer.render(selection);
                            if (disposed) return;
                            var current = /** @type {AnimateSelection} */ (selection);
                            playbackRef.current = current.playback;
                            setFrame(current.frame);
                            setPlayback(current.playback);
                        },
                        dispose() {
                            domRenderer.dispose?.();
                        },
                    });
                    playerRef.current = player;
                    setStatus("");
                })
                .catch(function (error) {
                    if (service !== null) {
                        releaseVirRuntimeService(service);
                        service = null;
                    }
                    if (!disposed) setStatus(String(error));
                });
            return function () {
                disposed = true;
                if (playerRef.current === player) playerRef.current = null;
                player?.dispose();
                if (service !== null) releaseVirRuntimeService(service);
            };
        },
        [revision, props.animData, props.wasmPath, props.packageSetPath],
    );

    var maxFrame = Math.max(0, props.animData.totalFrames - 1);
    var active = isActive(playback);
    var ready = status === "";

    return e(
        "section",
        {
            style: { minWidth: 0 },
            "data-illuminate-vir-state": ready ? "ready" : "loading",
            "data-illuminate-player-boundary": "selection",
            onClick: function (/** @type {React.SyntheticEvent} */ event) {
                event.stopPropagation();
            },
            onContextMenu: function (/** @type {React.SyntheticEvent} */ event) {
                event.stopPropagation();
            },
        },
        e(
            "div",
            { style: { padding: "4px", background: "white" } },
            e("div", {
                ref: containerRef,
                style: { width: "100%", cursor: "pointer" },
                onClick: function () {
                    if (playbackRef.current === "waiting") playerRef.current?.advance();
                },
            }),
            e(
                "div",
                {
                    style: {
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        marginTop: "6px",
                    },
                },
                e(
                    "button",
                    {
                        disabled: !ready,
                        onClick: function () {
                            playerRef.current?.advance();
                        },
                        style: {
                            fontSize: "14px",
                            width: "28px",
                            height: "28px",
                            border: "1px solid #ccc",
                            borderRadius: "4px",
                            background: "white",
                            cursor: ready ? "pointer" : "wait",
                        },
                        "aria-label": active ? "Pause" : "Play",
                    },
                    active ? "⏸" : "▶",
                ),
                e("input", {
                    type: "range",
                    min: 0,
                    max: maxFrame,
                    value: Math.min(frame, maxFrame),
                    disabled: !ready,
                    "aria-label": "Animation progress",
                    style: { flex: 1 },
                    onInput: /** @param {React.FormEvent<HTMLInputElement>} event */ function (
                        event,
                    ) {
                        var requested = Number.parseInt(event.currentTarget.value, 10);
                        if (Number.isSafeInteger(requested) && requested >= 0) {
                            playerRef.current?.seek(requested);
                        }
                    },
                }),
                e(
                    "span",
                    {
                        style: {
                            fontSize: "11px",
                            color: "#666",
                            minWidth: "5.5em",
                            textAlign: "right",
                        },
                    },
                    String(frame) + " / " + String(maxFrame),
                ),
            ),
        ),
        ready ? null : e("pre", { style: { margin: "4px", whiteSpace: "pre-wrap" } }, status),
    );
}
