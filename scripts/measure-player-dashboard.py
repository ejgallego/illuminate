# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright"]
# ///
"""Measures one isolated JavaScript/VIR animation pair in the comparison dashboard."""

import argparse
import hashlib
import json
import platform
import shutil
import statistics
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PHASES = ("marshal", "execute", "host", "decode", "total", "adapter")


def sha256(path):
    """Computes one artifact SHA-256."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def git_identity(path):
    """Records the checked-out revision and whether local changes are present."""
    revision = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=path, text=True
    ).strip()
    dirty = bool(
        subprocess.check_output(
            ["git", "status", "--porcelain"], cwd=path, text=True
        ).strip()
    )
    return {"revision": revision, "dirty": dirty}


def chromium_options():
    """Uses a system Chromium when one is available."""
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


def metric(page, row, engine, statistic):
    """Reads one numeric metric from a comparison row."""
    selector = (
        f'[data-example="{row}"] [data-engine="{engine}"] '
        f'[data-stat="{statistic}"]'
    )
    text = page.locator(selector).inner_text().strip().rstrip("%")
    return float(text.split()[0])


def phase_metric(page, row, phase):
    """Reads one VIR retained-callback phase mean from a comparison row."""
    selector = f'[data-example="{row}"] [data-phase="{phase}"]'
    return float(page.locator(selector).inner_text().split()[0])


def measure(page, url, row, warmup_ms, sample_ms, vir_timing):
    """Measures one fresh dashboard load after isolating a single row."""
    page.goto(url)
    page.wait_for_function("document.body.dataset.ready === 'true'", timeout=60_000)
    page.locator("#comparison-vir-timing").set_checked(vir_timing)
    page.click("#comparison-pause")
    page.click("#comparison-reset")
    page.wait_for_timeout(warmup_ms)
    page.click(f'[data-example="{row}"] [data-action="advance"]')
    page.wait_for_timeout(sample_ms)
    result = {
        engine: {
            statistic: metric(page, row, engine, statistic)
            for statistic in ("fps", "cpu", "mean", "p95", "max", "long")
        }
        for engine in ("js", "vir")
    }
    result["vir"]["phases"] = {
        phase: phase_metric(page, row, phase)
        for phase in PHASES
    }
    return result


def summarize(results):
    """Summarizes one timing mode without discarding raw observations."""
    medians = {
        engine: {
            statistic: statistics.median(
                result[engine][statistic] for result in results
            )
            for statistic in ("fps", "cpu", "mean", "p95", "max", "long")
        }
        for engine in ("js", "vir")
    }
    medians["vir"]["phases"] = {
        phase: statistics.median(result["vir"]["phases"][phase] for result in results)
        for phase in PHASES
    }
    return medians


def paired_delta(observations, engine, statistic):
    """Computes timing-on deltas against timing-off within each balanced round."""
    samples = []
    for observation in observations:
        disabled = observation["measurements"]["off"][engine][statistic]
        enabled = observation["measurements"]["on"][engine][statistic]
        samples.append(0 if disabled == 0 else ((enabled - disabled) / disabled) * 100)
    return {
        "medianPercent": statistics.median(samples),
        "samplesPercent": samples,
    }


def main():
    """Runs repeated isolated measurements and prints individual and median results."""
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--url",
        default="http://127.0.0.1:8765/anim-comparison.html",
    )
    parser.add_argument("--row", type=int, default=13)
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--warmup-ms", type=int, default=2500)
    parser.add_argument("--sample-ms", type=int, default=5500)
    parser.add_argument("--vir-timing", choices=("on", "off", "both"), default="on")
    parser.add_argument("--json", type=Path)
    args = parser.parse_args()

    modes = ["on", "off"] if args.vir_timing == "both" else [args.vir_timing]
    results = {mode: [] for mode in modes}
    observations = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, **chromium_options())
        browser_version = browser.version
        try:
            for round_index in range(args.runs):
                order = modes if round_index % 2 == 0 else list(reversed(modes))
                observation = {
                    "round": round_index,
                    "order": order,
                    "measurements": {},
                }
                for mode in order:
                    context = browser.new_context()
                    try:
                        result = measure(
                            context.new_page(),
                            args.url,
                            args.row,
                            args.warmup_ms,
                            args.sample_ms,
                            mode == "on",
                        )
                        results[mode].append(result)
                        observation["measurements"][mode] = result
                    finally:
                        context.close()
                observations.append(observation)
        finally:
            browser.close()

    summaries = {mode: summarize(results[mode]) for mode in modes}
    paired = None
    if args.vir_timing == "both":
        paired = {
            "virMean": paired_delta(observations, "vir", "mean"),
            "virP95": paired_delta(observations, "vir", "p95"),
            "virCpu": paired_delta(observations, "vir", "cpu"),
            "jsMeanControl": paired_delta(observations, "js", "mean"),
        }
    wasm = ROOT / "test_output/vir/sdk/wasm/vir-upstream.wasm"
    package = ROOT / "test_output/vir/module-sets/Illuminate/Animation/Vir.irpkg"
    report = {
        "schema": "illuminate.vir-retained-callback-phases/v2",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "policy": {
            "url": args.url,
            "row": args.row,
            "runs": args.runs,
            "warmupMs": args.warmup_ms,
            "sampleMs": args.sample_ms,
            "freshBrowserContextPerRun": True,
            "virCallbackTiming": args.vir_timing,
            "balancedOrder": args.vir_timing == "both",
        },
        "environment": {
            "browser": browser_version,
            "platform": platform.platform(),
            "machine": platform.machine(),
        },
        "revisions": {
            "illuminate": git_identity(ROOT),
            "vir": git_identity(ROOT / "vir"),
        },
        "artifacts": {
            "wasm": {"path": str(wasm.relative_to(ROOT)), "sha256": sha256(wasm)},
            "rootPackage": {
                "path": str(package.relative_to(ROOT)),
                "sha256": sha256(package),
            },
            "harness": {
                "path": str(Path(__file__).resolve().relative_to(ROOT)),
                "sha256": sha256(Path(__file__).resolve()),
            },
        },
        "observations": observations,
        "summaries": summaries,
        "pairedTimingDelta": paired,
    }
    encoded = json.dumps(report, indent=2) + "\n"
    if args.json is not None:
        output = args.json.resolve()
        if output.exists():
            raise FileExistsError(f"refusing to overwrite measurement report: {output}")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(encoded)
    print(encoded, end="")


if __name__ == "__main__":
    main()
