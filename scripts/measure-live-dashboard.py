# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Measures the DOM-inclusive Illuminate JavaScript/VIR/FIR comparison dashboard."""

import argparse
import json
import platform
import shutil
import statistics
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from time import time

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "test_output"
HOST_PROFILER_OFF = "host-profiler-off"
HOST_PROFILER_ON = "host-profiler-on"
HOST_PROFILER_MODES = (HOST_PROFILER_OFF, HOST_PROFILER_ON)


class QuietHandler(SimpleHTTPRequestHandler):
    """Serves benchmark assets without request logging."""

    def log_message(self, format, *args):
        pass


def chromium_options():
    """Uses a system Chromium when available."""
    for executable in (
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
    ):
        path = shutil.which(executable)
        if path is not None:
            return {"executable_path": path}
    return {}


def measure_backend(page, backend: str, timing_mode: str, duration_ms: int):
    """Collects one rolling dashboard observation for a backend and timing mode."""
    assert timing_mode in HOST_PROFILER_MODES
    page.locator("#comparison-backend").select_option(backend)
    page.click("#comparison-pause")
    page.locator("#comparison-vir-timing").set_checked(
        timing_mode == HOST_PROFILER_ON
    )
    page.click("#comparison-reset")
    reset_metrics = page.evaluate(
        """() => {
            if (typeof window.__illuminateComparisonResetMetrics !== 'function')
                return false;
            window.__illuminateComparisonResetMetrics();
            return true;
        }"""
    )
    assert reset_metrics is True
    page.locator("#comparison-auto-cycle").check()
    page.click("#comparison-start")
    page.wait_for_timeout(duration_ms)
    snapshot = page.evaluate("window.__illuminateComparisonSnapshot?.()")
    assert snapshot is not None, "dashboard did not expose its measurement snapshot"
    assert snapshot["backend"] == backend
    assert snapshot["timingEnabled"] is (timing_mode == HOST_PROFILER_ON)
    phase_counts = [
        row[result_field]["samples"]
        for row in snapshot["rows"]
        for result_field in ("jsPhases", "phases")
    ]
    if timing_mode == HOST_PROFILER_ON:
        assert all(count > 0 for count in phase_counts), (
            "profiled observation did not collect every phase lane"
        )
    else:
        assert all(count == 0 for count in phase_counts), (
            "unprofiled observation unexpectedly collected phase samples"
        )
    dom_matches = page.locator("[data-dom-match]:not(.mismatch)").count()
    page.click("#comparison-pause")
    return {
        "backend": backend,
        "timingMode": timing_mode,
        "durationMs": duration_ms,
        "domMatches": dom_matches,
        "rowCount": page.locator(".example").count(),
        "snapshot": snapshot,
    }


def mean_row_field(observation, result_field: str, value_field: str):
    """Averages one callback or phase field across active dashboard rows."""
    values = [
        row[result_field][value_field]
        for row in observation["snapshot"]["rows"]
        if row[result_field] is not None
    ]
    return statistics.mean(values)


def maximum_row_field(observation, result_field: str, value_field: str):
    """Finds one persistent high-water value across dashboard rows."""
    values = [
        row[result_field][value_field]
        for row in observation["snapshot"]["rows"]
        if row[result_field] is not None
    ]
    return max(values)


def summarize_backend(observations, backend: str, timing_mode: str):
    """Takes medians of per-run row means for one backend and timing mode."""
    selected = [
        observation
        for observation in observations
        if observation["backend"] == backend
        and observation["timingMode"] == timing_mode
    ]
    if not selected:
        return None
    phase_fields = (
        "marshalMs",
        "executeMs",
        "decodeMs",
        "rewindMs",
        "hostMs",
        "totalMs",
        "adapterMs",
    )
    js_callback_mean = statistics.median(
        mean_row_field(observation, "jsCallback", "mean")
        for observation in selected
    )
    candidate_callback_mean = statistics.median(
        mean_row_field(observation, "callback", "mean")
        for observation in selected
    )
    paired_ratios = [
        mean_row_field(observation, "callback", "mean")
        / mean_row_field(observation, "jsCallback", "mean")
        for observation in selected
    ]
    paired_deltas = [
        mean_row_field(observation, "callback", "mean")
        - mean_row_field(observation, "jsCallback", "mean")
        for observation in selected
    ]
    js_callback_means = [
        mean_row_field(observation, "jsCallback", "mean")
        for observation in selected
    ]
    candidate_callback_means = [
        mean_row_field(observation, "callback", "mean")
        for observation in selected
    ]
    js_callback_peaks = [
        maximum_row_field(observation, "jsCallback", "maximum")
        for observation in selected
    ]
    candidate_callback_peaks = [
        maximum_row_field(observation, "callback", "maximum")
        for observation in selected
    ]
    high_water_ratios = [
        candidate / js
        for js, candidate in zip(js_callback_peaks, candidate_callback_peaks)
        if js > 0
    ]
    return {
        "timingMode": timing_mode,
        "phaseDataAvailable": timing_mode == HOST_PROFILER_ON,
        "runs": len(selected),
        "minimumDomMatches": min(observation["domMatches"] for observation in selected),
        "rowCount": selected[0]["rowCount"],
        "jsCallbackMeanMs": js_callback_mean,
        "candidateCallbackMeanMs": candidate_callback_mean,
        "callbackOverheadRatio": candidate_callback_mean / js_callback_mean,
        "callbackOverheadMs": candidate_callback_mean - js_callback_mean,
        "pairedCallbackRatio": {
            "median": statistics.median(paired_ratios),
            "minimum": min(paired_ratios),
            "maximum": max(paired_ratios),
        },
        "pairedCallbackOverheadMs": {
            "median": statistics.median(paired_deltas),
            "minimum": min(paired_deltas),
            "maximum": max(paired_deltas),
        },
        "absoluteCallbackRangeMs": {
            "js": {"minimum": min(js_callback_means), "maximum": max(js_callback_means)},
            "candidate": {
                "minimum": min(candidate_callback_means),
                "maximum": max(candidate_callback_means),
            },
        },
        "persistentCallbackPeakMs": {
            "js": {
                "median": statistics.median(js_callback_peaks),
                "minimum": min(js_callback_peaks),
                "maximum": max(js_callback_peaks),
            },
            "candidate": {
                "median": statistics.median(candidate_callback_peaks),
                "minimum": min(candidate_callback_peaks),
                "maximum": max(candidate_callback_peaks),
            },
            "highWaterRatio": {
                "median": statistics.median(high_water_ratios),
                "minimum": min(high_water_ratios),
                "maximum": max(high_water_ratios),
            },
        },
        "jsPhases": {
            field: statistics.median(
                mean_row_field(observation, "jsPhases", field)
                for observation in selected
            )
            for field in phase_fields
        },
        "candidatePhases": {
            field: statistics.median(
                mean_row_field(observation, "phases", field)
                for observation in selected
            )
            for field in phase_fields
        },
        "candidatePhaseShareOfCallback": {
            field: statistics.median(
                mean_row_field(observation, "phases", field)
                / mean_row_field(observation, "callback", "mean")
                for observation in selected
            )
            for field in phase_fields
        },
    }


def effect_distribution(values):
    """Summarizes one per-round observer-effect distribution."""
    return {
        "median": statistics.median(values),
        "minimum": min(values),
        "maximum": max(values),
    }


def summarize_host_profiler_effect(observations, backend: str):
    """Pairs profiling-off and profiling-on observations by benchmark round."""
    by_round = {}
    for observation in observations:
        if observation["backend"] != backend:
            continue
        by_round.setdefault(observation["round"], {})[
            observation["timingMode"]
        ] = observation
    pairs = [
        (modes[HOST_PROFILER_OFF], modes[HOST_PROFILER_ON])
        for modes in by_round.values()
        if HOST_PROFILER_OFF in modes and HOST_PROFILER_ON in modes
    ]
    if not pairs:
        return None

    def engine_effect(result_field: str):
        off_values = [
            mean_row_field(off, result_field, "mean") for off, _on in pairs
        ]
        on_values = [
            mean_row_field(on, result_field, "mean") for _off, on in pairs
        ]
        ratios = [on / off for off, on in zip(off_values, on_values) if off > 0]
        deltas = [on - off for off, on in zip(off_values, on_values)]
        return {
            "profilingOffCallbackMs": effect_distribution(off_values),
            "profilingOnCallbackMs": effect_distribution(on_values),
            "profilingOnToOffRatio": effect_distribution(ratios),
            "profilingOverheadMs": effect_distribution(deltas),
        }

    return {
        "pairedRounds": len(pairs),
        "javascript": engine_effect("jsCallback"),
        "candidate": engine_effect("callback"),
    }


def main():
    """Runs the browser benchmark and writes its structured report."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-ms", type=int, default=5000)
    parser.add_argument("--runs", type=int, default=4)
    parser.add_argument("--allow-vir-only", action="store_true")
    args = parser.parse_args()
    assert args.duration_ms >= 2000, "duration must cover the dashboard's rolling window"
    assert args.runs > 0, "runs must be positive"

    html = OUTPUT / "anim-comparison.html"
    assert html.exists(), "run lake test --wfail to generate anim-comparison.html"
    fir_build = OUTPUT / "fir-live" / "BUILD.json"
    if not args.allow_vir_only:
        assert fir_build.exists(), "run npm run stage:fir-live before the dashboard benchmark"

    handler = partial(QuietHandler, directory=str(OUTPUT))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    errors = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, **chromium_options())
            observations = []
            url = f"http://127.0.0.1:{server.server_address[1]}/{html.name}"
            for round_index in range(args.runs):
                order = (
                    ["vir-selection", "vir-full", "fir"]
                    if round_index % 2 == 0
                    else ["fir", "vir-full", "vir-selection"]
                )
                if args.allow_vir_only and not fir_build.exists():
                    order = (
                        ["vir-selection", "vir-full"]
                        if round_index % 2 == 0
                        else ["vir-full", "vir-selection"]
                    )
                for backend_index, backend in enumerate(order):
                    timing_order = list(HOST_PROFILER_MODES)
                    if (round_index + backend_index) % 2 == 1:
                        timing_order.reverse()
                    context = browser.new_context()
                    try:
                        page = context.new_page()
                        page.on(
                            "pageerror",
                            lambda error: errors.append(
                                getattr(error, "stack", None) or str(error)
                            ),
                        )
                        page.goto(url)
                        page.wait_for_function(
                            "document.body.dataset.ready === 'true'", timeout=60_000
                        )
                        page.evaluate(
                            "document.body.dataset.suppressPhaseCharts = 'true'"
                        )
                        fir_available = not page.locator(
                            '#comparison-backend option[value="fir"]'
                        ).is_disabled()
                        if not args.allow_vir_only:
                            assert fir_available, (
                                "staged FIR package was rejected by the dashboard loader"
                            )
                        if backend == "fir" and not fir_available:
                            continue
                        for timing_mode in timing_order:
                            observation = measure_backend(
                                page, backend, timing_mode, args.duration_ms
                            )
                            observation["round"] = round_index
                            observation["backendOrder"] = order
                            observation["timingModeOrder"] = timing_order
                            observations.append(observation)
                    finally:
                        context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert errors == [], f"dashboard page errors: {errors}"
    build = json.loads(fir_build.read_text()) if fir_build.exists() else None
    summaries = {}
    for backend in ("vir-selection", "vir-full", "fir"):
        mode_summaries = {
            timing_mode: summary
            for timing_mode in HOST_PROFILER_MODES
            if (
                summary := summarize_backend(observations, backend, timing_mode)
            )
            is not None
        }
        if mode_summaries:
            profiler_effect = summarize_host_profiler_effect(observations, backend)
            assert profiler_effect is not None
            assert profiler_effect["pairedRounds"] == args.runs
            summaries[backend] = {
                "modes": mode_summaries,
                "hostProfilerEffect": profiler_effect,
            }
    report = {
        "schema": "illuminate.live-dashboard-phases/v5",
        "generatedAtUnix": time(),
        "scope": {
            "domIncluded": True,
            "paintAndCompositingIncluded": False,
            "timestampPolicy": "independent browser requestAnimationFrame callbacks",
            "rollingWindowMs": 2000,
            "persistentCallbackPeaks": "per backend run; reset on backend change or explicit clear",
            "callbackOrder": "JS first and candidate first balanced across rows, reversed on each reschedule",
            "sharedSelectionRenderer": ["js", "vir-selection", "fir"],
            "fullVirOwnsPatchRendering": True,
            "sharedJsFirRenderer": True,
            "jsInput": "original JavaScript AnimData object without conversion",
            "hostProfilerModes": {
                HOST_PROFILER_OFF: "detailed dashboard phase observer disabled",
                HOST_PROFILER_ON: "detailed dashboard phase observer enabled; phase charts suppressed",
            },
            "firAdapterInternalTiming": "v4 remains enabled in both modes; host-profiler-off is not yet a timing-free FIR production path",
            "hostProfilerEffectInterpretation": "diagnostic only; a ratio range spanning 1 or delta range spanning zero does not resolve observer cost",
        },
        "identity": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "firCommit": build.get("sources", {}).get("fir", {}).get("commit")
            if build
            else None,
            "firWasmSha256": build.get("wasm", {}).get("sha256") if build else None,
            "adapterApi": build.get("capabilities", {})
            .get("browserAdapter", {})
            .get("apiVersion")
            if build
            else None,
        },
        "policy": {
            "durationMs": args.duration_ms,
            "runs": args.runs,
            "freshBrowserContextPerBackendRound": True,
            "sharedContextWithinHostProfilerPair": True,
            "balancedBackendOrder": True,
            "balancedHostProfilerOrder": True,
            "phaseVisualizationSuppressed": True,
        },
        "observations": observations,
        "summaries": summaries,
    }
    report_path = OUTPUT / "perf" / "live-dashboard-phases.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    for backend, backend_summary in summaries.items():
        for timing_mode, summary in backend_summary["modes"].items():
            print(
                f"{backend.upper()} {timing_mode}: "
                f"{summary['minimumDomMatches']}/{summary['rowCount']} DOM matches, "
                f"median JS {summary['jsCallbackMeanMs']:.3f} ms, "
                f"candidate {summary['candidateCallbackMeanMs']:.3f} ms, "
                f"paired median {summary['pairedCallbackRatio']['median']:.2f}x JS "
                f"({summary['pairedCallbackOverheadMs']['median'] * 1000:+.1f} us), "
                f"peak {summary['persistentCallbackPeakMs']['candidate']['median']:.3f} ms"
            )
        effect = backend_summary["hostProfilerEffect"]
        if effect is not None:
            js_effect = effect["javascript"]
            candidate_effect = effect["candidate"]
            print(
                f"{backend.upper()} host-profiler effect: JS "
                f"{js_effect['profilingOnToOffRatio']['median']:.2f}x "
                f"({js_effect['profilingOverheadMs']['median'] * 1000:+.1f} us), "
                f"candidate {candidate_effect['profilingOnToOffRatio']['median']:.2f}x "
                f"({candidate_effect['profilingOverheadMs']['median'] * 1000:+.1f} us)"
            )
    print(f"wrote {report_path}")


if __name__ == "__main__":
    main()
