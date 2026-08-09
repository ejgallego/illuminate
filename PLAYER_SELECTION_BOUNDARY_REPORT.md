# Animation player selection-boundary comparison

## Result

Illuminate's FIR v4 player is close to the JavaScript reference when
both use the same browser-owned animation data and the same DOM
renderer. In a balanced three-run browser sample over all 16 showcase
animations, the median of the per-run mean callback cost was 0.040 ms
for JavaScript and 0.062 ms for FIR. FIR therefore added about 0.022
ms per active callback, or 1.55× the JavaScript callback cost. All 16
rendered SVG DOMs matched in every observation.

The current VIR lane averaged 0.531 ms against a 0.055 ms JavaScript
reference in the same harness. This is useful as an end-to-end runtime
measurement, but it is not yet the same boundary: VIR still owns the
patch tables, computes updates, and calls the host patch operations
from interpreted Lean. It should not be used to estimate the overhead
of a selection-only VIR design.

## Matched boundary

The JavaScript and FIR columns now call the exact same
`createSelectionDomRenderer`. It retains the original `AnimData`
JavaScript object, installs `segment.sync` when the selected segment
changes, and reads `segment.pmap` and `segment.params[localFrame]`
directly to apply text and attribute updates. Neither lane converts or
copies those SVG documents, bindings, or parameter strings.

The only semantic difference before rendering is who selects the
frame:

| Concern               | JavaScript reference       | FIR selection v4                           |
| --------------------- | -------------------------- | ------------------------------------------ |
| Original `AnimData`   | retained as a JS object    | retained as a JS object                    |
| SVG, bindings, values | never converted            | never transferred to Wasm                  |
| Timeline preparation  | direct field access        | compact bounds and steps encoded once      |
| Per-tick input        | timestamp already in JS    | one tagged event with binary64 timestamp   |
| Playback decision     | JavaScript functions       | compiled Lean state machine                |
| Per-tick output       | six-field selection object | same six-field selection decoded from Wasm |
| DOM application       | shared renderer            | shared renderer                            |

The FIR module cannot retain an arbitrary JavaScript object inside its
module-owned linear memory. Instead, its adapter keeps the object on
the host and transfers only the compact timeline projection needed by
Lean. This gives the same important data-ownership property without
pretending that a host object is a Wasm value. VIR can express the
corresponding ownership more directly with an opaque `Js` value.

## Measurement

The structured browser harness uses a fresh browser context per
backend observation, alternates backend order, runs three 3-second
observations per backend, and takes the median of each observation's
mean across 16 active players. Phase timing was enabled. The callback
includes synchronous player and DOM work but excludes painting and
compositing. Values below are medians from this acceptance sample:

| Phase              | JavaScript beside FIR |        FIR v4 | JavaScript beside VIR |              Current VIR |
| ------------------ | --------------------: | ------------: | --------------------: | -----------------------: |
| Input encoding     |              0.000 ms |     0.0066 ms |              0.000 ms |                0.0047 ms |
| Decision / execute |             0.0018 ms |     0.0148 ms |             0.0029 ms |                0.5075 ms |
| Output decoding    |              0.000 ms |     0.0135 ms |              0.000 ms |                0.0019 ms |
| Rewind             |              0.000 ms |     0.0009 ms |              0.000 ms |                 0.000 ms |
| Host rendering     |             0.0304 ms |     0.0111 ms |             0.0427 ms | 0.2052 ms within execute |
| Outer adapter      |             0.0077 ms |     0.0107 ms |             0.0087 ms |                0.0125 ms |
| Whole callback     |         **0.0399 ms** | **0.0618 ms** |         **0.0550 ms** |            **0.5308 ms** |

The host renderer is literally shared, but its sub-0.05 ms samples
vary with browser timer quantization, segment changes, and scheduling.
The whole-callback absolute delta and the encoded/execute/decode split
are more useful than comparing the two host-rendering cells directly.
Phase observation is itself diagnostic overhead and is disabled in the
normal showcase.

Run the measurement with:

```sh
npm run measure:live-dashboard -- --duration-ms 3000 --runs 3
```

It writes the raw observations and summaries to
`test_output/perf/live-dashboard-phases.json`.

## Direction for VIR

The next fair experiment is a selection-only VIR player with the same
contract as FIR v4:

1. Keep the original animation object, SVG strings, patch bindings,
   and parameter rows in JavaScript.
2. Give Lean only the compact timeline needed for playback decisions.
   If the runtime API benefits from it, retain the host animation as
   an opaque `Js AnimData` resource rather than normalize the large
   object graph.
3. Return only frame, step, segment, local frame, segment-change, and
   playback status from a retained callback.
4. Feed that selection to `createSelectionDomRenderer` and measure it
   with the same balanced harness.

That experiment will isolate VIR's callback dispatch, compact scalar
marshalling, and interpretation cost. It also keeps the JavaScript,
VIR, and FIR implementations aligned at the data boundary without
duplicating animation semantics in their adapters.

For FIR, bulk marshaling is no longer the priority. The remaining
roughly tens-of-microseconds gap is distributed across small event
encoding, compiled Lean execution, selection decoding, and adapter
bookkeeping. Selection decoding was the largest boundary subphase in
this sample. Any next optimization should keep the six-field typed
result and ownership checks, then reduce generic object allocation or
conversion within that narrow adapter path.
