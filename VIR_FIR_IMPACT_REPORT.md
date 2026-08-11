# VIR and FIR impact on Illuminate

Date: 2026-08-10

## Executive result

VIR and FIR have moved Illuminate toward one Lean implementation of
each browser-facing semantic component, but they have different costs
and roles.

- For animation, JavaScript remains the migration oracle. VIR and FIR
  execute the same Lean player. The fair steady-state comparison is
  the selection-only boundary, where all three lanes retain the
  original animation object and use the same JavaScript DOM renderer.
- FIR selection is currently much closer to the JavaScript callback
  cost: recent paired browser campaigns put FIR at about 1.5–2.1×
  JavaScript and VIR selection at about 5.7–6.4×. Full VIR, which also
  constructs patches and crosses into the DOM from interpreted Lean,
  is about 9–11× JavaScript.
- For hit testing, there was never a JavaScript geometry
  implementation to replace. The original widget mapped coordinates in
  JavaScript and called the Lean server. The useful compiler
  comparison is therefore VIR versus FIR over the same prepared Lean
  `HitScene`, with server RPC as the transport baseline.
- The retained boundaries have already removed the largest avoidable
  hot-path conversions. Animation ticks no longer transfer SVG,
  parameter maps, or parameter strings. Hit-scene queries transfer
  only a handle, two binary64 coordinates, and a small result.
- This is not yet a source-size win. The research branch adds 35,062
  net lines, of which 27,233 are generated bundles, tests, measurement
  code, and reports. It also keeps every legacy JavaScript player as a
  compatibility oracle or fallback. The value today is semantic
  consolidation and measured boundary design, not repository
  shrinkage.
- Cold delivery is the clearest current VIR disadvantage. The staged
  generic runtime plus animation package closure is about 1.51 MB raw
  before the widget bundle, versus a 56 KB self-contained FIR
  animation Wasm. VIR amortizes its runtime across widgets using the
  same package set, while FIR specializes a module to one entry
  closure; the figures are a packaging ledger, not a pure
  compiler-size comparison.

The immediate runtime-side opportunities are persistent
interpreter-resolution work for VIR, compact resident-state/result
handling for FIR, and less duplication in VIR widget delivery.

### Post-checkpoint implementation

Immediately after this report's frozen checkpoint, the production
`#animate` widget was moved to the measured selection-only VIR host.
It now passes the original `AnimData` object directly to the compact
typed projection, retains SVG and parameter tables in the browser,
uses the shared JavaScript selection renderer, and imports the same
revision-keyed InfoView runtime service as `#diagram`. The generated
bundle asserts that `mountSelectionPlayer` is present and the old
`mountInfoView` full-player entry is absent.

The source and performance ledgers below remain frozen at `aa9985b` so
they can be reproduced exactly. A fresh production InfoView campaign
is the next measurement rather than silently mixing post-checkpoint
code into the earlier figures.

## Scope and identities

The source ledger compares the original Illuminate baseline with the
checkpoint immediately before this report:

```text
baseline:    006dc1d1db18c5dc73d637c926cf132e88df05b5
checkpoint:  aa9985b0938e94921b406f2cf80619e3d2c8c7c9
branch:      ejgallego/feat/vir-hit-scene
Lean:        leanprover/lean4:v4.33.0-rc2
Node:        v24.18.0
```

The staged VIR runtime is 735,658 bytes with SHA-256
`45187c73a265dd438ab5b44165c8a150f06c88163e57ad7babbfa63a209bd945`. It
was built from the repository-local VIR stack ending at
`f85dfa5238eb61c28b9c45371c5429a798e6e9fa`, which includes Float
geometry externs and the PR #103 resource-lifetime fix.

The accepted FIR selection artifact is the scalar-tick v4 package
built from FIR `ac7467f3af9598400be1f175510aff339ac6113a`. Its
56,156-byte Wasm has SHA-256
`8b13c8124ba7235e2a00cec154f42d406e6f568f071f51ec831bbb95486ae3f5`. It
is zero-import, owns its memory, and exposes the generic transition as
the oracle beside a bit-exact scalar tick entry.

No accepted FIR HitScene executable exists at this checkpoint. A
provisional dirty W7 artifact was 45,382 bytes and zero-import, but
its smoke test trapped on the first query. It was not staged and
contributes no FIR HitScene performance claim below.

## What is being compared

| Component   | Original semantics                 | VIR execution                                 | FIR execution                                       | Browser responsibility                                        |
| ----------- | ---------------------------------- | --------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------- |
| Animation   | JavaScript player                  | Same Lean player, interpreted                 | Same Lean player, native Wasm                       | RAF ownership, SVG selection and patching in the matched lane |
| Hit testing | Lean `Diagram.hitTest` through RPC | Prepared Lean `HitScene`, interpreted locally | Prepared Lean `HitScene`, native Wasm when accepted | Pointer-to-SVG coordinate mapping and hover UI                |

This distinction prevents a misleading “JavaScript versus Lean”
HitScene chart. A JavaScript callback that returns fixture answers
would measure a dispatch stub, not Illuminate's geometry. JavaScript
is a valid semantic baseline for animation because the original state
machine really was written there.

## Codebase impact

### Repository delta

These are physical added/deleted lines from `git diff --numstat`,
grouped by responsibility. Generated output is deliberately not mixed
with handwritten source.

| Category                                           |      Added | Deleted |         Net |
| -------------------------------------------------- | ---------: | ------: | ----------: |
| Lean under `src/`, including integration/demo code |      2,329 |      59 |      +2,270 |
| Handwritten browser/runtime adapters               |      2,071 |      14 |      +2,057 |
| Browser showcases and type declarations            |      3,060 |       2 |      +3,058 |
| Generated browser bundles                          |     14,870 |       0 |     +14,870 |
| Tests, staging, and measurement tools              |      7,549 |      15 |      +7,534 |
| Reports and documentation                          |      4,814 |       2 |      +4,812 |
| Configuration and lockfiles                        |        465 |       4 |        +461 |
| **Total**                                          | **35,158** |  **96** | **+35,062** |

The `src/` row includes a 142-line diagnostic memory-probe module. The
branch is intentionally a performance laboratory: generated bundles
plus tests, measurements, and reports account for 77% of all
additions. All `src/` changes and handwritten runtime adapters account
for about 12.5%.

### Handwritten semantic and boundary code

| File or group                                  | Physical lines | Role                                                                     |
| ---------------------------------------------- | -------------: | ------------------------------------------------------------------------ |
| `Animation/Player.lean`                        |            602 | Validated player model, state machine, selections, patches, trace oracle |
| `Animation/Vir.lean`                           |            536 | Retained VIR players, DOM/full-player exports, selection exports         |
| `Animation/FirLive.lean` + `FirSelection.lean` |            131 | Small FIR-facing entry façades over the same player                      |
| `Diagram/HitScene.lean`                        |            271 | Prepared rendering-independent geometry, result, transport codec         |
| `Diagram/HitScene/Vir.lean`                    |             32 | Retained typed VIR mount/query/dispose boundary                          |
| `vir_selection_player.js`                      |            285 | Selection-only scheduling and typed VIR host                             |
| `fir_live_player.js`                           |            335 | FIR scheduling, lifecycle, and shared selection renderer host            |
| `vir_hit_scene.js`                             |            322 | One-time scene projection and retained VIR host                          |
| `fir_hit_scene.js`                             |            217 | FIR host contract, lifecycle, and RPC measurement helper                 |

The FIR-specific Lean surface is small because FIR compiles ordinary
Lean entries. VIR needs more application code today because its full
player also owns DOM resources, event listeners, callbacks, and
`RuntimeRef` state. The 32-line HitScene VIR module shows how small
the VIR surface becomes when the boundary is already a retained pure
object plus scalar calls.

Line counts should not be read as language productivity. `Player.lean`
contains validation, compatibility wrappers, two action shapes, and
differential-test entries that the old 158-line `anim_core.js` did
not. The benefit is one testable semantic source shared by standalone,
Reveal, InfoView, VIR, and FIR adapters.

## JavaScript retired, retained, and added

No JavaScript file has been deleted from the repository. Retirement is
by active responsibility, not yet by physical deletion.

| JavaScript                      | Status                | Consequence                                                                                                                                                            |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anim_core.js` (158 lines)      | Retained              | Still drives legacy standalone and Reveal players and is the differential oracle; it is no longer embedded in the active `#animate` widget.                            |
| `animate_widget.js` (260 lines) | Retained but inactive | The old InfoView playback component is replaced by the generated VIR widget module. Keeping it currently provides a readable browser oracle.                           |
| `standalone.js` (192 lines)     | Retained              | The default `renderHTML` path is still JavaScript. VIR/FIR variants are additive.                                                                                      |
| `reveal.js` (158 lines)         | Retained              | The default Reveal path is still JavaScript; `vir_reveal.js` is the narrow VIR adapter.                                                                                |
| `diagram_widget.js`             | Expanded, not retired | Coordinate mapping, controls, React lifecycle, and hover display stay in JavaScript. Hit geometry moves from server RPC to retained VIR by default, with RPC fallback. |

At the baseline, the active animation InfoView module concatenated 418
lines and 14,635 raw bytes of `anim_core.js` plus `animate_widget.js`.
The current generated VIR animation widget is 6,655 lines and 245,345
raw bytes. Thus the semantic JavaScript has left the active path, but
the generic runtime adapter has increased the shipped module
substantially.

The same pattern is visible in `#diagram`: the baseline widget source
was 10,064 raw bytes; the generated VIR-enabled bundle is 261,881 raw
bytes. This includes generic VIR runtime code and is not a 26×
increase in handwritten diagram logic. The handwritten source itself
moved from 279 to 473 lines, mostly for runtime acquisition, backend
selection, replacement, disposal, and RPC fallback.

The appropriate later cleanup is:

1. move the inactive animation widget to an explicit
   compatibility-oracle location after the selection player becomes
   the production path;
2. keep `anim_core.js` until standalone and Reveal migration is
   complete; and
3. keep the HitScene RPC fallback even after FIR arrives, because it
   is a useful availability and semantic control rather than duplicate
   geometry code.

## Conversion and ownership impact

### Animation

The first FIR-native player encoded the entire browser animation
graph. On the 621,193-byte morphing fixture, creation took 24.711 ms,
encoding took 21.335 ms, and the resident animation graph occupied
997,480 bytes.

The selection boundary changed the unit of transfer. The browser
retains SVG sync frames, parameter bindings, and all parameter
strings. Lean receives only FPS, total frames, segment bounds, and
step metadata. On the same fixture:

| FIR creation measurement | Full-action v3 | Selection v4 |  Improvement |
| ------------------------ | -------------: | -----------: | -----------: |
| Creation wall            |      24.711 ms |     0.104 ms |   about 238× |
| Input encoding           |      21.335 ms |     0.012 ms | about 1,778× |
| Resident animation graph |      997,480 B |        648 B | about 1,539× |
| Median tick wall         |       0.031 ms |     0.009 ms |   about 3.4× |

The selection-only VIR lane uses the same logical boundary. Its host
projects the compact timeline once and retains both the original
JavaScript animation and a Lean player handle. Per tick, the boundary
is a typed `PlayerEvent` in and a six-field `FrameSelection` plus
scheduling decision out. Materializing the chosen patch row and
applying it to the DOM is shared with JavaScript and FIR.

FIR's scalar `dispatchTick(player, timestamp)` removes the custom
event object from the hottest path. It transports the exact IEEE-754
bits over an `i64` and constructs `.tick` inside Wasm. In the focused
Node benchmark it removes all 40 bytes of tick scratch, reduces event
encoding by 62–64%, and improves median whole-tick time by 4.6–8.8%.

The design deliberately did **not** rewrite every `Nat` as `UInt32`.
Inputs are validated once as safe non-negative integers, and the
semantic model stays in its natural Lean types. This avoids a new
layer of casts whose cost and correctness risk were not supported by
the profile.

At the frozen checkpoint, production `#animate` still ran
`JSON.stringify(animData)`, parsed that string back into
`CompiledAnimation`, and used the full VIR DOM-owning path. The
post-checkpoint implementation described above removes all three from
the active widget while preserving the original browser-owned data.

### HitScene

The original widget sent coordinates through InfoView RPC on every
debounced pointer movement. Geometry was Lean already, so this paid
transport and server scheduling rather than JavaScript geometry.

The new path prepares rendering-independent geometry once, including
inverse transforms, and retains it in the browser runtime. A query
transfers only:

```text
retained scene handle + Float x + Float y -> HitSceneResult
```

For the 44,610-byte path-heavy scene, diagnostic marshal and decode
medians are about 0.010 ms and 0.020 ms respectively. The scene size
no longer appears in the query boundary.

One mount-time conversion is still redundant. Lean currently
serializes the scene to a JSON string, the widget transports that
string inside its props, JavaScript calls `JSON.parse`, and the VIR
host projects it to canonical typed objects. Passing a structured
widget value directly to the VIR/FIR adapter would remove the string
encoding, double escaping, parse, and projection walk. This is a
cold/replacement optimization; it will not improve the hot query,
where execution already dominates.

## Runtime performance

### Animation: matched selection boundary

The browser harness runs all 16 animations, balances backend order,
uses fresh contexts, and includes synchronous patch materialization
and DOM application while excluding later paint and compositing.
Ratios are paired with the JavaScript player in the same observation
because absolute sub-millisecond timings vary substantially with
browser load.

| Candidate     | Paired callback ratio to JavaScript | Recent range | Interpretation                                              |
| ------------- | ----------------------------------: | -----------: | ----------------------------------------------------------- |
| FIR selection |                               1.65× |   1.49–2.13× | Compiled transition is close; encoding/state decode remains |
| VIR selection |                               6.11× |   5.65–6.35× | Interpreted transition dominates                            |
| VIR full      |                              10.32× |  9.59–11.10× | Interpreter plus Lean-owned patch/DOM path                  |

One phase-instrumented representative sample measured:

| Phase                | VIR selection | FIR selection |
| -------------------- | ------------: | ------------: |
| Input marshal/encode |     0.0113 ms |     0.0084 ms |
| Execute              |     0.1067 ms |     0.0178 ms |
| Decode               |     0.0108 ms |     0.0166 ms |
| Shared DOM apply     |     0.0098 ms |     0.0142 ms |
| Whole callback       | **0.1537 ms** | **0.0739 ms** |

Selection-only VIR is about 32% cheaper than full VIR at the
whole-callback level and about 50% cheaper in interpreted execution.
Retained `JSL` plus `RuntimeRef` ownership accounts for only about
6–9% of paired VIR execute time. Returning state across every call is
slower overall than retaining it, so removing `RuntimeRef` is not the
next optimization.

For FIR, detailed attribution found that reading returned
`PlayerState` and writing the persistent state slot account for 42–46%
of `decodeMs`. JavaScript result construction is below 1%. A generated
in-place resident-state update or compact state/result ABI is
therefore more valuable than hand-optimizing the host's result object.

### HitScene: completed FIR/VIR comparison

The latest untimed production run over the 301-query mixed fixture
measured a 0.443 ms median VIR query after warmup. The diagnostic
profiler shows how cost scales with geometry:

| Workload     |    Scene |  VIR wall |  Marshal |   Execute |   Decode |
| ------------ | -------: | --------: | -------: | --------: | -------: |
| Bounds-small |    558 B |  0.092 ms | 0.005 ms |  0.053 ms | 0.007 ms |
| Mixed-medium |  4,088 B |  1.946 ms | 0.008 ms |  1.841 ms | 0.011 ms |
| Paths-large  | 44,610 B | 19.550 ms | 0.010 ms | 19.462 ms | 0.020 ms |

The diagnostic calls are intentionally instrumented and are not
comparable to the untimed production median. Their phase shares are
the useful result: boundary conversion remains in the tens of
microseconds while Lean execution accounts for more than 99% of the
path-heavy workload. Misses are especially expensive because they
traverse the full front-to-back tree and applicable paths.

The final zero-import FIR HitScene package is now consumed and passes
its 10,005-query ownership and differential gate. Paired untimed
production measurements give:

| Workload     | VIR median | FIR median | FIR / VIR | FIR speedup |
| ------------ | ---------: | ---------: | --------: | ----------: |
| Bounds-small |   0.018 ms |   0.003 ms |     18.5% |        5.4× |
| Mixed-medium |   0.871 ms |   0.063 ms |      7.3% |       13.7× |
| Paths-large  |  10.288 ms |   0.540 ms |      5.2% |       19.1× |

The speedup grows with geometry complexity while only two Float
coordinates cross either retained boundary. This attributes most of
the VIR cost to interpreter execution rather than marshalling. FIR
also shows that the shared path-heavy algorithm still has a real 0.54
ms native cost, leaving prepared bounds as an independent Illuminate
optimization.

The animation scalar-tick experiment reaches the same conclusion from
the other direction. Replacing a typed `PlayerEvent.tick` with a bare
Float cuts VIR marshal time from about 1.8–1.9 µs to 0.6–0.7 µs, but
saves only 0.3–0.5 µs end to end. Production keeps the generic event
protocol; no VIR marshalling API request is warranted.

## Artifact and delivery size

### Runtime artifacts

| Artifact                                   | Raw bytes | gzip-9 equivalent | Reuse model                                                                       |
| ------------------------------------------ | --------: | ----------------: | --------------------------------------------------------------------------------- |
| FIR selection Wasm                         |    56,156 |      about 12,189 | Specialized module; compiled module shared, one memory-owning instance per player |
| FIR generated adapter + host + Wasm        |   114,157 |      about 24,678 | Animation-specific                                                                |
| VIR runtime Wasm                           |   735,658 |     about 169,954 | Generic runtime                                                                   |
| VIR animation package closure, 37 members  |   775,220 |     about 116,061 | Animation-specific IR over generic runtime                                        |
| VIR runtime + animation descriptor/closure | 1,514,963 |     about 287,348 | Shared by widgets using that exact package set                                    |
| VIR animation assets + generated widget    | 1,760,308 |     about 331,899 | Current fully charged animation widget                                            |

The raw VIR runtime-plus-package figure is about 27× the FIR Wasm.
That ratio combines two different product shapes: VIR ships a reusable
interpreter and Lean IR; FIR ships a closed native module with only
the resident helpers for the requested entries. It nevertheless
represents the bytes Illuminate must currently deliver.

In the InfoView, staged VIR binary assets are returned as base64
through RPC, not as gzip-compressed static files. The animation
runtime, descriptor, and 37 members total 1,514,963 binary bytes and
about 2,020,004 base64 characters. The HitScene set plus another
runtime totals 924,361 binary bytes and about 1,232,520 base64
characters.

The runtime service is revision-keyed and shared among multiple
widgets that use the same package-set path. Animation and HitScene
currently use different package sets, so they also create distinct
services and transfer/instantiate the same runtime Wasm separately.
Likewise, the generated animation and diagram widget bundles each
contain a copy of generic VIR JavaScript. Combining package sets or
separating the reusable runtime module from widget entries is the
largest clear code-delivery opportunity.

Cold size is not steady-state speed. Once mounted, neither VIR nor FIR
moves the animation payload or HitScene on every call.

## Correctness and lifecycle impact

The port has made browser/runtime correctness much more explicit than
the old widget implementations:

- 107 animation traces match across legacy JavaScript, VIR JSON, VIR
  typed, VIR selection, VIR scalar tick, FIR full-action, and FIR
  selection lanes.
- Coverage includes all six `PlayerEvent` constructors, exact and
  adjacent binary64 timestamps, pause/loop boundaries, replay, reverse
  navigation, text content, and ordinary SVG attributes.
- Browser campaigns preserve 16/16 rendered SVG matches.
- HitScene's mixed fixture checks 301 queries against the original
  `Diagram.hitTest`; the tiered suite adds 83 bounds-only and 625
  path-heavy queries.
- Lifecycle tests cover simultaneous players, cancellation,
  replacement, idempotent disposal, use-after-release, and runtime
  teardown.
- After VIR PR #103, 10,000 mixed HitScene queries remain at the
  initial 4,194,304-byte Wasm memory size. Minimal fill and stroke
  result loops remain flat through 50,000 calls.

The compatibility contract is observable behavior on valid generated
animations. Lean validation intentionally rejects malformed structures
that the JavaScript implementation happened to tolerate. Lean also
validates once, classifies `textContent` versus attributes once,
reserves patch capacity, caches the rendered segment, advances
ordinary step lookup incrementally, and uses binary search for
arbitrary seeks. These are internal divergences that remove repeated
work without changing valid traces.

## Assessment

### What VIR contributes

- Direct use of ordinary Lean code in the browser, including typed DOM
  and retained JavaScript-resource ownership.
- The easiest integration path for InfoView and Reveal lifecycle work.
- A reusable runtime that can host multiple Lean modules and makes
  ownership bugs observable through realistic asynchronous workloads.
- Higher warm execution cost for short calls because the Lean
  transition is interpreted. In the matched animation lane, execution
  is now the dominant VIR overhead; marshal/decode representation work
  is secondary.
- A significant generic-runtime, package, and generated-bundle cold
  footprint in the current InfoView delivery design.

### What FIR contributes

- Near-JavaScript execution for the animation transition once the
  boundary is compact.
- Small, zero-import, self-contained modules with explicit memory
  ownership.
- Generated adapters with exact layouts and deterministic package
  metadata.
- More compiler/runtime work to close over Lean's runtime operations
  and to support persistent state safely.
- Remaining per-call overhead concentrated in generated encoding and
  state/result synchronization rather than the transition itself.

### What Illuminate has learned

The dominant optimization was not changing Lean numeric types or
translating more code. It was choosing the right ownership boundary:

```text
browser owns large immutable display data
runtime owns compact semantic state
hot calls exchange scalars and small selections
browser applies the selected display row
```

That boundary made FIR competitive with JavaScript and cut VIR work
substantially. It also gives VIR and FIR the same semantic and DOM
controls, which is more valuable than comparing unrelated adapters.

## Recommended next actions

1. **Measure production selection-only `#animate` (implementation
   complete).** Confirm that its mount and callback costs agree with
   the comparison lane and that multiple InfoView widgets reuse one
   runtime service.
2. **Accept and measure FIR HitScene without a workaround.** Run the
   existing tiered paired harness only after a clean package passes
   smoke, 301-query parity, two-instance disposal, and the
   10,000-query frontier gate.
3. **Remove one-time string transports.** Pass animation timelines and
   HitScenes as structured objects directly where VIR/FIR's typed
   object support permits it. Measure mount/replacement separately
   from hot calls.
4. **Deduplicate VIR delivery.** Share the runtime loader and
   generated runtime JavaScript across widget bundles, and investigate
   one runtime/package service for animation plus HitScene rather than
   transferring the Wasm twice.
5. **Keep runtime optimization ownership clear.** VIR should target
   repeated interpreter entry and resolution; FIR should target
   in-place resident-state updates and a genuinely timing-free
   dispatch; Illuminate should avoid application casts or semantic
   duplication to compensate for either.
6. **Optimize HitScene only after FIR attribution.** The first
   algorithmic candidate is a prepared bounding box before path
   fill/stroke work, followed by subtree bounds or a spatial index.
   Full-scene misses are the sensitive benchmark class.
7. **Retire legacy JS in stages.** First make the selection path
   production, then move the old InfoView component to test fixtures,
   and delete shared animation JavaScript only after standalone and
   Reveal use Lean semantics.

## Reproduction

Source ledger:

```sh
git diff --numstat 006dc1d1db18c5dc73d637c926cf132e88df05b5..aa9985b0938e94921b406f2cf80619e3d2c8c7c9
wc -l src/Illuminate/Animation/Player.lean \
  src/Illuminate/Animation/Vir.lean \
  src/Illuminate/Animation/FirLive.lean \
  src/Illuminate/Animation/FirSelection.lean \
  src/Illuminate/Diagram/HitScene.lean \
  src/Illuminate/Diagram/HitScene/Vir.lean
```

Animation correctness and measurements:

```sh
npm run test:player-traces
npm run measure:vir-selection-core
npm run measure:fir-live
npm run measure:live-dashboard -- --duration-ms 3000 --runs 3
```

HitScene correctness and measurements:

```sh
npm run test:vir-hit-scene
npm run profile:vir-hit-scene
npm run measure:hit-scene-backends
```

The structured HitScene results used here are
`test_output/hit-scene-performance.json` and
`test_output/vir-hit-scene-profile.json`. Animation campaign details
and raw protocol caveats are preserved in
`PLAYER_PERFORMANCE_CONSOLIDATION.md` and
`PLAYER_SELECTION_BOUNDARY_REPORT.md`.
