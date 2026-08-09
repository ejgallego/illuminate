# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "playwright",
#     "pytest",
#     "pytest-playwright",
#     "Pillow",
# ]
# ///
"""
Playwright structural tests and Docker-based visual regression tests for Illuminate SVG output.

Structural tests use Playwright (headless Chromium) to inspect SVG DOM elements.
Visual regression tests render SVGs via Inkscape inside a Docker container
(visual_tests/Dockerfile) with pinned fonts to guarantee identical pixel
output across macOS and Linux.

Run with:
    uv run test_playwright.py

Or for pytest mode:
    uv run pytest test_playwright.py -v

To update expected baselines:
    UPDATE_BASELINES=1 uv run test_playwright.py
"""
import atexit
import os
import shutil
import subprocess
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import pytest

# ---------------------------------------------------------------------------
# Ensure Playwright browsers are installed
# ---------------------------------------------------------------------------


def _chromium_launch_options():
    """Uses a system Chromium when available, otherwise Playwright's browser."""
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


@pytest.fixture(scope="session")
def browser_type_launch_args():
    """Configures pytest-playwright to reuse an installed Chromium when possible."""
    return _chromium_launch_options()


def ensure_browsers():
    """Install Playwright Chromium if not already present."""
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            p.chromium.launch(headless=True, **_chromium_launch_options()).close()
    except Exception:
        subprocess.run(
            [sys.executable, "-m", "playwright", "install", "chromium"],
            check=True,
        )

# ---------------------------------------------------------------------------
# Generate reference SVGs by running lake test (which writes smiley.svg, commdiag.svg)
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent
VISUAL_DIR = ROOT / "visual_tests"
UPDATE_BASELINES = os.environ.get("UPDATE_BASELINES", "").lower() in ("1", "true", "yes")

DOCKER_IMAGE = "illuminate-inkscape"


def generate_svgs():
    """Run lake test to generate reference SVGs."""
    result = subprocess.run(
        ["lake", "test", "--wfail"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        print("lake test stderr:", result.stderr, file=sys.stderr)
        raise RuntimeError(f"lake test failed:\n{result.stdout}")
    return result.stdout


def stage_player_assets():
    """Build and stage the repository-local VIR and FIR-native player assets."""
    result = subprocess.run(
        ["npm", "run", "stage:players"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=900,
    )
    if result.returncode != 0:
        print("Player staging stderr:", result.stderr, file=sys.stderr)
        raise RuntimeError(f"Player staging failed:\n{result.stdout}")
    output = result.stdout
    if os.environ.get("ILLUMINATE_FIR_LIVE_PLAYER_DIR"):
        live_result = subprocess.run(
            ["npm", "run", "stage:fir-live"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=900,
        )
        if live_result.returncode != 0:
            print("FIR live staging stderr:", live_result.stderr, file=sys.stderr)
            raise RuntimeError(f"FIR live staging failed:\n{live_result.stdout}")
        output += live_result.stdout
    return output


def run_player_trace_tests():
    """Differentially compares JavaScript, VIR, and FIR-native traces."""
    result = subprocess.run(
        ["npm", "run", "test:player-traces"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=120,
    )
    if result.returncode != 0:
        print("Player trace stderr:", result.stderr, file=sys.stderr)
        raise RuntimeError(f"Player trace tests failed:\n{result.stdout}")
    return result.stdout


class _QuietTestOutputHandler(SimpleHTTPRequestHandler):
    """Serves generated test output without logging every asset request."""

    def log_message(self, format, *args):
        pass


_TEST_OUTPUT_SERVER = None
_TEST_OUTPUT_THREAD = None


def _stop_test_output_server():
    """Stops the lazily created generated-output HTTP server."""
    global _TEST_OUTPUT_SERVER, _TEST_OUTPUT_THREAD
    if _TEST_OUTPUT_SERVER is not None:
        _TEST_OUTPUT_SERVER.shutdown()
        _TEST_OUTPUT_SERVER.server_close()
        _TEST_OUTPUT_SERVER = None
    if _TEST_OUTPUT_THREAD is not None:
        _TEST_OUTPUT_THREAD.join(timeout=5)
        _TEST_OUTPUT_THREAD = None


def _test_output_url(name: str) -> str:
    """Returns an HTTP URL for an output file so browser modules can load assets."""
    global _TEST_OUTPUT_SERVER, _TEST_OUTPUT_THREAD
    if _TEST_OUTPUT_SERVER is None:
        handler = partial(_QuietTestOutputHandler, directory=str(ROOT / "test_output"))
        _TEST_OUTPUT_SERVER = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        _TEST_OUTPUT_THREAD = Thread(target=_TEST_OUTPUT_SERVER.serve_forever, daemon=True)
        _TEST_OUTPUT_THREAD.start()
    port = _TEST_OUTPUT_SERVER.server_address[1]
    return f"http://127.0.0.1:{port}/{name}"


atexit.register(_stop_test_output_server)


# ---------------------------------------------------------------------------
# Docker-based rsvg-convert visual test helpers
# ---------------------------------------------------------------------------

def _ensure_docker_image():
    """Build the rsvg-convert Docker image if it doesn't exist."""
    # Check if image exists
    result = subprocess.run(
        ["docker", "image", "inspect", DOCKER_IMAGE],
        capture_output=True,
    )
    if result.returncode == 0:
        return
    print("  Building Docker image for visual tests...")
    result = subprocess.run(
        ["docker", "build", "-t", DOCKER_IMAGE, str(VISUAL_DIR)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Docker build failed:\n{result.stderr}")


def _render_svg_to_png(svg_name: str) -> bytes:
    """Render an SVG to PNG using Inkscape in Docker."""
    svg_path = ROOT / svg_name
    assert svg_path.exists(), f"{svg_name} not found — run lake test first"
    svg_data = svg_path.read_bytes()
    result = subprocess.run(
        ["docker", "run", "--rm", "-i", DOCKER_IMAGE],
        input=svg_data,
        capture_output=True,
    )
    assert result.returncode == 0, f"inkscape failed: {result.stderr.decode()}"
    png_data = result.stdout
    assert len(png_data) > 100, f"inkscape produced empty output for {svg_name}"
    return png_data


def pixel_diff_ratio(img1_bytes: bytes, img2_bytes: bytes) -> float:
    """Return fraction of pixels that differ between two images."""
    from PIL import Image
    import io

    im1 = Image.open(io.BytesIO(img1_bytes)).convert("RGBA")
    im2 = Image.open(io.BytesIO(img2_bytes)).convert("RGBA")

    if im1.size != im2.size:
        return 1.0  # completely different

    b1 = im1.tobytes()
    b2 = im2.tobytes()
    channels = 4  # RGBA
    total = len(b1) // channels
    diff = sum(
        1 for i in range(total)
        if b1[i*channels:(i+1)*channels] != b2[i*channels:(i+1)*channels]
    )
    return diff / total


def _run_visual_test(svg_name: str, test_name: str):
    """Render SVG via Docker rsvg-convert, write actual PNG, compare against expected."""
    VISUAL_DIR.mkdir(exist_ok=True)
    _ensure_docker_image()
    rendered = _render_svg_to_png(svg_name)

    actual_path = VISUAL_DIR / f"{test_name}.actual.png"
    expected_path = VISUAL_DIR / f"{test_name}.expected.png"

    actual_path.write_bytes(rendered)

    if UPDATE_BASELINES:
        expected_path.write_bytes(rendered)

    if not expected_path.exists():
        raise AssertionError(
            f"No expected baseline at {expected_path.relative_to(ROOT)}. "
            f"Run with UPDATE_BASELINES=1 to create it."
        )

    baseline = expected_path.read_bytes()
    ratio = pixel_diff_ratio(rendered, baseline)
    assert ratio < 0.001, (
        f"{test_name} visual regression: {ratio:.4%} pixels differ. "
        f"Compare {actual_path.name} vs {expected_path.name} in visual_tests/"
    )


# ---------------------------------------------------------------------------
# Structural tests (Playwright)
# ---------------------------------------------------------------------------

def test_smiley_structure(page):
    """Smiley SVG has expected element counts and structure."""
    svg_path = ROOT / "smiley.svg"
    assert svg_path.exists(), "smiley.svg not found — run lake test first"
    page.goto(f"file://{svg_path}")

    # Should have path elements (face, eyes, smile)
    paths = page.locator("path")
    count = paths.count()
    assert count >= 4, f"Expected >= 4 <path> elements, got {count}"

    # Should have a yellow fill (face)
    svg_content = svg_path.read_text()
    assert "rgb(255,220,50)" in svg_content, "Missing yellow face color"

    # Should have transform groups (for eye positioning)
    groups = page.locator("g[transform]")
    g_count = groups.count()
    assert g_count >= 1, f"Expected >= 1 <g transform> elements, got {g_count}"


def test_smiley_bounding_box(page):
    """Smiley SVG renders with reasonable bounding box dimensions."""
    svg_path = ROOT / "smiley.svg"
    page.goto(f"file://{svg_path}")

    bbox = page.locator("svg").bounding_box()
    assert bbox is not None, "SVG element not found"
    assert bbox["width"] > 50, f"SVG too narrow: {bbox['width']}"
    assert bbox["height"] > 50, f"SVG too short: {bbox['height']}"


def test_commdiag_structure(page):
    """Commutative diagram SVG has nodes and arrows."""
    svg_path = ROOT / "commdiag.svg"
    assert svg_path.exists(), "commdiag.svg not found — run lake test first"
    page.goto(f"file://{svg_path}")

    # Should have text elements for node labels (A, B, C, D)
    texts = page.locator("text")
    text_count = texts.count()
    assert text_count >= 4, f"Expected >= 4 <text> elements, got {text_count}"

    # Should have path elements for arrows
    paths = page.locator("path")
    path_count = paths.count()
    assert path_count >= 4, f"Expected >= 4 <path> elements (arrows), got {path_count}"


def test_commdiag_labels(page):
    """Commutative diagram has the expected label text content."""
    svg_path = ROOT / "commdiag.svg"
    page.goto(f"file://{svg_path}")

    svg_content = svg_path.read_text()
    for label in ["A", "B", "C", "D", "f", "g", "h", "k"]:
        assert f">{label}</text>" in svg_content, f"Missing label '{label}'"


def test_commdiag_annotations(page):
    """Commutative diagram SVG does not crash with annotations."""
    svg_path = ROOT / "commdiag.svg"
    page.goto(f"file://{svg_path}")

    # Just verify the SVG renders without errors
    svg = page.locator("svg")
    assert svg.count() == 1, "Expected exactly one SVG element"


def test_commdiag_node_positions(page):
    """Nodes A and B should be horizontally separated (A left of B)."""
    svg_path = ROOT / "commdiag.svg"
    page.goto(f"file://{svg_path}")

    # Get bounding boxes of text elements
    texts = page.locator("text")
    text_count = texts.count()

    positions = []
    for i in range(text_count):
        bbox = texts.nth(i).bounding_box()
        content = texts.nth(i).text_content()
        if bbox:
            positions.append((content, bbox))

    # Find A and B positions
    a_pos = next((p for c, p in positions if c == "A"), None)
    b_pos = next((p for c, p in positions if c == "B"), None)

    if a_pos and b_pos:
        # A should be to the left of B (in SVG coordinates)
        assert a_pos["x"] < b_pos["x"], (
            f"A (x={a_pos['x']}) should be left of B (x={b_pos['x']})"
        )


def test_stars_structure(page):
    """Stars SVG has path elements for each star and uses dash patterns."""
    svg_path = ROOT / "stars.svg"
    assert svg_path.exists(), "stars.svg not found — run lake test first"
    page.goto(f"file://{svg_path}")

    # Should have many path elements (fill + stroke for each star)
    paths = page.locator("path")
    count = paths.count()
    assert count >= 20, f"Expected >= 20 <path> elements, got {count}"

    # Should have dash patterns
    svg_content = svg_path.read_text()
    assert "stroke-dasharray" in svg_content, "Missing stroke-dasharray for dashed stars"


def test_cellophane_clip_structure(page):
    """Cellophane/clip SVG has opacity groups and clipPath elements."""
    svg_path = ROOT / "cellophane-clip.svg"
    assert svg_path.exists(), "cellophane-clip.svg not found — run lake test first"
    svg_content = svg_path.read_text()
    assert "opacity" in svg_content, "Missing opacity attribute for cellophane"
    assert "clipPath" in svg_content, "Missing clipPath element for clip"


# ---------------------------------------------------------------------------
# Visual regression tests (Docker rsvg-convert)
# ---------------------------------------------------------------------------

def test_smiley_visual():
    """Compare smiley rendering against expected baseline."""
    _run_visual_test("smiley.svg", "smiley")


def test_commdiag_visual():
    """Compare commdiag rendering against expected baseline."""
    _run_visual_test("commdiag.svg", "commdiag")


def test_roundedrects_visual():
    """Compare rounded-rects rendering against expected baseline."""
    _run_visual_test("roundedrects.svg", "roundedrects")

def test_roundedrects_2_5_visual():
    """Compare rounded-rects rendering against expected baseline."""
    _run_visual_test("roundedrects_2_5.svg", "roundedrects_2_5")

def test_roundedrects_2_10_visual():
    """Compare rounded-rects rendering against expected baseline."""
    _run_visual_test("roundedrects_2_10.svg", "roundedrects_2_10")

def test_roundedrects_7_2_visual():
    """Compare rounded-rects rendering against expected baseline."""
    _run_visual_test("roundedrects_7_2.svg", "roundedrects_7_2")

def test_roundedrects_7_5_visual():
    """Compare rounded-rects rendering against expected baseline."""
    _run_visual_test("roundedrects_7_5.svg", "roundedrects_7_5")


def test_pipeline_visual():
    """Compare pipeline diagram rendering against expected baseline."""
    _run_visual_test("pipeline.svg", "pipeline")


def test_stringlayout_visual():
    """Compare string layout diagram rendering against expected baseline."""
    _run_visual_test("string-layout.svg", "stringlayout")


def test_textmixedfonts_visual():
    """Compare text mixed fonts diagram rendering against expected baseline."""
    _run_visual_test("text-mixed-fonts.svg", "textmixedfonts")


def test_bracedirections_visual():
    """Compare brace directions diagram rendering against expected baseline."""
    _run_visual_test("brace-directions.svg", "bracedirections")


def test_bracedirectionsangles_visual():
    """Compare brace directions angles diagram rendering against expected baseline."""
    _run_visual_test("brace-directions-angles.svg", "bracedirectionsangles")


def test_coechain_visual():
    """Compare coe-chain diagram rendering against expected baseline."""
    _run_visual_test("coe-chain.svg", "coechain")


def test_lakeworkspace_visual():
    """Compare lake workspace diagram rendering against expected baseline."""
    _run_visual_test("lake-workspace.svg", "lakeworkspace")


def test_stars_visual():
    """Compare stars rendering against expected baseline."""
    _run_visual_test("stars.svg", "stars")


def test_star_anchors_visual():
    """Compare star-anchors rendering against expected baseline."""
    _run_visual_test("star-anchors.svg", "star-anchors")


def test_ellipse_visual():
    """Compare ellipse rendering against expected baseline."""
    _run_visual_test("ellipse.svg", "ellipse")


def test_transforms_visual():
    """Compare transforms rendering against expected baseline."""
    _run_visual_test("transforms.svg", "transforms")


def test_ghost_refocus_visual():
    """Compare ghost-refocus rendering against expected baseline."""
    _run_visual_test("ghost-refocus.svg", "ghost-refocus")


def test_cellophane_clip_visual():
    """Compare cellophane-clip rendering against expected baseline."""
    _run_visual_test("cellophane-clip.svg", "cellophane-clip")


def test_trace_connect_angled_visual():
    """Compare trace-connect-angled rendering against expected baseline."""
    _run_visual_test("trace-connect-angled.svg", "trace-connect-angled")


def test_pizza_visual():
    """Compare pizza wedge rendering against expected baseline."""
    _run_visual_test("pizza.svg", "pizza")


def test_filmstrip_growing_circle_visual():
    """Compare filmstrip growing-circle rendering against expected baseline."""
    _run_visual_test("filmstrip-growing-circle.svg", "filmstrip-growing-circle")


def test_filmstrip_rotating_square_visual():
    """Compare filmstrip rotating-square rendering against expected baseline."""
    _run_visual_test("filmstrip-rotating-square.svg", "filmstrip-rotating-square")


def test_filmstrip_animated_clip_visual():
    """Compare filmstrip animated-clip rendering against expected baseline."""
    _run_visual_test("filmstrip-animated-clip.svg", "filmstrip-animated-clip")


def test_filmstrip_morph_rect_circle_visual():
    """Compare filmstrip morph rect-to-circle rendering against expected baseline."""
    _run_visual_test("filmstrip-morph-rect-circle.svg", "filmstrip-morph-rect-circle")


def test_filmstrip_morph_nested_visual():
    """Compare filmstrip morph nested named diagrams rendering against expected baseline."""
    _run_visual_test("filmstrip-morph-nested.svg", "filmstrip-morph-nested")


def test_filmstrip_morph_arrows_visual():
    """Compare filmstrip morph arrow tests rendering against expected baseline."""
    _run_visual_test("filmstrip-morph-arrows.svg", "filmstrip-morph-arrows")


def test_filmstrip_morph_transforms_visual():
    """Compare filmstrip morph wrapper transforms rendering against expected baseline."""
    _run_visual_test("filmstrip-morph-transforms.svg", "filmstrip-morph-transforms")


def test_flowchart_shapes_visual():
    """Compare flowchart shapes rendering against expected baseline."""
    _run_visual_test("flowchart-shapes.svg", "flowchart-shapes")


def test_parallelogram_variations_visual():
    """Compare parallelogram variations rendering against expected baseline."""
    _run_visual_test("parallelogram-variations.svg", "parallelogram-variations")


def test_arrow_shapes_visual():
    """Compare arrow shapes rendering against expected baseline."""
    _run_visual_test("arrow-shapes.svg", "arrow-shapes")


def test_bent_arrows_visual():
    """Compare bent arrow shapes rendering against expected baseline."""
    _run_visual_test("bent-arrows.svg", "bent-arrows")


def test_heart_shapes_visual():
    """Compare heart shapes rendering against expected baseline."""
    _run_visual_test("heart-shapes.svg", "heart-shapes")


def test_decorative_shapes_visual():
    """Compare decorative shapes rendering against expected baseline."""
    _run_visual_test("decorative-shapes.svg", "decorative-shapes")


def test_plus_variations_visual():
    """Compare plus shape variations rendering against expected baseline."""
    _run_visual_test("plus-variations.svg", "plus-variations")


def test_cloud_variations_visual():
    """Compare cloud shape variations rendering against expected baseline."""
    _run_visual_test("cloud-variations.svg", "cloud-variations")


def test_bubble_shapes_visual():
    """Compare bubble shapes rendering against expected baseline."""
    _run_visual_test("bubble-shapes.svg", "bubble-shapes")


def test_bubble_placement_visual():
    """Compare bubble placement rendering against expected baseline."""
    _run_visual_test("bubble-placement.svg", "bubble-placement")


def test_operator_shapes_visual():
    """Compare operator shapes rendering against expected baseline."""
    _run_visual_test("operator-shapes.svg", "operator-shapes")


def test_flowchart_demo_visual():
    """Compare flowchart demo rendering against expected baseline."""
    _run_visual_test("flowchart-demo.svg", "flowchart-demo")


def test_binary_tree_visual():
    """Compare binary tree layout rendering against expected baseline."""
    _run_visual_test("binary-tree.svg", "binary-tree")


def test_nary_tree_visual():
    """Compare n-ary tree layout rendering against expected baseline."""
    _run_visual_test("nary-tree.svg", "nary-tree")


def test_ltr_tree_visual():
    """Compare left-to-right tree layout rendering against expected baseline."""
    _run_visual_test("ltr-tree.svg", "ltr-tree")


def test_proof_tree_visual():
    """Compare proof tree layout rendering against expected baseline."""
    _run_visual_test("proof-tree.svg", "proof-tree")


# ---------------------------------------------------------------------------
# Standalone animation player tests
# ---------------------------------------------------------------------------

def _open_vir_player(page, name: str):
    """Opens a staged VIR player and reports a visible initialization failure."""
    html_path = ROOT / "test_output" / name
    assert html_path.exists(), f"{name} not found — run lake test first"
    package_set_path = (
        ROOT
        / "test_output"
        / "vir"
        / "module-sets"
        / "Illuminate"
        / "Animation"
        / "Vir.irpkg-set.json"
    )
    assert package_set_path.exists(), "VIR player package set not found — run npm run stage:vir first"
    page.goto(_test_output_url(name))
    page.wait_for_function(
        "document.getElementById('anim-status')?.dataset.state !== 'loading'",
        timeout=30_000,
    )
    status = page.locator("#anim-status")
    assert status.get_attribute("data-state") == "ready", status.text_content()


def _animation_frames(page):
    """Returns serialized initial and final SVG frames for a loaded player."""
    initial = page.locator("#anim-container").inner_html()
    maximum = int(page.locator("#anim-scrub").get_attribute("max"))
    page.locator("#anim-scrub").evaluate(
        """(element, value) => {
            element.value = value;
            element.dispatchEvent(new Event("input"));
        }""",
        str(maximum),
    )
    return initial, page.locator("#anim-container").inner_html()


def test_standalone_player_seek_updates_content(page):
    """Scrubbing the standalone player to a different frame should change the displayed SVG.

    The standalone playerJs renders the sync frame SVG then patches varying attributes
    via paramMap/params. Seeking to a later frame should update the displayed content.
    """
    html_path = ROOT / "test_output" / "anim-seek-test.html"
    assert html_path.exists(), "anim-seek-test.html not found — run lake test first"
    page.goto(f"file://{html_path}")

    # Get the SVG content at frame 0
    frame0_svg = page.evaluate("document.getElementById('anim-container').innerHTML")
    assert "<svg" in frame0_svg, "Container should have SVG at frame 0"

    # Seek to the last frame via the scrubber
    last_frame = page.evaluate("parseInt(document.getElementById('anim-scrub').max)")
    page.evaluate(f"""
        var scrubber = document.getElementById('anim-scrub');
        scrubber.value = {last_frame};
        scrubber.dispatchEvent(new Event('input'));
    """)

    # Get the SVG content at the last frame
    last_frame_svg = page.evaluate("document.getElementById('anim-container').innerHTML")
    assert "<svg" in last_frame_svg, "Container should have SVG at last frame"

    # The circle grows from radius 10 to ~50, so the path data MUST differ.
    # If they're equal, the player is showing stale sync-frame content.
    assert frame0_svg != last_frame_svg, (
        "Seeking to the last frame should change the displayed SVG "
        "(circle grows from r=10 to r≈50), but the content is identical — "
        "the standalone player is not applying per-frame updates"
    )


def test_vir_player_matches_legacy_seek_trace(page):
    """The VIR and legacy players should produce identical SVGs for the same seek trace."""
    legacy_path = ROOT / "test_output" / "anim-seek-test.html"
    assert legacy_path.exists(), "anim-seek-test.html not found — run lake test first"
    page.goto(_test_output_url("anim-seek-test.html"))
    legacy_frames = _animation_frames(page)

    vir_page = page.context.new_page()
    try:
        _open_vir_player(vir_page, "anim-vir-seek-test.html")
        vir_frames = _animation_frames(vir_page)
    finally:
        vir_page.close()

    assert vir_frames == legacy_frames, (
        "The Lean/VIR player and legacy JavaScript player produced different "
        "initial or final SVG DOM for the same seek trace"
    )


def test_vir_player_replaces_segments_like_legacy(page):
    """Structural segment changes should replace and re-index the SVG identically."""
    legacy_path = ROOT / "test_output" / "anim-segment-test.html"
    assert legacy_path.exists(), "anim-segment-test.html not found — run lake test first"
    page.goto(_test_output_url("anim-segment-test.html"))
    legacy_frames = _animation_frames(page)

    vir_page = page.context.new_page()
    try:
        _open_vir_player(vir_page, "anim-vir-segment-test.html")
        vir_frames = _animation_frames(vir_page)
        maximum = vir_page.locator("#anim-scrub").get_attribute("max")
        for frame in ("0", maximum, "0", maximum):
            vir_page.locator("#anim-scrub").evaluate(
                """(element, value) => {
                    element.value = value;
                    element.dispatchEvent(new Event("input"));
                }""",
                frame,
            )
            assert vir_page.locator("#anim-container svg").count() == 1
    finally:
        vir_page.close()

    assert vir_frames == legacy_frames
    assert legacy_frames[0] != legacy_frames[1]


def test_vir_player_pause_cancels_pending_frame(page):
    """Pausing while a callback is pending should leave the displayed frame stable."""
    _open_vir_player(page, "anim-vir-seek-test.html")
    page.click("#anim-play")
    page.wait_for_timeout(50)
    page.click("#anim-play")
    paused_frame = page.locator("#anim-scrub").input_value()
    page.wait_for_timeout(250)
    assert page.locator("#anim-scrub").input_value() == paused_frame
    assert page.locator("#anim-play").text_content() == "\u25B6"


def test_vir_player_instances_are_independent(page):
    """Two owned players in one VIR runtime should animate and dispose independently."""
    page.goto(_test_output_url("anim-vir-dual-test.html"))
    page.wait_for_function(
        """() => {
            const services = window.__illuminateVirRevealServices;
            return services && services.size === 1 && [...services.values()][0].players.size === 2;
        }""",
        timeout=30_000,
    )
    assert page.locator("#anim-a svg").count() == 1
    assert page.locator("#anim-b svg").count() == 1
    initial_a = page.locator("#anim-a").inner_html()
    initial_b = page.locator("#anim-b").inner_html()

    page.evaluate(
        """() => {
            const service = [...window.__illuminateVirRevealServices.values()][0];
            const player = [...service.players.values()].find(value => value.selector === '#anim-a');
            const event = { fragment: player.fragments[1] };
            Reveal.listeners.shown.forEach(callback => callback(event));
        }"""
    )
    page.wait_for_timeout(350)
    assert page.locator("#anim-a").inner_html() != initial_a
    assert page.locator("#anim-b").inner_html() == initial_b

    page.evaluate(
        """() => {
            const service = [...window.__illuminateVirRevealServices.values()][0];
            const entry = [...service.players.entries()].find(([, value]) => value.selector === '#anim-a');
            entry[1].dispose();
            const other = [...service.players.entries()].find(([, value]) => value.selector === '#anim-b');
            service.runtime.call('Illuminate.Animation.Vir.advancePlayer', other[0]);
        }"""
    )
    page.wait_for_timeout(100)
    assert page.evaluate(
        "[...window.__illuminateVirRevealServices.values()][0].players.size"
    ) == 1
    assert page.locator("#anim-b").inner_html() != initial_b


def test_vir_reveal_reverse_and_slide_pause(page):
    """Reveal reverse navigation and slide changes should control only their player."""
    page.goto(_test_output_url("anim-vir-dual-test.html"))
    page.wait_for_function(
        """() => {
            const services = window.__illuminateVirRevealServices;
            return services && [...services.values()][0]?.players.size === 2;
        }""",
        timeout=30_000,
    )
    initial = page.locator("#anim-a").inner_html()
    page.evaluate(
        """() => {
            const service = [...window.__illuminateVirRevealServices.values()][0];
            const player = [...service.players.values()].find(value => value.selector === '#anim-a');
            Reveal.listeners.shown.forEach(callback => callback({ fragment: player.fragments[1] }));
        }"""
    )
    page.wait_for_timeout(350)
    assert page.locator("#anim-a").inner_html() != initial

    page.evaluate(
        """() => {
            const service = [...window.__illuminateVirRevealServices.values()][0];
            const player = [...service.players.values()].find(value => value.selector === '#anim-a');
            Reveal.listeners.hidden.forEach(callback => callback({ fragment: player.fragments[1] }));
        }"""
    )
    page.wait_for_function(
        "initial => document.querySelector('#anim-a').innerHTML === initial",
        arg=initial,
        timeout=2_000,
    )
    assert page.locator("#anim-a").inner_html() == initial

    page.evaluate(
        """() => {
            const service = [...window.__illuminateVirRevealServices.values()][0];
            const player = [...service.players.values()].find(value => value.selector === '#anim-a');
            Reveal.listeners.shown.forEach(callback => callback({ fragment: player.fragments[1] }));
        }"""
    )
    page.wait_for_timeout(350)
    page.evaluate(
        "Reveal.listeners.slide.forEach(callback => callback({ previousSlide: document.body }))"
    )
    paused = page.locator("#anim-a").inner_html()
    page.wait_for_timeout(250)
    assert page.locator("#anim-a").inner_html() == paused


def test_vir_player_disposes_while_playing(page):
    """Navigating away while playing should dispose callbacks without page errors."""
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    _open_vir_player(page, "anim-vir-loop-test.html")
    page.click("#anim-play")
    page.wait_for_timeout(50)
    page.goto("about:blank")
    page.wait_for_timeout(100)
    assert errors == []


def test_standalone_player_loop_does_not_stop(page):
    """A single looping step should never reach 'stopped' state.

    The standalone playerJs tick() function does not handle the loop flag on
    steps. When frame >= totalFrames, it unconditionally sets playing = false
    and shows the play button, even though a looping step should wrap around.
    """
    html_path = ROOT / "test_output" / "anim-loop-test.html"
    assert html_path.exists(), "anim-loop-test.html not found — run lake test first"
    page.goto(f"file://{html_path}")

    # Click play to start the animation
    page.click("#anim-play")

    # Wait long enough for the animation to have played through at least once
    # (the animation is 1 second at 10fps = 10 frames)
    page.wait_for_timeout(1500)

    # If loop handling works, the animation should still be playing.
    # The play button text should be the pause icon (⏸ = \u23F8), not play (▶ = \u25B6).
    btn_text = page.evaluate("document.getElementById('anim-play').textContent")
    assert btn_text == "\u23F8", (
        f"After 1.5s, a 1s looping animation should still be playing "
        f"(button should show ⏸), but button shows '{btn_text}' — "
        f"the standalone player does not handle looping steps"
    )


def test_vir_player_loop_does_not_stop(page):
    """A VIR-backed looping step should remain active after a complete cycle."""
    _open_vir_player(page, "anim-vir-loop-test.html")
    page.click("#anim-play")
    page.wait_for_timeout(2500)
    assert page.locator("#anim-play").text_content() == "\u23F8"


def test_standalone_player_dual_animation_independence(page):
    """Two animations embedded in the same page should each render into their own container.

    Each renderRevealHTML call targets a different CSS selector, so both
    animations should render independently without clobbering each other.
    """
    html_path = ROOT / "test_output" / "anim-dual-test.html"
    assert html_path.exists(), "anim-dual-test.html not found — run lake test first"
    page.goto(f"file://{html_path}")

    anim_a_svg = page.evaluate("document.querySelector('#anim-a')?.innerHTML || ''")
    anim_b_svg = page.evaluate("document.querySelector('#anim-b')?.innerHTML || ''")

    # Both containers should have SVG content
    assert "<svg" in anim_a_svg, "Animation A container should have SVG content"
    assert "<svg" in anim_b_svg, "Animation B container should have SVG content"

    # Animation A is a red circle, animation B is a blue rectangle.
    # They should have DIFFERENT content because they're different animations.
    assert anim_a_svg != anim_b_svg, (
        "Two different animations (red circle vs blue rectangle) should show "
        "different SVG content, but they are identical — one animation's "
        "data may have clobbered the other"
    )


def test_animation_comparison_dashboard(page):
    """The dashboard should mount every example twice and report common runtime statistics."""
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(_test_output_url("anim-comparison.html"))
    page.wait_for_function("document.body.dataset.ready === 'true'", timeout=60_000)

    assert page.locator(".example").count() == 16
    assert page.locator(".stage svg").count() == 32
    assert "16 examples · 32 owned players" in page.locator("#comparison-status").inner_text()
    assert page.locator("#comparison-backend").input_value() == "vir"
    fir_live_staged = (ROOT / "test_output" / "fir-live" / "BUILD.json").exists()
    assert page.locator('#comparison-backend option[value="fir"]').evaluate(
        "option => option.disabled"
    ) is (not fir_live_staged)

    page.wait_for_function(
        """() => [...document.querySelectorAll('[data-summary-stat=fps]')]
            .every(node => Number.parseFloat(node.textContent || '0') > 0)""",
        timeout=10_000,
    )
    cpu_values = page.locator("[data-summary-stat=cpu]").all_inner_texts()
    assert all(float(value.rstrip("%")) >= 0 for value in cpu_values)
    page.locator("#comparison-vir-timing").check()
    page.wait_for_function(
        """() => [...document.querySelectorAll('[data-phase-count]')]
            .every(node => Number.parseInt(node.textContent || '0', 10) > 0)""",
        timeout=10_000,
    )
    phase_values = page.locator("[data-phase]").all_inner_texts()
    assert len(phase_values) == 16 * 8
    assert all(float(value.split()[0]) >= 0 for value in phase_values)
    assert page.evaluate(
        """() => [...document.querySelectorAll('[data-candidate-phases]')].every(panel =>
            Number.parseFloat(panel.querySelector('[data-phase=host]')?.textContent || '0') <=
            Number.parseFloat(panel.querySelector('[data-phase=execute]')?.textContent || '0'))"""
    )
    assert page.locator("[data-dom-match]:not(.mismatch)").count() > 0

    if fir_live_staged:
        page.locator("#comparison-backend").select_option("fir")
        page.wait_for_function(
            """() => [...document.querySelectorAll('[data-candidate-name]')]
                .every(node => node.textContent === 'Lean · FIR')"""
        )
        page.click("#comparison-start")
        page.wait_for_function(
            """() => [...document.querySelectorAll('[data-phase-count]')]
                .every(node => Number.parseInt(node.textContent || '0', 10) > 0)""",
            timeout=10_000,
        )
        page.wait_for_function(
            """() => [...document.querySelectorAll(
                '[data-candidate-phases] [data-phase-setup]'
              )].every(node => node.textContent?.startsWith('create '))""",
            timeout=10_000,
        )
        assert page.locator("[data-dom-match]:not(.mismatch)").count() > 0

    page.click("#comparison-pause")
    page.wait_for_timeout(350)
    assert all(
        state in ("paused", "finished")
        for state in page.locator("[data-row-state]").all_inner_texts()
    )
    page.click("#comparison-reset")
    page.wait_for_timeout(350)
    assert all(
        value.startswith("0 / ") for value in page.locator("[data-frame]").all_inner_texts()
    )
    assert page.locator("[data-dom-match].mismatch").count() == 0
    assert errors == []


# ---------------------------------------------------------------------------
# Direct runner (not pytest)
# ---------------------------------------------------------------------------

def main():
    """Run all tests directly without pytest."""
    print("Generating SVGs via lake test...")
    output = generate_svgs()
    for line in output.strip().split("\n")[-3:]:
        print(f"  {line}")

    print("\nStaging repository-local VIR and FIR-native player assets...")
    player_output = stage_player_assets()
    for line in player_output.strip().split("\n")[-3:]:
        print(f"  {line}")

    print("\nComparing JavaScript, VIR, and FIR-native player traces...")
    trace_output = run_player_trace_tests()
    print(f"  {trace_output.strip().splitlines()[-1]}")

    print("\nInstalling Playwright browsers if needed...")
    ensure_browsers()

    from playwright.sync_api import sync_playwright

    structural_tests = [
        test_smiley_structure,
        test_smiley_bounding_box,
        test_commdiag_structure,
        test_commdiag_labels,
        test_commdiag_annotations,
        test_commdiag_node_positions,
        test_stars_structure,
        test_cellophane_clip_structure,
        test_standalone_player_seek_updates_content,
        test_vir_player_matches_legacy_seek_trace,
        test_vir_player_replaces_segments_like_legacy,
        test_vir_player_pause_cancels_pending_frame,
        test_vir_player_instances_are_independent,
        test_vir_reveal_reverse_and_slide_pause,
        test_vir_player_disposes_while_playing,
        test_standalone_player_loop_does_not_stop,
        test_vir_player_loop_does_not_stop,
        test_standalone_player_dual_animation_independence,
        test_animation_comparison_dashboard,
    ]

    visual_tests = [
        test_smiley_visual,
        test_commdiag_visual,
        test_roundedrects_visual,
        test_roundedrects_2_5_visual,
        test_roundedrects_2_10_visual,
        test_roundedrects_7_2_visual,
        test_roundedrects_7_5_visual,
        test_pipeline_visual,
        test_stringlayout_visual,
        test_textmixedfonts_visual,
        test_bracedirections_visual,
        test_bracedirectionsangles_visual,
        test_coechain_visual,
        test_lakeworkspace_visual,
        test_stars_visual,
        test_star_anchors_visual,
        test_ellipse_visual,
        test_transforms_visual,
        test_ghost_refocus_visual,
        test_cellophane_clip_visual,
        test_trace_connect_angled_visual,
        test_pizza_visual,
        test_filmstrip_growing_circle_visual,
        test_filmstrip_rotating_square_visual,
        test_filmstrip_animated_clip_visual,
        test_filmstrip_morph_rect_circle_visual,
        test_filmstrip_morph_nested_visual,
        test_filmstrip_morph_arrows_visual,
        test_filmstrip_morph_transforms_visual,
        test_flowchart_shapes_visual,
        test_parallelogram_variations_visual,
        test_arrow_shapes_visual,
        test_bent_arrows_visual,
        test_heart_shapes_visual,
        test_decorative_shapes_visual,
        test_plus_variations_visual,
        test_cloud_variations_visual,
        test_bubble_shapes_visual,
        test_bubble_placement_visual,
        test_operator_shapes_visual,
        test_flowchart_demo_visual,
        test_binary_tree_visual,
        test_nary_tree_visual,
        test_ltr_tree_visual,
        test_proof_tree_visual,
    ]

    passed = 0
    failed = 0

    # Run structural tests with Playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, **_chromium_launch_options())

        for test_fn in structural_tests:
            name = test_fn.__name__
            context = browser.new_context()
            page = context.new_page()
            try:
                test_fn(page)
                print(f"  ✓ {name}")
                passed += 1
            except Exception as e:
                print(f"  ✗ {name}: {e}")
                failed += 1
            finally:
                context.close()

        browser.close()

    # Run visual regression tests with Docker rsvg-convert
    for test_fn in visual_tests:
        name = test_fn.__name__
        try:
            test_fn()
            print(f"  ✓ {name}")
            passed += 1
        except Exception as e:
            print(f"  ✗ {name}: {e}")
            failed += 1

    print(f"\n{passed} passed, {failed} failed")
    if failed > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
