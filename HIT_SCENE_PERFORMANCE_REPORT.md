# HitScene browser performance report

## Scope

Illuminate has one hit-test implementation in Lean. The original
JavaScript `#diagram` widget maps pointer coordinates and asks the
Lean server through InfoView RPC; it does not implement geometry
itself. The meaningful backend comparison is therefore:

- existing Lean server RPC in the InfoView;
- the same retained Lean `HitScene` through VIR in the browser; and
- the same Lean entry through FIR-native Wasm when that package is
  staged.

The standalone page measures VIR and FIR. RPC remains an InfoView-only
baseline because reproducing it outside the Lean server would change
the transport being measured. The page says this explicitly and does
not label a JavaScript dispatch control as a JavaScript hit-test
implementation.

## Reproduction

The Lean tests generate a three-tier fixture suite whose results come
from the original `Diagram.hitTest` oracle:

| Workload       | Geometry | Encoded scene | Queries |
| -------------- | -------- | ------------: | ------: |
| `bounds-small` | bounds   |         558 B |      83 |
| `mixed-medium` | mixed    |       4,088 B |     301 |
| `paths-large`  | paths    |      44,610 B |     625 |

Stage the final FIR package, run the paired production measurements,
and stage the visual report with:

```sh
lake test --wfail
npm run stage:vir-hit-scene
ILLUMINATE_FIR_HIT_SCENE_DIR=/absolute/immutable/package \
  npm run stage:fir-hit-scene
npm run measure:hit-scene -- --require-fir
npm run measure:hit-scene -- --suite --quick --require-fir
npm run profile:vir-hit-scene
npm run stage:hit-scene-performance
```

The paired reports are `test_output/hit-scene-performance.json` and
`test_output/hit-scene-tier-performance.json`. The VIR-only diagnostic
at `test_output/vir-hit-scene-profile.json` retains query-class and
result-class samples. The static page also has a live button that
reruns the bounds, mixed, and path-heavy production and diagnostic
passes in the current browser tab, updating the workload bars as one
live report.

## Live Lean-server comparison

Every `#diagram` InfoView exposes a collapsed live comparison for the
currently rendered scene. It derives a deterministic 7 by 7 grid from
the SVG view box, warms both paths for one round, then measures four
rounds (196 queries per backend). Each point is sent through:

- `Illuminate.hitTestPreparedDiagram`, including InfoView RPC
  transport, Lean server scheduling, the cached `IO.Ref HitScene`
  lookup, `HitScene.query`, and result transport; and
- the resident VIR controller's normal public `query` path in the
  browser.

The harness alternates which backend runs first each round and rejects
the run on the first result mismatch. Diagram rendering, preparation,
and retained-scene creation are excluded from both measurements. The
panel reports median, p95, maximum, and the RPC/VIR median ratio. This
is intentionally live rather than a checked-in number: LSP transport
depends heavily on the editor, server load, and machine.

FIR is not loaded into this InfoView panel yet. Its adapter remains an
immutable generated package consumed by the standalone page; bundling
a copy into the widget would create a second, drifting adapter. A true
three-way InfoView comparison should first give the widget a pinned
FIR package-delivery mechanism analogous to the current allowlisted
VIR asset service.

## Final FIR package and paired result

Illuminate consumes the immutable FIR package
`illuminate-hit-scene-960979c729bc1199`. Its Wasm is 45,595 bytes with
SHA-256
`960979c729bc119988abba24046c4bccd294f3346300d6d20ce53175b5f062d6`,
zero imports, module-owned memory, and six function exports plus
memory. The adapter retains one encoded scene per instance and exposes
an untimed `hitTest` for production plus `hitTestDiagnostic` for phase
attribution. The Illuminate consumer gate covers 301 oracle queries,
10,000 flat-frontier queries, exact binary64 boundary coordinates, two
instances, disposal, and checksum/export validation.

The full medium run used two warm-up rounds and ten measured rounds,
or 3,010 queries per backend:

| Backend | Median query | Mean query | 95th percentile |
| ------- | -----------: | ---------: | --------------: |
| VIR     |     0.585 ms |   0.533 ms |        0.846 ms |
| FIR     |     0.041 ms |   0.038 ms |        0.062 ms |

FIR took 6.9% of VIR's median production time, making compiled FIR
about 14.4× faster on this retained mixed scene. The separate
diagnostic execute ratio was 6.5%, consistent with the production
ratio and independent of boundary instrumentation.

The tier run used one warm-up round and two measured rounds. Absolute
times remain machine-sensitive; the paired ratios are the result:

| Workload       | VIR median | FIR median | FIR / VIR | FIR speedup |
| -------------- | ---------: | ---------: | --------: | ----------: |
| `bounds-small` |   0.018 ms |   0.003 ms |     18.5% |        5.4× |
| `mixed-medium` |   0.871 ms |   0.063 ms |      7.3% |       13.7× |
| `paths-large`  |  10.288 ms |   0.540 ms |      5.2% |       19.1× |

The increasing speedup with geometry complexity is the key signal: the
dominant difference is compiled execution versus VIR interpretation,
not input or result conversion.

## VIR diagnostic result

The full run uses one warm-up round followed by eight instrumented
rounds. These are `runtime.callTimed` diagnostic medians, not portable
acceptance thresholds:

| Workload       | Wall time | Lean execution |  Marshal |   Decode |
| -------------- | --------: | -------------: | -------: | -------: |
| `bounds-small` |  0.092 ms |       0.053 ms | 0.005 ms | 0.007 ms |
| `mixed-medium` |  1.946 ms |       1.841 ms | 0.008 ms | 0.011 ms |
| `paths-large`  | 19.550 ms |      19.462 ms | 0.010 ms | 0.020 ms |

The separately timed normal public path remains faster than the
instrumented path. One validation run over 3,010 mixed queries had a
1.300 ms production median. Paired measurements, rather than these
absolute figures, should remain the acceptance signal once FIR is
available.

## What the classes reveal

The mixed workload's boundary probes had a 4.969 ms median and its
numeric-edge probes had a 3.319 ms median, compared with 1.927 ms for
the regular grid. In the large path scene, misses took 30.765 ms while
tagged hits took 12.697 ms.

This is consistent with front-to-back short-circuiting: an early tag
can stop, while a miss traverses the complete linear composition tree
and runs every applicable path test. The path workload spends more
than 99% of observed wall time in the Lean execution phase. Marshal
and decode stay in the tens of microseconds even for the 44 KB
retained scene because only two binary64 coordinates cross per query.

## Prepared-path bounds experiment

The accepted Illuminate candidate stores four conservative scalar
bounds on each prepared path. Bounds are computed once before browser
mounting. Fill queries skip ray casting only when the point is above,
below, or to the right of the path; points to the left still run the
eastward parity ray to preserve its observable numerical behavior.
Stroke queries use all four sides before constructing and querying the
eight-direction `StrokeTrace`.

An initial exact-extrema box was rejected. It changed two established
oracle results because the cubic root and parity implementation can
report hits inside the Bézier control hull but outside mathematical
curve extrema, and can retain odd parity for points left of a path.
The accepted box therefore contains cubic control points and the full
rotated ellipse used by the arc solver. The old and new VIR packages
matched every query in the tier suite after this adjustment.

The acceptance comparison loaded the old and new VIR packages into the
same Node process, used one warm-up and four measured rounds, rotated
backend order, disabled diagnostic timing, and retained every sample.
The two packages received their corresponding old and new
prepared-path representations; coordinates and semantic oracle results
were identical.

| Workload       | Old VIR median | Bounded VIR median | Median speedup |   Old p95 | Bounded p95 |
| -------------- | -------------: | -----------------: | -------------: | --------: | ----------: |
| `bounds-small` |       0.025 ms |           0.025 ms |          0.99× |  0.088 ms |    0.076 ms |
| `mixed-medium` |       0.930 ms |           0.272 ms |          3.42× |  4.575 ms |    2.194 ms |
| `paths-large`  |      21.586 ms |           0.993 ms |         21.74× | 51.378 ms |    5.334 ms |

The path-heavy mean fell from 23.699 ms to 1.514 ms. A separate
diagnostic run attributed 0.514 ms of a 0.532 ms instrumented path
median to Lean execution, confirming that marshal and decode remain
secondary after the original path traversal bucket shrank.

The tradeoff is a larger cold scene: mixed encoding grows from 4,088
to 4,532 bytes and the path tier from 44,610 to 50,730 bytes. The VIR
package grows from 21,647 to 22,074 bytes. The bounds-only fixture and
VIR runtime Wasm are unchanged.

The existing FIR package is intentionally rejected for this new
layout. Its first observed mismatch was `mixed-medium/grid-8-5`:
expected labeled tag `back`, received untagged `something`. This is a
type-layout incompatibility, not an adapter optimization opportunity.
The browser API can remain v1, while the required input layout becomes
`lean-4.32-Illuminate.HitScene/v2`. FIR must regenerate from the new
Lean sources before a new FIR/VIR ratio is reported.

## Conclusions and next actions

1. Keep the current retained typed-object boundary. It has removed the
   scene from the hot path and is not the dominant cost.
2. Treat FIR as the compiled semantic control. The widening 5.4× to
   19.1× tier speedup attributes most of VIR's geometry scaling to
   interpreter execution rather than its retained boundary.
3. Keep the accepted conservative prepared-path bounds. After FIR v2
   validates the same effect, consider bounds on composed subtrees or
   a small spatial index so obvious misses do not walk every path.
4. Re-run the result-class breakdown after each algorithmic change;
   full-scene misses are the most sensitive regression signal.
5. Preserve the 301-query semantic differential and 10,000-query 4 MiB
   memory plateau as acceptance gates.

No VIR marshalling API request follows from these results. Even on the
small bounds fixture, only two Float coordinates cross per query. A
future VIR performance effort should target interpreter execution or
compiled hot paths, while Illuminate can independently reduce the
algorithmic cost shared by VIR and FIR with prepared bounds.

The current memory validation still stays at 4,194,304 bytes for tag,
untagged, miss, mixed, and instrumented mixed loops. No Illuminate
workaround is needed for resource ownership after VIR PR #103.
