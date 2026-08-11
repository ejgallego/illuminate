# FIR-native prepared hit-scene handoff

## Current v2 regeneration request

Illuminate has accepted conservative prepared-path bounds at this
clean, published functional revision:

```text
repository: git@github.com:ejgallego/illuminate.git
branch:     feat/vir-hit-scene
revision:   88dcfee895a55e804641bff485024cffec1b5419
toolchain:  leanprover/lean4:v4.33.0-rc2
```

The real entry remains unchanged:

```lean
Illuminate.HitScene.query :
  HitScene → Float → Float → HitSceneResult
```

The browser API operations may remain
`fir.illuminate-hit-scene.browser/v1`, but the accepted input-layout
capability must now be:

```text
lean-4.32-Illuminate.HitScene/v2
```

`HitPrimitive.path` has four new retained `Float` fields after its
existing payload:

```lean
| path (data : PathData) (hasFill : Bool) (strokeWidth : Float)
    (left right bottom top : Float)
```

`HitScene.encode` exposes them as the JSON properties `left`, `right`,
`bottom`, and `top`. Encode those four binary64 values once with the
resident scene. Do not recompute bounds, drop fields, or implement
query semantics in the adapter. The per-query boundary remains only
the retained scene handle and two bit-exact `Float` coordinates.

The exact source inventory is:

```text
1e51512bbe246654cfb8b1c16b40101c659e91d6bbe9bb0745b8b11257ff997e  src/Illuminate/Diagram/HitScene.lean
c2e4e0cf31a291c5d04f13dfae3f82b78f9fb519f3ae1c48058a7db2149c137d  src/Illuminate/Diagram/HitTest.lean
21956218724ce7deb9ef00354c01261f33dc17c294b013c69494ea8374997a16  src/Illuminate/Geometry/Trace.lean
92dc894058d3e4a5e08d2a5a1fc3bf1d47bdfd52aa3ff1ec8226bdd04a265793  src/Illuminate/Geometry/PathData.lean
ed63356e5f21cd40b5b653510f20fb71e54b89b4072d848a5a58a66bd4b4d1d0  src/Illuminate/Geometry/Types.lean
28cd47a7d678913ed0d22eeb6284637bfa99860bf760e2225bbd31dec1af80a3  src/Illuminate/Geometry/Matrix.lean
```

The regenerated fixtures are:

```text
6a599bf13b9aa3dde0a463f0fea4961021241629b31889058c805d66c5d7b0a1  test_output/hit-scene-benchmark.json
45ee28cbd2eb0ffc0e83e88fbfd9587a5bc325afa638f477837fb38cbf11676d  test_output/hit-scene-benchmark-suite.json
```

The suite still contains 83 bounds, 301 mixed, and 625 path-heavy
oracle queries. Old and new VIR packages matched every query in an
order-balanced comparison. The bounded VIR median was neutral on the
bounds fixture, 3.42× faster on mixed geometry, and 21.74× faster on
the path-heavy scene.

The v1 FIR package must not be reused. Its first observed mismatch
with the v2 scene was:

```text
fixture:  mixed-medium
query:    grid-8-5
xBits:    0
yBits:    13844628204490326016
expected: {"kind":"tag","value":1,"label":"back"}
actual:   {"kind":"something"}
```

Illuminate now rejects the v1 layout in staging, Node measurement, and
the live browser loader. `--vir-only` is available while the v2
package is pending.

Please regenerate the self-contained, zero-import package from the
published revision, preserve the resident checkpoint and untimed plus
diagnostic query paths, and return the immutable package directory,
FIR commit, BUILD capabilities, complete/base Wasm hashes and sizes,
export list, source inventory, and smoke result. Illuminate will run:

```sh
ILLUMINATE_FIR_HIT_SCENE_DIR=/absolute/immutable/v2-package \
  npm run stage:fir-hit-scene
npm run test:fir-hit-scene-package
npm run test:fir-hit-scene-host
npm run measure:hit-scene -- --suite --quick --require-fir
```

The prepared consumer also provides a single acceptance command:

```sh
ILLUMINATE_FIR_HIT_SCENE_DIR=/absolute/immutable/v2-package \
  npm run accept:fir-hit-scene
```

It atomically stages the admitted package, checks the host lifecycle,
runs the Lean tests that generate the fixtures, checks all 1,009
distinct oracle queries across the three workload tiers, records a
compact FIR/VIR history entry in
`test_output/hit-scene-performance-history.jsonl`, and refreshes the
showcase. A differential mismatch stops the command before a history
entry is written.

## Historical compiler-admission context

The remainder of this file records the original v1 compiler and
runtime-package requirements. Where it conflicts with the v2 request
above, the v2 revision, hashes, and input layout take precedence.

The compiler-admission slice and its W6 lazy-cache result-kind proof
are linked and accepted on FIR `main`. The acceptance commit is
`4d91fb0d`; the current FIR `main` observed by Illuminate is
`31b9290c`. Illuminate independently verified the accepted probe
artifacts:

```text
159 reachable declarations
34 externals
0 unsupported declarations
311 runtime operations
126 base functions
no lowering error
```

The published probe digests match exactly:

```text
fa08b94db107dce57202532500df60c1b9180e9679c0aeb814f0e4861b0f475f  hit-scene-probe.json
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  hit-scene-unsupported.lcnf
476fec8fe1c2ed9bf89f9848e90ddb0bd2f0b385c32e8b1072246776f838209c  hit-scene-partial-application.lcnf
```

This is a compiler/lowering acceptance, not a runtime-package handoff.
FIR currently publishes no `illuminate-hit-scene.wasm`, browser
adapter, stable input-layout contract, or external-engine differential
result. Illuminate's staging gate must continue to reject the
compiler-demo directory. W7 can now use the admitted closure for the
resident-math and immutable-package slice after its current
object-carrier/provenance work.

## Accepted closure and shared fixture

The real closure reaches all eight of these operations:

```text
Float.abs
Float.sqrt
Float.sin
Float.cos
Float.acos
Float.atan2
Float.cbrt
Float.floor
```

The newly observed path is:

```text
Illuminate.HitScene.query
→ Illuminate.HitScene.hitTest
→ Illuminate.HitTree.hitTest
→ Illuminate.HitPrimitive.hitTest
→ pointOnStroke
→ Illuminate.StrokeTrace.ofPathData
→ pathDataHits
→ rayCubicBezier
→ cubicRootsInUnitInterval
→ Float.cbrt
```

The second observed path is:

```text
Illuminate.HitScene.query
→ Illuminate.HitScene.hitTest
→ Illuminate.HitTree.hitTest
→ Illuminate.HitPrimitive.hitTest
→ pointOnStroke
→ Illuminate.StrokeTrace.ofPathData
→ pathDataHits
→ rayArc
→ List.forIn'.loop
→ Float.floor
```

FIR's accepted inventory includes these externals. Do not replace them
with adapter code or JavaScript imports. If resident linking exposes
another missing operation, report its exact closure path before adding
a workaround.

Illuminate now publishes a runtime-neutral fixture at
`test_output/hit-scene-benchmark.json` with schema
`illuminate.hit-scene-benchmark/v1`. It contains a 4,088-byte encoded
scene and 301 bit-exact oracle queries: 296 mixed-geometry reference
queries plus signed zero on each axis, the binary64 predecessor and
successor of a boundary, and a fractional negative-coordinate case.
Its declared coverage includes every `HitTree`, `HitPrimitive`, and
`PathCmd` constructor, both labeled and unlabeled tags, bounds
prepared from text/styled text/images, fills, strokes, lines, cubics,
and arcs.

Use the same fixture for FIR correctness. Measure the production query
through an untimed adapter path; collect input/execute/decode/rewind
phases in a separate diagnostic pass so observer and timing-object
allocation do not inflate the headline FIR/JavaScript/VIR comparison.

## Goal

Compile Illuminate's real prepared hit-test query for use by the
`#diagram` InfoView widget. The browser should retain one compact
immutable scene and send only two `Float` coordinates for each pointer
query. React continues to own the widget, SVG installation,
`ResizeObserver`, and screen-to-diagram coordinate conversion.

Do not copy the hit-test algorithm into the adapter, flatten paths in
JavaScript, transfer SVG or rendering styles, or add adapter-side
semantic translations.

The active Illuminate work is on `feat/vir-hit-scene`, continuing the
published `ejgallego/feat/vir-performance` source line. The FIR
package must pin a clean immutable Illuminate revision from the
`ejgallego` remote; do not open a pull request.

## Entry

Compile this real Lean declaration:

```lean
Illuminate.HitScene.query :
  HitScene → Float → Float → HitSceneResult
```

The definitions live in:

```text
src/Illuminate/Diagram/HitScene.lean
src/Illuminate/Diagram/HitTest.lean
```

The current source hashes are:

```text
a37e5a8af3c5477c445b9d123d767eb719ab6f351e5dd9abf8914919959fe7f2  src/Illuminate/Diagram/HitScene.lean
8e8b73223cf3867fc1e7e5b9bba0c49cc94f2a0a07c6a881d55ece6259f8c3cb  src/Illuminate/Diagram/HitTest.lean
21956218724ce7deb9ef00354c01261f33dc17c294b013c69494ea8374997a16  src/Illuminate/Geometry/Trace.lean
92dc894058d3e4a5e08d2a5a1fc3bf1d47bdfd52aa3ff1ec8226bdd04a265793  src/Illuminate/Geometry/PathData.lean
ed63356e5f21cd40b5b653510f20fb71e54b89b4072d848a5a58a66bd4b4d1d0  src/Illuminate/Geometry/Types.lean
28cd47a7d678913ed0d22eeb6284637bfa99860bf760e2225bbd31dec1af80a3  src/Illuminate/Geometry/Matrix.lean
```

Recompute and pin all source hashes from the accepted clean revision
rather than trusting this prose after the branch advances.

FIR successfully captured the clean Illuminate source at
`af088e313eaade90be100aeaf63ddac79a8c1710` with Lean `v4.32.0`, while
the active Illuminate/VIR worktree uses Lean `v4.33.0-rc2`. The source
compatibility gate is therefore resolved for that immutable revision.
Do not change either repository's toolchain or rewrite the entry when
producing the package.

## Data boundary

`HitScene` contains only:

- a recursive `HitTree` preserving tags, front-to-back composition,
  inverse transforms, and clips;
- prepared path or bounds primitives;
- path commands and their scalar geometry; and
- an array of numeric tag/label pairs.

It deliberately omits SVG, fills and strokes that cannot affect hits,
text contents after their bounds are prepared, images, names,
envelopes, warnings, opacity, arrows, and backend values. Inverse
matrices and text/image bounds are computed once by Illuminate before
crossing the boundary.

`HitScene.encode` is the canonical one-time widget transport. The
browser adapter may parse that JSON in JavaScript and encode the
corresponding Lean graph once below the resident checkpoint. Do not
compile or call the Lean JSON decoder on the hot path.

The query coordinates must cross as bit-exact binary64 values with no
string, integer, `Float32`, or JSON conversion.

`HitSceneResult` is intentionally an allocation-conscious custom
inductive:

```lean
inductive HitSceneResult where
  | nothing
  | something
  | tag (value : Nat) (label : String)
```

The adapter should normalize these constructors to the widget's
established objects:

```js
{
    kind: "nothing";
}
{
    kind: "something";
}
{
    kind: "tag";
    value: number;
    label: string;
}
```

Nullary results must not manufacture value or label payloads.

## Adapter contract

Please expose an API along these lines:

```js
const adapter = await fetchIlluminateHitSceneAdapter(url);
const created = adapter.createHitScene(encodedScene);
const result = adapter.hitTest(created.scene, x, y);
adapter.disposeHitScene(created.scene);
```

Provisional capability name, to be confirmed by the executable package
handoff:

```text
fir.illuminate-hit-scene.browser/v1
```

Each opaque scene may own its own synchronous `WebAssembly.Instance`,
as in the selection-player v4 adapter. Encode the immutable scene once
below a checkpoint. Query results live in bounded scratch, are
decoded, cleared, and rewound after every call. Disposal is idempotent
and invalidates the handle. Two widgets must remain isolated.

Report non-overlapping timings for:

- one-time JSON parse/projection;
- one-time scene sizing and encoding;
- Wasm instantiation;
- per-query input handling;
- entry execution;
- result decoding;
- scratch clearing/rewind; and
- independently measured total and residual overhead.

The target remains zero function imports, zero memory imports,
module-owned memory, a bounded resident frontier, and no
application-visible Wasm address.

## Acceptance

1. Compile the real `Illuminate.HitScene.query` closure without a
   copied implementation.
2. Cover every `HitTree`, `HitPrimitive`, `PathCmd`, and
   `HitSceneResult` constructor.
3. Differentially compare the original `Diagram.hitTest`, the
   encoded/decoded `HitScene`, and FIR over transformed, clipped,
   tagged, layered, text, styled-text, image, line, cubic, and arc
   cases.
4. Include non-integral and negative coordinates, signed zero, misses,
   untagged hits, labeled tags, and tags without labels.
5. Keep the heap frontier exactly flat over at least 10,000 queries.
6. Test replacement/disposal, two simultaneous scenes, repeated
   create/dispose, and use-after-dispose rejection.
7. Report complete/base Wasm sizes and hashes, exact imports/exports,
   retained source declarations and helpers, unresolved operations,
   source hashes, toolchain identity, and raw timing data.
8. Publish an immutable package directory plus `BUILD.json`,
   `SHA256SUMS`, a smoke test, and the browser adapter. Do not land it
   or open a PR.

## Illuminate-side performance measurement

After staging an accepted immutable package, run the shared VIR/FIR
measurement rather than timing the FIR adapter in isolation:

```sh
ILLUMINATE_FIR_HIT_SCENE_DIR=/absolute/path/to/immutable/package \
  npm run stage:fir-hit-scene
npm run measure:hit-scene -- --require-fir
npm run stage:hit-scene-performance
```

The machine-readable report is
`test_output/hit-scene-performance.json`; serve
`test_output/hit-scene-performance.html` to inspect the production
latency ratio and side-by-side diagnostic phase bars. The runner uses
the same retained 4,088-byte scene, binary64 coordinates, expected
results, warm-up, measured query order, and process for both backends.
It retains all raw production and diagnostic samples and reports the
paired FIR/VIR ratio for each matching query and round. This paired
ratio, rather than absolute measurements taken at different times, is
the primary comparison.

Production wall-clock sampling and detailed phase profiling are
separate passes. VIR uses `runtime.call` in the production pass and
`runtime.callTimed` only in the diagnostic pass. The proposed v1 FIR
adapter returns phase timings from its normal `hitTest` method; if the
published package retains that behavior, the report records the
instrumentation asymmetry rather than presenting its result as a
perfectly timing-free comparison.

Illuminate's current differential test prepares a mixed scene,
round-trips its transport, and checks the prepared result against
`Diagram.hitTest` over the 301 fixture queries described above.

## VIR comparison status

The VIR experiment now validates the intended retained boundary: the
complete typed scene crosses once, while each query sends only an
opaque handle and two bit-exact binary64 coordinates. All eight Float
operations are implemented on VIR `feat/float-geometry-math` at
`e39b1cdd`, and the complete 301-query oracle passes. The combined VIR
PR #103 validation head `f85dfa5` additionally keeps Wasm memory fixed
at 4 MiB through the strict 10,000-query workload. This provides the
executable comparison lane while FIR builds the native package; both
runtimes execute the same Lean algorithm.
