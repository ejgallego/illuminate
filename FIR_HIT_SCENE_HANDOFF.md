# FIR-native prepared hit-scene handoff

## Goal

Compile Illuminate's real prepared hit-test query for use by the
`#diagram` InfoView widget. The browser should retain one compact
immutable scene and send only two `Float` coordinates for each pointer
query. React continues to own the widget, SVG installation,
`ResizeObserver`, and screen-to-diagram coordinate conversion.

Do not copy the hit-test algorithm into the adapter, flatten paths in
JavaScript, transfer SVG or rendering styles, or add adapter-side
semantic translations.

The Illuminate work is on the `feat/vir-performance` branch. The FIR
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

Illuminate currently uses Lean `v4.33.0-rc2`, while the completed FIR
wasm-generation lane is pinned to Lean `v4.32.0`. Report this
compatibility issue before changing either repository's toolchain or
rewriting the entry.

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
    kind: ("tag", value, label);
}
```

Nullary results must not manufacture Lean kind strings or empty
labels.

## Adapter contract

Please expose an API along these lines:

```js
const adapter = await fetchIlluminateHitSceneAdapter(url);
const created = adapter.createHitScene(encodedScene);
const result = adapter.hitTest(created.scene, x, y);
adapter.disposeHitScene(created.scene);
```

Recommended capability name:

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

Illuminate's current differential test prepares a mixed scene,
round-trips its transport, and checks the prepared result against
`Diagram.hitTest` over 295 points.

## VIR finding

A direct `@[vir_export]` probe of the same query was rejected because
its closure reaches unsupported `Float.abs` through path/stroke
tracing. The same native-extern gap is present in the local
`origin/main` VIR reference
`ff3216873f918f057a766558a784ceac492b57a9`; it is not caused by the
older Illuminate-private VIR checkout. The closure also uses square
root and trigonometric operations for curves and arcs.

Do not work around this with per-operation JavaScript `Math.*` host
imports: those crossings would dominate the workload we are trying to
measure. FIR is the immediate integration route; VIR can follow when
its native Float-math surface supports this closure.
