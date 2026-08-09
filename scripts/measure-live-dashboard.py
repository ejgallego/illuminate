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


def measure_backend(page, backend: str, duration_ms: int):
    """Collects one rolling dashboard observation for a candidate backend."""
    page.locator("#comparison-backend").select_option(backend)
    page.locator("#comparison-auto-cycle").check()
    page.click("#comparison-reset")
    page.click("#comparison-start")
    page.wait_for_timeout(duration_ms)
    snapshot = page.evaluate("window.__illuminateComparisonSnapshot?.()")
    assert snapshot is not None, "dashboard did not expose its measurement snapshot"
    assert snapshot["backend"] == backend
    dom_matches = page.locator("[data-dom-match]:not(.mismatch)").count()
    page.click("#comparison-pause")
    return {
        "backend": backend,
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


def summarize_backend(observations, backend: str):
    """Takes medians of per-run row means for one candidate backend."""
    selected = [
        observation
        for observation in observations
        if observation["backend"] == backend
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
    return {
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


def main():
    """Runs the browser benchmark and writes its structured report."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-ms", type=int, default=5000)
    parser.add_argument("--runs", type=int, default=3)
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
                    order = ["vir-selection", "vir-full"]
                for backend in order:
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
                        page.locator("#comparison-vir-timing").check()
                        fir_available = not page.locator(
                            '#comparison-backend option[value="fir"]'
                        ).is_disabled()
                        if not args.allow_vir_only:
                            assert fir_available, (
                                "staged FIR package was rejected by the dashboard loader"
                            )
                        if backend == "fir" and not fir_available:
                            continue
                        observation = measure_backend(page, backend, args.duration_ms)
                        observation["round"] = round_index
                        observation["order"] = order
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
    summaries = {
        backend: summary
        for backend in ("vir-selection", "vir-full", "fir")
        if (summary := summarize_backend(observations, backend)) is not None
    }
    report = {
        "schema": "illuminate.live-dashboard-phases/v3",
        "generatedAtUnix": time(),
        "scope": {
            "domIncluded": True,
            "paintAndCompositingIncluded": False,
            "timestampPolicy": "independent browser requestAnimationFrame callbacks",
            "rollingWindowMs": 2000,
            "sharedSelectionRenderer": ["js", "vir-selection", "fir"],
            "fullVirOwnsPatchRendering": True,
            "sharedJsFirRenderer": True,
            "jsInput": "original JavaScript AnimData object without conversion",
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
            "freshBrowserContextPerObservation": True,
            "balancedBackendOrder": True,
            "phaseVisualizationSuppressed": True,
        },
        "observations": observations,
        "summaries": summaries,
    }
    report_path = OUTPUT / "perf" / "live-dashboard-phases.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    for backend, summary in summaries.items():
        print(
            f"{backend.upper()}: {summary['minimumDomMatches']}/{summary['rowCount']} "
            f"DOM matches, median JS {summary['jsCallbackMeanMs']:.3f} ms, "
            f"candidate {summary['candidateCallbackMeanMs']:.3f} ms, "
            f"paired median {summary['pairedCallbackRatio']['median']:.2f}x JS "
            f"({summary['pairedCallbackOverheadMs']['median'] * 1000:+.1f} us)"
        )
    print(f"wrote {report_path}")


if __name__ == "__main__":
    main()
