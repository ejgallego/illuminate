# VIR API request: native `Float` math for geometric queries

## Accepted implementation

All eight operations required by the measured Illuminate closure are
now implemented on VIR branch `feat/float-geometry-math` at
`e39b1cdd8f3be5105ff515c3b488a8aa81b6d345`:

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

Illuminate's repository-local VIR checkout is clean and detached at
that commit. The real retained hit-scene package now generates
successfully with 21 package-set members, format 10, 296 declarations
(243 Lean IR and 53 native externs), and exactly the intended `mount`,
`query`, and `dispose` interface exports. The 301-query semantic
oracle passes, including cubics, arcs, signed zero, and the two
boundary-adjacent binary64 values. There are no remaining closure
dependencies to request.

Long-running validation did expose a separate VIR memory-retention
problem in path tracing. That is documented independently in
`VIR_HIT_SCENE_MEMORY_REPORT.md`; it does not change the accepted math
surface.

## Follow-up from the real closure

The original six operations below landed on the local VIR
`feat/float-geometry-math` branch at
`4bf199b8c655a4db91cc82a756af7134841d536e`. Package generation now
advances through those operations and stops at one additional
dependency:

```lean
Float.cbrt : Float → Float
```

The exact closure path is:

```text
Illuminate.HitScene.Vir.query
→ Illuminate.HitScene.query
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

Please register this existing Lean declaration as one
`.float → .float` native extern using the `cbrt` native symbol. This
is exercised by the real cubic-stroke fixture; it is not a speculative
expansion of the requested math surface. After it lands, Illuminate
will rerun package generation and report the next exact closure
dependency, if any.

The pending `cbrt` implementation has now been applied to Illuminate's
private VIR checkout. Package generation advances through cubic roots
and exposes the next exact dependency:

```lean
Float.floor : Float → Float
```

```text
Illuminate.HitScene.Vir.query
→ Illuminate.HitScene.query
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

Please register `Float.floor` as one `.float → .float` native extern
using the `floor` native symbol. Arc tracing uses it to normalize
angles. As with the other operations, keep it inside the restricted
native registry rather than a JavaScript host import.

## Request

Please add VIR native-extern support for these existing Lean
declarations:

```lean
Float.abs   : Float → Float
Float.sqrt  : Float → Float
Float.sin   : Float → Float
Float.cos   : Float → Float
Float.acos  : Float → Float
Float.atan2 : Float → Float → Float
```

This should be a general VIR runtime capability, not an
Illuminate-specific host binding. No new JavaScript-level math API is
requested.

Lean already assigns these declarations the C symbols `fabs`, `sqrt`,
`sin`, `cos`, `acos`, and `atan2`. The requested VIR entries therefore
have the following scalar ABI:

| Lean declaration | Parameters              | Result   | Native symbol |
| ---------------- | ----------------------- | -------- | ------------- |
| `Float.abs`      | one `.float`            | `.float` | `fabs`        |
| `Float.sqrt`     | one `.float`            | `.float` | `sqrt`        |
| `Float.sin`      | one `.float`            | `.float` | `sin`         |
| `Float.cos`      | one `.float`            | `.float` | `cos`         |
| `Float.acos`     | one `.float`            | `.float` | `acos`        |
| `Float.atan2`    | two `.float` (`y`, `x`) | `.float` | `atan2`       |

These appear suitable for ordinary compiler-generated boxed wrappers,
as with VIR's existing `Float.round` registration. Native lookup
should remain limited to the generated registry; this request does not
require unrestricted dynamic symbol lookup.

## Immediate consumer

Illuminate is preparing browser-resident hit testing. Its real query
is:

```lean
Illuminate.HitScene.query :
  HitScene → Float → Float → HitSceneResult
```

The sources are on `ejgallego/illuminate`, branch
`feat/vir-performance`, at commit
`af088e313eaade90be100aeaf63ddac79a8c1710`:

```text
src/Illuminate/Diagram/HitScene.lean
src/Illuminate/Diagram/HitTest.lean
src/Illuminate/Geometry/Trace.lean
src/Illuminate/Geometry/PathData.lean
```

VIR package generation currently rejects this closure at `Float.abs`.
Once that first dependency is available, path, cubic, arc, and stroke
tracing also reach `Float.sqrt`, `Float.sin`, `Float.cos`,
`Float.acos`, and `Float.atan2`. All six operations are part of the
actual geometry algorithm rather than input preparation or rendering.

The intended Illuminate-owned retained API is approximately:

```lean
mountHitScene   : HitScene → RuntimeM HitSceneHandle
queryHitScene   : HitSceneHandle → Float → Float → RuntimeM HitSceneResult
disposeHitScene : HitSceneHandle → RuntimeM Unit
```

The immutable scene crosses VIR's typed JavaScript-object boundary
once. A hot pointer query then sends only two `Float` coordinates and
receives one small custom-inductive result. Illuminate will own this
API and its resource lifecycle; VIR only needs to make the real query
closure executable.

## Why native externs

Implementing these operations as JavaScript `Math.*` host imports
would add multiple host crossings inside one geometry query. Curves,
arcs, clipping, and stroke testing may invoke them repeatedly, so such
imports would dominate the small workload and make the VIR/FIR
comparison measure bridge overhead instead of Lean execution.

The desired implementation keeps the computation inside the VIR Wasm
runtime, matching VIR's existing treatment of arithmetic and
`Float.round`.

## Semantics

- Inputs and outputs remain binary64 values throughout the VIR typed
  boundary.
- `Float.atan2` retains Lean's argument order: `y`, then `x`.
- Signed zero must reach the native operation unchanged, particularly
  for `Float.abs` and `Float.atan2`.
- NaN, infinity, domain errors, and rounding should follow the pinned
  Lean/WASI native implementation. The adapter should not stringify,
  narrow to `Float32`, or canonicalize ordinary values.
- No application-visible Wasm addresses or new ownership obligations
  should be introduced.

## Suggested acceptance checks

1. Register the six declarations in VIR's native-extern table with
   their real scalar ABI and native symbols.
2. Regenerate the restricted native-symbol registry and pass
   `check:native-externs`, `check:native-wrappers`, and the
   boundary-registry checks.
3. Add a small `@[vir_export]` fixture exercising every operation,
   including positive and negative finite values, both signed zeros,
   infinities, NaN, `acos` boundary values, and `atan2` quadrant
   cases.
4. Confirm the fixture has no JavaScript function imports for these
   operations.
5. Confirm VIR package generation accepts the real
   `Illuminate.HitScene.query` closure without substituting or copying
   the geometry algorithm.
6. Run an Illuminate differential over its 301 prepared hit-test
   points, including transformed, clipped, tagged, layered, text,
   image, line, cubic, and arc cases.

If package generation exposes another unsupported native dependency
after these six are registered, please report the exact closure path
rather than adding a broad math surface speculatively.

## Current reference

The locally checked VIR `origin/main` is
`ff3216873f918f057a766558a784ceac492b57a9`; it already includes timed
call phases but none of the six registrations above. The request
should be independently useful on VIR main and does not depend on
Illuminate's animation runtime branch.
