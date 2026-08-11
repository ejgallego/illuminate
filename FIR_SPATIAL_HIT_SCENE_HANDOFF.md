# FIR handoff: spatial HitScene package

This task uses branch-only coordination. Keep the work on a named
`ejgallego/lean-fir` branch and do not open a pull request.

## Objective

Produce a separately versioned FIR-native browser package for
Illuminate's real spatial HitScene implementation. Illuminate will use
it to complete this apples-to-apples matrix:

| Algorithm            | VIR       | FIR                 |
| -------------------- | --------- | ------------------- |
| Reference `HitScene` | available | accepted v2 package |
| `SpatialHitScene`    | available | requested here      |

Do not replace or mutate the accepted reference package. Do not
implement spatial preparation or hit testing in the adapter.

## Reproducible source

Consume Illuminate read-only from:

```text
repository: git@github.com:ejgallego/illuminate.git
branch:     feat/vir-hit-scene
revision:   3b912826fdb39b27e214b3fef91c2b08c000bfea
```

Required source hashes:

```text
1e51512bbe246654cfb8b1c16b40101c659e91d6bbe9bb0745b8b11257ff997e  src/Illuminate/Diagram/HitScene.lean
a6b20101413d47bb467ec2b4cc56d7943340633341a3140b6886ae34665999b6  src/Illuminate/Diagram/HitScene/Spatial.lean
21956218724ce7deb9ef00354c01261f33dc17c294b013c69494ea8374997a16  src/Illuminate/Geometry/Trace.lean
92dc894058d3e4a5e08d2a5a1fc3bf1d47bdfd52aa3ff1ec8226bdd04a265793  src/Illuminate/Geometry/PathData.lean
ed63356e5f21cd40b5b653510f20fb71e54b89b4072d848a5a58a66bd4b4d1d0  src/Illuminate/Geometry/Types.lean
28cd47a7d678913ed0d22eeb6284637bfa99860bf760e2225bbd31dec1af80a3  src/Illuminate/Geometry/Matrix.lean
```

`SpatialVir.lean` is a VIR resource wrapper and is not the FIR entry.
Compile the underlying real declarations:

```lean
Illuminate.SpatialHitScene.ofHitScene : HitScene → SpatialHitScene
Illuminate.SpatialHitScene.query :
  SpatialHitScene → Float → Float → HitSceneResult
```

## Required boundary

At `createHitScene`, project the canonical encoded `HitScene` once,
execute `SpatialHitScene.ofHitScene` inside compiled Lean, and retain
the resulting `SpatialHitScene`. Do not construct guards, rebalance
compositions, transform bounds, or otherwise reproduce
`prepareTreeCore` in JavaScript.

Each steady-state query transfers only the retained spatial scene
handle and two bit-exact binary64 coordinates. Return a copied
`HitSceneResult`; expose no Wasm address.

Use a separately advertised browser capability such as:

```text
browser API:  fir.illuminate-spatial-hit-scene.browser/v1
input layout: lean-4.32-Illuminate.SpatialHitScene/v1
ownership:    fir.illuminate-spatial-hit-scene.persistent-checkpoint/v1
```

The logical browser operations should match the reference host:

```text
createHitScene(encodedHitScene)
hitTest(scene, x, y)
hitTestDiagnostic(scene, x, y)
disposeHitScene(scene)
```

Keep an ordinary untimed query path for production and a separate
diagnostic path for phase data. Report input/projection, spatial
preparation, query execution, result decoding, checkpoint rewind, and
total wall time without moving work outside the measured boundary.

## Shared oracle

Use these exact runtime-neutral fixtures:

```text
6a599bf13b9aa3dde0a463f0fea4961021241629b31889058c805d66c5d7b0a1  test_output/hit-scene-benchmark.json
45ee28cbd2eb0ffc0e83e88fbfd9587a5bc325afa638f477837fb38cbf11676d  test_output/hit-scene-benchmark-suite.json
```

The suite contains 83 bounds, 301 mixed, and 625 path-heavy queries.
It covers all `HitTree`, `HitPrimitive`, and `PathCmd` constructors,
transformations, clips, labels, signed zero, adjacent boundary floats,
and fractional negative coordinates.

## Acceptance

1. Reference Lean, reference VIR, spatial VIR, reference FIR, and
   spatial FIR agree on all 1,009 oracle queries.
2. Spatial preparation executes once per retained scene, never per
   query.
3. Coordinates preserve their exact IEEE-754 binary64 payloads.
4. Two concurrent spatial scenes remain isolated.
5. Disposal is idempotent and repeated create/dispose cycles retain no
   scene graph.
6. A 10,000-query run has stable checkpoint and memory behavior after
   warmup.
7. The Wasm has zero function and memory imports and owns its memory.
8. Production timing is free of diagnostic clocks and timing-record
   allocation.
9. Balanced measurements rotate reference/spatial and VIR/FIR order,
   verify every result, and report paired median, p95, absolute delta,
   creation cost, resident bytes, and Wasm size.
10. Package checksums and a package-local smoke test pass before
    handoff.

The browser live probe uses 16-query paired batches and a 120-batch
rolling window. Once staged, spatial FIR will be added as the fourth
engine so the UI can show runtime and algorithm deltas without
conflating them.

## Return to Illuminate

Return the named `ejgallego/lean-fir` branch and exact head, immutable
package path, FIR/toolchain/source revisions, manifest and capability
versions, complete/base Wasm hashes and sizes, import/export list,
preparation and resident-memory measurements, query phase definitions,
raw balanced benchmark results, and every acceptance result.
