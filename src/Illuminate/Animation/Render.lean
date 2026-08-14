/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: David Thrane Christiansen
-/
module
public import Lean.Data.Json.Basic
public import Illuminate.Animation.Types
import Lean.Data.Json.Printer
public section


namespace Illuminate

/-!
# JSON serialization using Lean.Json
-/

open Lean in
/-- Serializes a ParamBinding to a Lean JSON value. -/
private def paramBindingToJson (pb : ParamBinding) : Json :=
  .mkObj [("e", .num pb.elemIdx), ("a", .str pb.attr)]

open Lean in
/-- Serializes a Segment to a Lean JSON value. -/
private def segmentToJson (seg : Segment) : Json :=
  let pmap := seg.paramMap.map paramBindingToJson
  let params := seg.params.map fun frameParams =>
    Json.arr (frameParams.map Json.str)
  .mkObj [
    ("sf", .num seg.startFrame),
    ("fc", .num seg.frameCount),
    ("sync", .str seg.syncFrame),
    ("pmap", .arr pmap),
    ("params", .arr params)]

open Lean in
/-- Serializes a StepInfo to a Lean JSON value. -/
private def stepInfoToJson (si : StepInfo) : Json :=
  .mkObj [("frame", .num si.frame), ("pause", .bool si.pause), ("loop", .bool si.loop)]

open Lean in
/-- Serializes a CompiledAnimation to a Lean JSON value. -/
def compiledAnimationToLeanJson (ca : CompiledAnimation) : Json :=
  let segs := ca.segments.map segmentToJson
  let steps := ca.steps.map stepInfoToJson
  .mkObj [
    ("fps", .num ca.fps),
    ("totalFrames", .num ca.totalFrames),
    ("segments", .arr segs),
    ("steps", .arr steps)]

open Lean in
/-- Serializes a CompiledAnimation to a JSON string safe for embedding in `<script>` tags. -/
def compiledAnimationToJson (ca : CompiledAnimation) : String :=
  toString (compiledAnimationToLeanJson ca)
    |>.replace "</" "<\\/"
    |>.replace "]]>" "]]\\>"

/-!
# HTML player
-/

/-- Escapes a string for safe inclusion in a JavaScript single-quoted string literal. -/
private def escapeJs (s : String) : String :=
  s.foldl (init := "") fun acc c =>
    acc ++ match c with
    | '\\' => "\\\\"
    | '\'' => "\\'"
    | '\n' => "\\n"
    | '\r' => "\\r"
    | '\t' => "\\t"
    | c => c.toString

/-- Locations of the VIR browser assets used by a generated standalone player. -/
structure VirPlayerAssets where
  /-- ES module that exports {lit}`createVirRuntime`. -/
  runtimeModule : String := "./vir/sdk/js/vir-runtime.js"
  /-- VIR interpreter WebAssembly module. -/
  wasm : String := "./vir/sdk/wasm/vir-upstream.wasm"
  /-- Illuminate animation IR package-set descriptor. -/
  packageSet : String := "./vir/module-sets/Illuminate/Animation/Vir.irpkg-set.json"
deriving Repr, BEq, Inhabited

/-- Shared animation helper functions used by all player variants. -/
def animCoreJs : String :=
  include_str "../../../player_js/anim_core.js"

/--
The JavaScript player code for standalone SVG DOM playback.

Uses {lit}`__ILLUMINATE_DATA_98712__` and {lit}`__ILLUMINATE_SELECTOR_98712__` as placeholders that callers replace
with the serialized animation JSON and a CSS selector string, respectively.
-/
private def playerJs : String :=
  animCoreJs ++ "\n" ++ include_str "../../../player_js/standalone.js"

/--
The JavaScript player code for reveal.js fragment-driven playback.

Uses {lit}`__ILLUMINATE_DATA_98712__` and {lit}`__ILLUMINATE_SELECTOR_98712__` as placeholders.
-/
private def revealJs : String :=
  animCoreJs ++ "\n" ++ include_str "../../../player_js/reveal.js"

/-- The narrow Reveal adapter used by VIR-backed animation snippets. -/
private def virRevealJs : String :=
  include_str "../../../player_js/vir_reveal.js"

/-- Browser scheduling and SVG patch host prepared for persistent FIR players. -/
private def firLivePlayerJs : String :=
  include_str "../../../player_js/fir_live_player.js"

/-- Browser scheduling host for persistent selection-only VIR players. -/
private def virSelectionPlayerJs : String :=
  include_str "../../../player_js/vir_selection_player.js"

/-- Browser harness for side-by-side JavaScript and Lean animation comparisons. -/
private def comparisonJs : String :=
  animCoreJs ++ "\n" ++ firLivePlayerJs ++ "\n" ++ virSelectionPlayerJs ++ "\n" ++
    include_str "../../../player_js/comparison.js"

open Lean in
private def comparisonDataToJson
    (examples : Array (String × CompiledAnimation)) : String :=
  toString (Json.arr <| examples.map fun (title, animation) =>
    Json.mkObj [
      ("title", .str title),
      ("data", compiledAnimationToLeanJson animation)])
    |>.replace "</" "<\\/"
    |>.replace "]]>" "]]\\>"

/-- Renders a {name}`CompiledAnimation` to a self-contained HTML file. -/
def CompiledAnimation.renderHTML (ca : CompiledAnimation)
    (selector : String := "#anim-container") : String :=
  let dataJson := compiledAnimationToJson ca
  let js := playerJs
    |>.replace "__ILLUMINATE_DATA_98712__" dataJson
    |>.replace "__ILLUMINATE_SELECTOR_98712__" (escapeJs selector)
  s!"<!DOCTYPE html>
<html>
<head>
<meta charset=\"utf-8\">
<style>
body \{ margin: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background: #f5f5f5; font-family: sans-serif; }
#anim-container \{ background: white; border: 1px solid #ddd; border-radius: 4px; padding: 10px; width: min(400px, 90vw); }
#anim-container svg \{ display: block; width: 100%; height: auto; max-width: 90vw; max-height: 70vh; }
.controls \{ margin-top: 12px; display: flex; align-items: center; gap: 8px; }
#anim-play \{ font-size: 18px; width: 36px; height: 36px; border: 1px solid #ccc; border-radius: 4px; background: white; cursor: pointer; }
#anim-scrub \{ width: 300px; }
</style>
</head>
<body>
<div id=\"anim-container\"></div>
<div class=\"controls\">
  <button id=\"anim-play\" aria-label=\"Play\">\u25B6</button>
  <input type=\"range\" id=\"anim-scrub\" min=\"0\" value=\"0\" aria-label=\"Animation progress\">
</div>
<script>
{js}
</script>
</body>
</html>"

/--
Renders a standalone HTML player whose playback decisions and SVG patches run
in Lean through VIR.

The generated page keeps only runtime loading and visible error reporting in
JavaScript. The asset paths are resolved relative to the generated HTML file.
-/
def CompiledAnimation.renderVirHTML
    (ca : CompiledAnimation)
    (assets : VirPlayerAssets := {})
    (selector : String := "#anim-container") : String :=
  let dataJson := compiledAnimationToJson ca
  let runtimeModule := escapeJs assets.runtimeModule
  let wasm := escapeJs assets.wasm
  let packageSet := escapeJs assets.packageSet
  let selector := escapeJs selector
  s!"<!DOCTYPE html>
<html>
<head>
<meta charset=\"utf-8\">
<style>
body \{ margin: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background: #f5f5f5; font-family: sans-serif; }
#anim-container \{ background: white; border: 1px solid #ddd; border-radius: 4px; padding: 10px; width: min(400px, 90vw); }
#anim-container svg \{ display: block; width: 100%; height: auto; max-width: 90vw; max-height: 70vh; }
.controls \{ margin-top: 12px; display: flex; align-items: center; gap: 8px; }
#anim-play \{ font-size: 18px; width: 36px; height: 36px; border: 1px solid #ccc; border-radius: 4px; background: white; cursor: pointer; }
#anim-scrub \{ width: 300px; }
#anim-status \{ margin-top: 8px; max-width: min(600px, 90vw); color: #9b1c1c; white-space: pre-wrap; }
</style>
</head>
<body>
<div id=\"anim-container\"></div>
<div class=\"controls\">
  <button id=\"anim-play\" aria-label=\"Play\">\u25B6</button>
  <input type=\"range\" id=\"anim-scrub\" min=\"0\" value=\"0\" aria-label=\"Animation progress\">
</div>
<div id=\"anim-status\" role=\"status\" data-state=\"loading\">Loading animation…</div>
<script type=\"module\">
import \{ createVirRuntime } from '{runtimeModule}';

const status = document.getElementById('anim-status');
let vir = null;
let player = null;
try \{
  vir = await createVirRuntime(\{
    wasmUrl: '{wasm}',
    irPackageSetUrl: '{packageSet}',
  });
  const mounted = vir.call(
    'Illuminate.Animation.Vir.mountStandalone',
    JSON.stringify({dataJson}),
    '{selector}',
    '#anim-play',
    '#anim-scrub',
    true,
  );
  if (mounted.kind !== 'ok') throw new Error(String(mounted.value));
  player = mounted.value;
  status.textContent = '';
  status.dataset.state = 'ready';
  status.hidden = true;
  window.addEventListener('pagehide', () => \{
    if (player !== null) vir.call('Illuminate.Animation.Vir.disposePlayer', player);
    vir.dispose();
  }, \{ once: true });
} catch (error) \{
  if (vir !== null) \{
    if (player !== null) vir.call('Illuminate.Animation.Vir.disposePlayer', player);
    vir.dispose();
  }
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = 'Animation failed: ' + message;
  status.dataset.state = 'error';
  status.hidden = false;
  console.error('Illuminate VIR player failed', error);
}
</script>
</body>
</html>"

/--
Renders animations as a side-by-side JavaScript and Lean runtime performance dashboard.

Every example is mounted twice from the same compiled animation data. The page
uses VIR by default, discovers an independently staged persistent FIR package,
and reports rolling callback FPS, persistent callback peaks, runtime phases, memory, and host rendering cost.
-/
def renderAnimationComparisonHTML
    (examples : Array (String × CompiledAnimation))
    (assets : VirPlayerAssets := {}) : String :=
  let dataJson := comparisonDataToJson examples
  let js := comparisonJs
    |>.replace "__ILLUMINATE_COMPARISON_DATA_98712__" dataJson
    |>.replace "__ILLUMINATE_COMPARISON_RUNTIME_98712__" (escapeJs assets.runtimeModule)
    |>.replace "__ILLUMINATE_COMPARISON_WASM_98712__" (escapeJs assets.wasm)
    |>.replace "__ILLUMINATE_COMPARISON_PACKAGE_SET_98712__" (escapeJs assets.packageSet)
  s!"<!DOCTYPE html>
<html lang=\"en\">
<head>
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
<title>Illuminate Animation Lab</title>
<style>
:root \{ color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #0b1020; color: #ecf1ff; }
* \{ box-sizing: border-box; }
body \{ margin: 0; min-width: 320px; background: radial-gradient(circle at 20% 0%, #172448 0, #0b1020 42rem); }
.hero \{ padding: 48px clamp(18px, 5vw, 72px) 30px; border-bottom: 1px solid #263458; }
.eyebrow \{ margin: 0 0 10px; color: #83a8ff; font-size: 12px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
h1 \{ margin: 0; max-width: 900px; font-size: clamp(32px, 5vw, 64px); line-height: .98; letter-spacing: -.045em; }
.lede \{ max-width: 780px; margin: 20px 0 0; color: #aebbd9; font-size: 16px; line-height: 1.65; }
.toolbar \{ display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 14px clamp(18px, 5vw, 72px); background: #0b1020; border-bottom: 1px solid #263458; }
[data-lab-panel][hidden], [data-analysis-control][hidden] \{ display: none !important; }
button \{ padding: 9px 14px; border: 1px solid #4a6fca; border-radius: 8px; background: #3158b2; color: white; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer; }
button:hover \{ background: #3b67cb; }
button.quiet \{ border-color: #344362; background: #172039; color: #c6d0e7; }
.auto \{ display: inline-flex; gap: 7px; align-items: center; color: #bdc8df; font-size: 13px; }
.auto.cycle \{ margin-right: auto; }
.auto input \{ accent-color: #6c91eb; }
.auto select \{ padding: 5px 7px; border: 1px solid #344362; border-radius: 6px; background: #172039; color: #c6d0e7; }
.toolbar #fixture-select \{ max-width: min(340px, 72vw); }
.profiling-toggle span \{ color: #8292b3; font-size: 11px; }
#comparison-status \{ color: #8ea2c7; font-size: 12px; }
.fixture-focus \{ width: min(100% - 36px, 1320px); margin: 22px auto; overflow: hidden; background: #11192d; border: 1px solid #2a3a61; border-radius: 16px; box-shadow: 0 16px 52px rgb(0 0 0 / .2); }
.fixture-focus > header \{ display: flex; flex-wrap: wrap; gap: 14px; align-items: center; padding: 16px 20px; border-bottom: 1px solid #263453; }
.fixture-focus > header div \{ margin-right: auto; }
.fixture-focus > header h2 \{ margin: 0; font-size: 17px; }
.fixture-focus > header p \{ margin: 4px 0 0; color: #8292b3; font-size: 10px; }
.fixture-focus select \{ min-width: min(320px, 100%); padding: 7px 9px; border: 1px solid #3a4c75; border-radius: 7px; color: #dce5ff; background: #172039; }
.fixture-matrix \{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.fixture-backend \{ min-width: 0; padding: 14px; }
.fixture-backend + .fixture-backend \{ border-left: 1px solid #263453; }
.fixture-backend h3 \{ display: flex; gap: 7px; align-items: center; margin: 0 0 9px; color: #c6d2ec; font-size: 10px; letter-spacing: .07em; text-transform: uppercase; }
.fixture-backend h3 em \{ margin-left: auto; color: #7183a7; font: 8px ui-monospace, monospace; text-transform: none; }
.fixture-backend[data-state=\"unavailable\"] \{ opacity: .78; }
.fixture-backend[data-state=\"unavailable\"] .stage \{ color: #91a1c0; background: #151f35; border: 1px dashed #405173; font-size: 11px; line-height: 1.55; text-align: center; }
.fixture-backend .stage \{ min-height: 172px; padding: 10px; }
.fixture-backend .stage svg \{ height: 150px; }
.engine-dot.llvm \{ background: #d7c45c; box-shadow: 0 0 12px #d7c45c; }
.fixture-focus > footer \{ display: grid; grid-template-columns: auto auto minmax(160px, 1fr) auto auto; gap: 10px; align-items: center; padding: 12px 20px; background: #0e1628; border-top: 1px solid #263453; }
.fixture-focus > footer input[type=\"range\"] \{ width: 100%; accent-color: #6c91eb; }
.fixture-focus > footer output \{ min-width: 76px; color: #8495b6; font: 11px ui-monospace, monospace; text-align: right; }
.fixture-focus [data-fixture-parity] \{ color: #74d4ae; font-size: 10px; }
.fixture-focus [data-fixture-parity].mismatch \{ color: #e8ba70; }
.sticky-peaks \{ position: sticky; z-index: 6; top: 0; display: flex; gap: 8px; align-items: stretch; justify-content: flex-end; min-height: 42px; padding: 5px clamp(18px, 5vw, 72px); background: #0b1020; border-bottom: 1px solid #2a395f; box-shadow: 0 6px 16px rgb(0 0 0 / .14); }
.sticky-peaks > span \{ display: grid; grid-template-columns: auto auto; gap: 0 7px; align-content: center; min-width: 108px; padding: 2px 7px; }
.sticky-peaks > span + span \{ border-left: 1px solid #2a395f; }
.sticky-peaks b \{ color: #8292b3; font-size: 8px; letter-spacing: .06em; text-transform: uppercase; }
.sticky-peaks strong \{ color: #f2f5ff; font: 700 12px ui-monospace, monospace; font-variant-numeric: tabular-nums; text-align: right; }
.sticky-peaks small \{ grid-column: 1 / -1; overflow: hidden; max-width: 170px; color: #7082a5; font: 8px ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
.sticky-peaks .js strong \{ color: #f4cc55; }
.sticky-peaks .candidate strong \{ color: #8fb0ff; }
.sticky-peaks .ratio \{ min-width: 72px; }
.sticky-peaks .peak-clear \{ align-self: center; padding: 5px 7px; font-size: 9px; }
.summaries \{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; width: min(100% - 36px, 1320px); margin: 24px auto; }
.summary \{ display: flex; gap: 22px; align-items: center; min-height: 90px; padding: 18px 22px; background: #121a30; border: 1px solid #2a395f; border-radius: 14px; box-shadow: 0 14px 40px rgb(0 0 0 / .18); }
.summary h2 \{ margin: 0 auto 0 0; font-size: 15px; }
.summary strong \{ display: block; font-size: 24px; font-variant-numeric: tabular-nums; }
.summary small \{ display: block; color: #8292b3; font-size: 10px; text-transform: uppercase; }
.aggregate-insights \{ grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr); gap: 20px; padding: 18px 22px; background: #121a30; border: 1px solid #2a395f; border-radius: 14px; box-shadow: 0 14px 40px rgb(0 0 0 / .18); }
.aggregate-insights h2 \{ margin: 0 0 3px; font-size: 13px; }
.aggregate-insights p \{ margin: 0; color: #8292b3; font-size: 10px; line-height: 1.45; }
.aggregate-overhead \{ margin: 10px 0 0; }
.aggregate-overhead .overhead-ratio \{ margin-top: 0; }
.aggregate-cpu \{ display: grid; gap: 8px; align-content: center; }
.aggregate-cpu-row \{ display: grid; grid-template-columns: 88px minmax(90px, 1fr) 54px; gap: 9px; align-items: center; }
.aggregate-cpu-row span:first-child \{ overflow: hidden; color: #aebbd9; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.aggregate-cpu-row output \{ color: #dce5ff; font: 700 11px ui-monospace, monospace; text-align: right; }
.aggregate-cpu-track \{ height: 7px; overflow: hidden; background: #0d1426; border-radius: 999px; }
.aggregate-cpu-track i \{ display: block; width: 0; height: 100%; border-radius: inherit; transition: width .2s ease; }
.aggregate-cpu-track .js \{ background: #f4cc55; }
.aggregate-cpu-track .candidate \{ background: #668fff; }
.aggregate-cpu-track .candidate.fir \{ background: #5bd6aa; }
.aggregate-phases \{ grid-column: 1 / -1; padding-top: 16px; border-top: 1px solid #263453; }
.aggregate-phases[hidden], .row-phase-comparison[hidden], .phase-metric[hidden] \{ display: none; }
.row-phase-comparison \{ padding: 16px 20px 18px; background: #10182b; border-top: 1px solid #263453; }
.row-phase-comparison .aggregate-phase-head strong \{ color: #dce5ff; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; }
.row-phase-comparison .aggregate-phase-head p \{ margin: 3px 0 0; color: #8292b3; font-size: 9px; }
.aggregate-phase-head \{ display: flex; gap: 14px; align-items: end; justify-content: space-between; }
.aggregate-phase-legend \{ display: flex; gap: 12px; color: #98a8c8; font-size: 9px; }
.aggregate-phase-legend span \{ display: inline-flex; gap: 5px; align-items: center; }
.aggregate-phase-legend i \{ width: 7px; height: 7px; border-radius: 2px; }
.aggregate-phase-legend .js \{ background: #f4cc55; }
.aggregate-phase-legend .candidate \{ background: #668fff; }
.aggregate-phase-legend .candidate.fir \{ background: #5bd6aa; }
.aggregate-phase-chart \{ display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 12px; margin-top: 14px; }
.aggregate-phase-group \{ display: grid; grid-template-rows: 128px auto; gap: 7px; min-width: 0; }
.aggregate-phase-group[data-aggregate-phase-group=\"callback\"], .aggregate-phase-group[data-row-phase-group=\"callback\"] \{ padding: 6px; background: #151f37; border: 1px solid #344362; border-radius: 8px; }
.aggregate-phase-bars \{ display: flex; gap: 6px; align-items: end; justify-content: center; padding: 0 5px 1px; border-bottom: 1px solid #344362; }
.aggregate-phase-column \{ display: flex; flex-direction: column; gap: 4px; align-items: center; justify-content: end; width: min(38%, 42px); height: 100%; }
.aggregate-phase-column output \{ color: #b7c3dc; font: 8px ui-monospace, monospace; white-space: nowrap; }
.aggregate-phase-column i \{ display: block; width: 100%; height: 0; min-height: 1px; border-radius: 4px 4px 1px 1px; transition: height .2s ease; }
.aggregate-phase-column.js i \{ background: #f4cc55; }
.aggregate-phase-column.candidate i \{ background: #668fff; }
.aggregate-phase-column.candidate.fir i \{ background: #5bd6aa; }
.aggregate-phase-label \{ overflow: hidden; color: #aebbd9; font-size: 9px; text-align: center; text-overflow: ellipsis; white-space: nowrap; }
#comparison-grid \{ display: grid; gap: 20px; width: min(100% - 36px, 1320px); margin: 0 auto 64px; }
.example \{ overflow: hidden; background: #11192d; border: 1px solid #28375a; border-radius: 16px; box-shadow: 0 16px 52px rgb(0 0 0 / .2); }
.example > header \{ display: flex; gap: 16px; align-items: center; justify-content: space-between; padding: 16px 20px; border-bottom: 1px solid #263453; }
.example > header > div:first-child \{ display: flex; gap: 12px; align-items: center; }
.number \{ color: #7086b1; font: 700 11px ui-monospace, monospace; }
.example h2 \{ margin: 0; font-size: 17px; }
.row-status \{ display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.row-status span \{ padding: 4px 7px; color: #93a4c4; background: #17213a; border: 1px solid #2b3a5c; border-radius: 999px; font-size: 10px; }
.row-status [data-dom-match] \{ color: #74d4ae; border-color: #23624f; }
.row-status [data-dom-match].mismatch \{ color: #e8ba70; border-color: #755622; }
.pair \{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.player \{ min-width: 0; padding: 16px 20px 18px; }
.player + .player \{ border-left: 1px solid #263453; }
.player h3 \{ display: flex; gap: 8px; align-items: center; margin: 0 0 12px; color: #c6d2ec; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.engine-dot \{ width: 8px; height: 8px; border-radius: 50%; }
.engine-dot.js \{ background: #f4cc55; box-shadow: 0 0 12px #f4cc55; }
.engine-dot.vir \{ background: #668fff; box-shadow: 0 0 12px #668fff; }
.engine-dot.fir \{ background: #5bd6aa; box-shadow: 0 0 12px #5bd6aa; }
.stage \{ display: grid; place-items: center; min-height: 238px; overflow: hidden; padding: 14px; background: #f8faff; border-radius: 10px; pointer-events: none; }
.stage svg \{ display: block; width: 100%; height: 210px; }
.metric \{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin-top: 12px; overflow: hidden; background: #263453; border: 1px solid #263453; border-radius: 8px; }
.metric span \{ min-width: 0; padding: 9px 10px; background: #151f37; }
.metric strong \{ display: block; overflow: hidden; color: #f2f5ff; font: 700 14px ui-monospace, monospace; text-overflow: ellipsis; }
.metric small \{ display: block; overflow: hidden; margin-top: 3px; color: #7586a7; font-size: 9px; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.overhead-ratio \{ display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px 12px; align-items: center; margin-top: 8px; padding: 9px 10px; background: #151f37; border: 1px solid #263453; border-radius: 8px; }
.overhead-ratio div \{ min-width: 0; }
.overhead-ratio strong \{ display: block; color: #f2f5ff; font: 700 15px ui-monospace, monospace; }
.overhead-ratio small \{ display: block; overflow: hidden; margin-top: 2px; color: #7586a7; font-size: 8px; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.overhead-ratio output \{ color: #98a8c8; font: 700 11px ui-monospace, monospace; }
.overhead-track \{ position: relative; grid-column: 1 / -1; height: 5px; overflow: hidden; background: #0d1426; border-radius: 999px; }
.overhead-track i \{ display: block; width: 0; height: 100%; background: linear-gradient(90deg, #f4cc55, #668fff); border-radius: inherit; transition: width .2s ease; }
.overhead-track b \{ position: absolute; top: 0; bottom: 0; left: 10%; width: 1px; background: #f4cc55; }
.overhead-ratio[data-overhead-state=\"faster\"] strong \{ color: #74d4ae; }
.overhead-ratio[data-overhead-state=\"slower\"] strong \{ color: #9ab4ff; }
.phase-metric \{ display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin-top: 8px; overflow: hidden; background: #263453; border: 1px solid #263453; border-radius: 8px; }
.phase-metric header \{ grid-column: 1 / -1; display: flex; justify-content: space-between; padding: 7px 10px; background: #11192d; }
.phase-metric header strong \{ color: #9ab4ff; font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.phase-metric header > span \{ display: flex; flex-direction: column; align-items: flex-end; padding: 0; background: transparent; }
.phase-metric header small \{ color: #7082a5; font: 9px ui-monospace, monospace; }
.phase-metric span \{ min-width: 0; padding: 7px 9px; background: #151f37; }
.phase-metric span strong \{ display: block; overflow: hidden; color: #dce5ff; font: 700 11px ui-monospace, monospace; text-overflow: ellipsis; }
.phase-metric span small \{ display: block; overflow: hidden; margin-top: 2px; color: #7586a7; font-size: 8px; text-overflow: ellipsis; text-transform: uppercase; white-space: nowrap; }
.example > footer \{ display: grid; grid-template-columns: auto auto minmax(140px, 1fr) auto; gap: 10px; align-items: center; padding: 12px 20px; background: #0e1628; border-top: 1px solid #263453; }
.example footer input \{ width: 100%; accent-color: #6c91eb; }
.example output \{ min-width: 74px; color: #8495b6; font: 11px ui-monospace, monospace; text-align: right; }
.method \{ width: min(100% - 36px, 1320px); margin: -42px auto 60px; color: #7889aa; font-size: 11px; line-height: 1.6; }
@media (max-width: 1080px) \{ .fixture-matrix \{ grid-template-columns: repeat(2, minmax(0, 1fr)); } .fixture-backend:nth-child(3) \{ border-top: 1px solid #263453; border-left: 0; } .fixture-backend:nth-child(4) \{ border-top: 1px solid #263453; } }
@media (max-width: 980px) \{ .sticky-peaks \{ justify-content: flex-end; } }
@media (max-width: 780px) \{ .pair, .summaries, .aggregate-insights, .fixture-matrix \{ grid-template-columns: 1fr; } .aggregate-phase-chart \{ grid-template-columns: repeat(3, minmax(0, 1fr)); row-gap: 18px; } .player + .player, .fixture-backend + .fixture-backend \{ border-top: 1px solid #263453; border-left: 0; } .fixture-focus > footer, .example > footer \{ grid-template-columns: 1fr 1fr; } .fixture-focus > footer input[type=\"range\"], .example footer input \{ grid-column: 1 / -1; } .example output \{ display: none; } .summary \{ min-height: 74px; } .sticky-peaks \{ justify-content: stretch; } .sticky-peaks > span \{ min-width: 0; flex: 1; } .sticky-peaks small \{ display: none; } }
</style>
</head>
<body data-ready=\"false\">
<header class=\"hero\">
  <p class=\"eyebrow\">Illuminate Animation Lab</p>
  <h1>One animation, every runtime.</h1>
  <p class=\"lede\">Play one fixture across every ready backend, then inspect the same JavaScript and Lean execution side by side. The selected fixture, view, campaign scope, backend, and timing mode are shareable URL state.</p>
</header>
<nav class=\"toolbar\" aria-label=\"Comparison controls\">
  <label class=\"auto\">View <select id=\"comparison-view\"><option value=\"playback\">Side-by-side playback</option><option value=\"analysis\">Detailed runtime analysis</option></select></label>
  <label class=\"auto\">Fixture <select id=\"fixture-select\" aria-label=\"Animation fixture\"></select></label>
  <label class=\"auto\" data-analysis-control hidden>Scope <select id=\"comparison-scope\"><option value=\"selected\">Selected fixture</option><option value=\"all\">All 16 fixtures</option></select></label>
  <button id=\"comparison-start\" data-analysis-control hidden type=\"button\">Play / advance scope</button>
  <button id=\"comparison-pause\" data-analysis-control hidden class=\"quiet\" type=\"button\">Pause scope</button>
  <button id=\"comparison-reset\" data-analysis-control hidden class=\"quiet\" type=\"button\">Reset scope</button>
  <label class=\"auto cycle\"><input id=\"comparison-auto-cycle\" type=\"checkbox\" checked> Auto-cycle pauses and completed animations</label>
  <label class=\"auto\" data-analysis-control hidden>Candidate backend <select id=\"comparison-backend\"><option value=\"vir-selection\">Lean · VIR selection</option><option value=\"vir-full\">Lean · VIR full</option><option value=\"fir\" disabled>Lean · FIR selection — persistent package required</option></select></label>
  <label class=\"auto profiling-toggle\" data-analysis-control hidden><input id=\"comparison-vir-timing\" type=\"checkbox\" aria-controls=\"comparison-grid aggregate-phases\" aria-expanded=\"false\"> Detailed callback phases <span>adds measurement overhead</span></label>
  <span id=\"comparison-status\" data-state=\"loading\">Loading one shared VIR runtime…</span>
</nav>
<section class=\"fixture-focus\" id=\"fixture-matrix\" data-lab-panel=\"playback\" aria-label=\"Four-backend animation fixture\">
  <header><div><h2>Selected fixture · four backend slots</h2><p>All ready players receive the same commands. Missing compiler artifacts remain visible as unavailable slots.</p></div></header>
  <div class=\"fixture-matrix\">
    <article class=\"fixture-backend\" data-fixture-backend=\"js\" data-state=\"loading\"><h3><span class=\"engine-dot js\"></span>JavaScript <em data-fixture-state>loading</em></h3><div class=\"stage\" data-fixture-stage=\"js\"></div></article>
    <article class=\"fixture-backend\" data-fixture-backend=\"vir\" data-state=\"loading\"><h3><span class=\"engine-dot vir\"></span>Lean · VIR <em data-fixture-state>loading</em></h3><div class=\"stage\" data-fixture-stage=\"vir\"></div></article>
    <article class=\"fixture-backend\" data-fixture-backend=\"fir\" data-state=\"loading\"><h3><span class=\"engine-dot fir\"></span>Lean · FIR <em data-fixture-state>loading</em></h3><div class=\"stage\" data-fixture-stage=\"fir\"></div></article>
    <article class=\"fixture-backend\" data-fixture-backend=\"llvm\" data-state=\"unavailable\"><h3><span class=\"engine-dot llvm\"></span>Lean · LLVM <em data-fixture-state>package not staged</em></h3><div class=\"stage\" data-fixture-stage=\"llvm\"><span>Awaiting an Illuminate FIR-LLVM/Emscripten artifact.</span></div></article>
  </div>
  <footer><button id=\"fixture-advance\" type=\"button\">Play / advance</button><button id=\"fixture-pause\" class=\"quiet\" type=\"button\">Pause</button><input id=\"fixture-scrub\" type=\"range\" min=\"0\" value=\"0\" aria-label=\"Shared focused animation frame\"><output id=\"fixture-frame\">0 / 0</output><span data-fixture-parity>waiting for players</span></footer>
</section>
<div data-lab-panel=\"analysis\" hidden>
<section class=\"sticky-peaks\" aria-label=\"Persistent callback peaks\">
  <span class=\"js\"><b>JS run peak</b><strong data-sticky-peak=\"js\">—</strong><small data-sticky-peak-detail=\"js\">waiting for callbacks</small></span>
  <span class=\"candidate\"><b><span data-sticky-candidate-name>VIR selection</span> peak</b><strong data-sticky-peak=\"candidate\">—</strong><small data-sticky-peak-detail=\"candidate\">waiting for callbacks</small></span>
  <span class=\"ratio\"><b>peak ratio</b><strong data-sticky-peak-ratio>—</strong><small>independent high-water marks</small></span>
  <button id=\"comparison-clear-peaks\" class=\"quiet peak-clear\" type=\"button\">Clear</button>
</section>
<section class=\"summaries\" aria-label=\"Aggregate statistics\">
  <article class=\"summary\" data-summary=\"js\"><span class=\"engine-dot js\"></span><h2>JavaScript aggregate</h2><span><strong data-summary-stat=\"fps\">0.0</strong><small>mean active FPS</small></span><span><strong data-summary-stat=\"cpu\">0.0%</strong><small>one-core share</small></span><span><strong data-summary-stat=\"peak\">—</strong><small>run peak callback</small></span></article>
  <article class=\"summary\" data-summary=\"candidate\"><span class=\"engine-dot vir\"></span><h2>Lean · VIR selection aggregate</h2><span><strong data-summary-stat=\"fps\">0.0</strong><small>mean active FPS</small></span><span><strong data-summary-stat=\"cpu\">0.0%</strong><small>one-core share</small></span><span><strong data-summary-stat=\"peak\">—</strong><small>run peak callback</small></span><span><strong data-summary-stat=\"ratio\">—</strong><small>callback / paired JS</small></span></article>
  <article class=\"aggregate-insights\">
    <section><h2>Aggregate callback overhead</h2><p>Whole candidate callback against the paired JavaScript callback; the gold marker is 1×.</p><div class=\"aggregate-overhead\" data-aggregate-overhead data-overhead-state=\"waiting\"><div class=\"overhead-ratio\"><div><strong data-overhead-value>—</strong><small>candidate / paired JavaScript</small></div><output data-overhead-detail>waiting for paired callbacks</output><span class=\"overhead-track\"><i data-overhead-fill></i><b title=\"JavaScript baseline\"></b></span></div></div></section>
    <section class=\"aggregate-cpu\"><h2>Rolling one-core share</h2><p>Paired bars use the larger current share as their visual scale.</p><div class=\"aggregate-cpu-row\"><span>JavaScript</span><span class=\"aggregate-cpu-track\"><i class=\"js\" data-aggregate-cpu-fill=\"js\"></i></span><output data-aggregate-cpu-value=\"js\">0.0%</output></div><div class=\"aggregate-cpu-row\"><span data-aggregate-candidate-name>VIR selection</span><span class=\"aggregate-cpu-track\"><i class=\"candidate\" data-aggregate-cpu-fill=\"candidate\"></i></span><output data-aggregate-cpu-value=\"candidate\">0.0%</output></div></section>
    <section class=\"aggregate-phases\" id=\"aggregate-phases\" data-aggregate-phases hidden>
      <div class=\"aggregate-phase-head\"><div><h2>Aggregate detailed runtime analyzer</h2><p data-aggregate-phase-note>Paired bars share one linear millisecond scale; independently timed phases are not stacked.</p></div><div class=\"aggregate-phase-legend\"><span><i class=\"js\"></i>JavaScript</span><span><i class=\"candidate\" data-aggregate-candidate-legend></i><span data-aggregate-candidate-name>VIR selection</span></span></div></div>
      <div class=\"aggregate-phase-chart\">
        <div class=\"aggregate-phase-group\" data-aggregate-phase-group=\"callback\"><div class=\"aggregate-phase-bars\"><span class=\"aggregate-phase-column js\"><output data-aggregate-phase-value=\"js\">0.000</output><i data-aggregate-phase-fill=\"js\"></i></span><span class=\"aggregate-phase-column candidate\" data-aggregate-phase-candidate-column><output data-aggregate-phase-value=\"candidate\">0.000</output><i data-aggregate-phase-fill=\"candidate\"></i></span></div><span class=\"aggregate-phase-label\" data-aggregate-phase-label>whole callback</span></div>
        <div class=\"aggregate-phase-group\" data-aggregate-phase-group=\"marshal\"><div class=\"aggregate-phase-bars\"><span class=\"aggregate-phase-column js\"><output data-aggregate-phase-value=\"js\">0.000</output><i data-aggregate-phase-fill=\"js\"></i></span><span class=\"aggregate-phase-column candidate\" data-aggregate-phase-candidate-column><output data-aggregate-phase-value=\"candidate\">0.000</output><i data-aggregate-phase-fill=\"candidate\"></i></span></div><span class=\"aggregate-phase-label\" data-aggregate-phase-label>input</span></div>
        <div class=\"aggregate-phase-group\" data-aggregate-phase-group=\"execute\"><div class=\"aggregate-phase-bars\"><span class=\"aggregate-phase-column js\"><output data-aggregate-phase-value=\"js\">0.000</output><i data-aggregate-phase-fill=\"js\"></i></span><span class=\"aggregate-phase-column candidate\" data-aggregate-phase-candidate-column><output data-aggregate-phase-value=\"candidate\">0.000</output><i data-aggregate-phase-fill=\"candidate\"></i></span></div><span class=\"aggregate-phase-label\" data-aggregate-phase-label>execute</span></div>
        <div class=\"aggregate-phase-group\" data-aggregate-phase-group=\"decode\"><div class=\"aggregate-phase-bars\"><span class=\"aggregate-phase-column js\"><output data-aggregate-phase-value=\"js\">0.000</output><i data-aggregate-phase-fill=\"js\"></i></span><span class=\"aggregate-phase-column candidate\" data-aggregate-phase-candidate-column><output data-aggregate-phase-value=\"candidate\">0.000</output><i data-aggregate-phase-fill=\"candidate\"></i></span></div><span class=\"aggregate-phase-label\" data-aggregate-phase-label>decode</span></div>
        <div class=\"aggregate-phase-group\" data-aggregate-phase-group=\"rewind\"><div class=\"aggregate-phase-bars\"><span class=\"aggregate-phase-column js\"><output data-aggregate-phase-value=\"js\">0.000</output><i data-aggregate-phase-fill=\"js\"></i></span><span class=\"aggregate-phase-column candidate\" data-aggregate-phase-candidate-column><output data-aggregate-phase-value=\"candidate\">0.000</output><i data-aggregate-phase-fill=\"candidate\"></i></span></div><span class=\"aggregate-phase-label\" data-aggregate-phase-label>rewind</span></div>
        <div class=\"aggregate-phase-group\" data-aggregate-phase-group=\"host\"><div class=\"aggregate-phase-bars\"><span class=\"aggregate-phase-column js\"><output data-aggregate-phase-value=\"js\">0.000</output><i data-aggregate-phase-fill=\"js\"></i></span><span class=\"aggregate-phase-column candidate\" data-aggregate-phase-candidate-column><output data-aggregate-phase-value=\"candidate\">0.000</output><i data-aggregate-phase-fill=\"candidate\"></i></span></div><span class=\"aggregate-phase-label\" data-aggregate-phase-label>DOM apply</span></div>
        <div class=\"aggregate-phase-group\" data-aggregate-phase-group=\"adapter\"><div class=\"aggregate-phase-bars\"><span class=\"aggregate-phase-column js\"><output data-aggregate-phase-value=\"js\">0.000</output><i data-aggregate-phase-fill=\"js\"></i></span><span class=\"aggregate-phase-column candidate\" data-aggregate-phase-candidate-column><output data-aggregate-phase-value=\"candidate\">0.000</output><i data-aggregate-phase-fill=\"candidate\"></i></span></div><span class=\"aggregate-phase-label\" data-aggregate-phase-label>outer gap</span></div>
      </div>
    </section>
  </article>
</section>
<main id=\"comparison-grid\"></main>
<p class=\"method\">FPS, CPU, mean, and p95 use a rolling two-second window. Run peaks and slow-callback totals persist until cleared or the candidate backend changes. “Callback FPS” counts animation callbacks, not distinct source frames. Main-thread CPU is synchronous callback wall time divided by the sampling window, so it includes player decisions, runtime work, and DOM patching but excludes browser paint and compositing. Each overhead badge divides candidate mean callback time by the JavaScript player beside it; its gold marker is 1× and its bar is capped at 10×. Selection-only VIR and FIR share the JavaScript renderer and show setup separately from steady-state dispatch; full VIR retains its original Lean-owned patch path. Use the figures comparatively, not as a machine-independent benchmark.</p>
</div>
<script type=\"module\">
{js}
</script>
</body>
</html>"

/--
Renders a Reveal snippet whose fragment playback is owned by a shared VIR runtime.

Multiple snippets using the same assets reuse one runtime. Each snippet retains
an independent player handle and releases it when the page is hidden.
-/
def CompiledAnimation.renderVirRevealHTML
    (ca : CompiledAnimation)
    (selector : String)
    (assets : VirPlayerAssets := {}) : String :=
  let dataJson := compiledAnimationToJson ca
  let js := virRevealJs
    |>.replace "__ILLUMINATE_DATA_98712__" dataJson
    |>.replace "__ILLUMINATE_SELECTOR_98712__" (escapeJs selector)
    |>.replace "__ILLUMINATE_VIR_RUNTIME_98712__" (escapeJs assets.runtimeModule)
    |>.replace "__ILLUMINATE_VIR_WASM_98712__" (escapeJs assets.wasm)
    |>.replace "__ILLUMINATE_VIR_PACKAGE_SET_98712__" (escapeJs assets.packageSet)
  s!"<script type=\"module\">\n{js}\n</script>"

/-- Renders a {name}`CompiledAnimation` as a {lit}`<script>` snippet that initializes playback into
    the first element matching the given CSS selector. Designed for embedding in reveal.js
    slides or any page with multiple animations. -/
def CompiledAnimation.renderRevealHTML (ca : CompiledAnimation)
    (selector : String) : String :=
  let dataJson := compiledAnimationToJson ca
  let sel := escapeJs selector
  let js := revealJs
    |>.replace "__ILLUMINATE_DATA_98712__" dataJson
    |>.replace "__ILLUMINATE_SELECTOR_98712__" sel
  s!"<script>\n{js}\n</script>"
