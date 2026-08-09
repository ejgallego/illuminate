# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Measures the DOM-inclusive Illuminate JavaScript/VIR/FIR comparison dashboard."""

import argparse
import json
import platform
import shutil
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


def main():
    """Runs the browser benchmark and writes its structured report."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--duration-ms", type=int, default=5000)
    parser.add_argument("--allow-vir-only", action="store_true")
    args = parser.parse_args()
    assert args.duration_ms >= 2000, "duration must cover the dashboard's rolling window"

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
            page = browser.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(f"http://127.0.0.1:{server.server_address[1]}/{html.name}")
            page.wait_for_function("document.body.dataset.ready === 'true'", timeout=60_000)
            page.locator("#comparison-vir-timing").check()
            fir_available = not page.locator(
                '#comparison-backend option[value="fir"]'
            ).is_disabled()
            if not args.allow_vir_only:
                assert fir_available, "staged FIR package was rejected by the dashboard loader"

            observations = [measure_backend(page, "vir", args.duration_ms)]
            if fir_available:
                observations.append(measure_backend(page, "fir", args.duration_ms))
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    assert errors == [], f"dashboard page errors: {errors}"
    build = json.loads(fir_build.read_text()) if fir_build.exists() else None
    report = {
        "schema": "illuminate.live-dashboard-phases/v1",
        "generatedAtUnix": time(),
        "scope": {
            "domIncluded": True,
            "paintAndCompositingIncluded": False,
            "timestampPolicy": "independent browser requestAnimationFrame callbacks",
            "rollingWindowMs": 2000,
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
        "policy": {"durationMs": args.duration_ms},
        "observations": observations,
    }
    report_path = OUTPUT / "perf" / "live-dashboard-phases.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    for observation in observations:
        means = [
            row["callback"]["mean"]
            for row in observation["snapshot"]["rows"]
            if row["callback"] is not None
        ]
        mean = sum(means) / len(means) if means else 0
        print(
            f"{observation['backend'].upper()}: {observation['domMatches']}/"
            f"{observation['rowCount']} DOM matches, mean callback {mean:.3f} ms"
        )
    print(f"wrote {report_path}")


if __name__ == "__main__":
    main()
