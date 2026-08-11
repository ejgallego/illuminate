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
| `mixed-medium` | mixed    |       4,532 B |     301 |
| `paths-large`  | paths    |      50,730 B |     625 |

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

Illuminate consumes the immutable FIR v2 package
`illuminate-hit-scene-75c51b9f3d04fbcd`, built at FIR commit
`c780c94b724b61aba8be222fc6ceb3bc454e3ef0` from exact Illuminate
revision `88dcfee895a55e804641bff485024cffec1b5419`. Its Wasm is
46,089 bytes with SHA-256
`06708aac339cd7f6f7fcbe7c973dc29125e263925635d0311a0571d4428e97b7`,
zero imports, module-owned memory, and six function exports plus
memory. The adapter retains one encoded scene per instance and exposes
an untimed `hitTest` for production plus `hitTestDiagnostic` for phase
attribution. The package smoke covers 301 oracle queries, 10,000
flat-frontier queries, exact binary64 boundary coordinates, two
instances, disposal, and checksum/export validation. Illuminate's
consumer additionally matched all 1,009 distinct queries across the
three workload tiers.

The acceptance run used two warm-up rounds and ten measured rounds for
every workload. Absolute times remain machine-sensitive; the balanced
paired ratios are the result:

| Workload       | VIR median | FIR median | FIR / VIR | FIR speedup |
| -------------- | ---------: | ---------: | --------: | ----------: |
| `bounds-small` |   0.044 ms |   0.006 ms |     13.9% |        7.2× |
| `mixed-medium` |   0.307 ms |   0.015 ms |      4.8% |       20.6× |
| `paths-large`  |   0.586 ms |   0.036 ms |      6.1% |       16.5× |

FIR is substantially faster for all three retained scenes. The mixed
and path-heavy ratios remain dominated by compiled execution versus
VIR interpretation, not input or result conversion. Bounds-only calls
are short enough that fixed boundary work is a larger share, but FIR
still takes only 13.9% of VIR's median production time.

## VIR diagnostic result

The acceptance run uses one diagnostic warm-up followed by five
instrumented rounds. These are `runtime.callTimed` diagnostic medians,
not portable acceptance thresholds:

| Workload       | Wall time | Lean execution |  Marshal |   Decode |
| -------------- | --------: | -------------: | -------: | -------: |
| `bounds-small` |  0.024 ms |       0.015 ms | 0.002 ms | 0.002 ms |
| `mixed-medium` |  0.362 ms |       0.348 ms | 0.002 ms | 0.002 ms |
| `paths-large`  |  0.515 ms |       0.503 ms | 0.002 ms | 0.003 ms |

The separately timed normal public path remains faster than the
instrumented path. The production medians in the same acceptance run
were 0.044 ms, 0.307 ms, and 0.586 ms respectively. Paired
measurements, rather than these absolute figures, remain the
acceptance signal.

## What the classes reveal

An earlier pre-bounds diagnostic found a 4.969 ms median for the mixed
workload's boundary probes and 3.319 ms for numeric-edge probes,
compared with 1.927 ms for the regular grid. In the old large path
scene, misses took 30.765 ms while tagged hits took 12.697 ms.

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

The old FIR package remains intentionally rejected for this layout.
Its first observed mismatch was `mixed-medium/grid-8-5`: expected
labeled tag `back`, received untagged `something`. This was a
type-layout incompatibility, not an adapter optimization opportunity.
The accepted package keeps browser API
`fir.illuminate-hit-scene.browser/v1` while advancing the input layout
to `lean-4.32-Illuminate.HitScene/v2`. The regenerated package now
matches all 1,009 tier-suite queries.

## Spatial subtree experiment

The next candidate is intentionally opt-in. `SpatialHitScene` converts
the accepted `HitScene` once at mount time, attaches conservative
bounds to subtrees, and balances flattened composition runs. The
production `HitTree`, its codec, and the accepted FIR v2 input layout
remain unchanged.

This gives a particularly clean VIR comparison. Both variants receive
the same typed scene through the same JavaScript projector, retain it
through the same resource API, accept the same two `Float` query
arguments, and use the same result decoder. Only the retained Lean
tree and query algorithm differ. The experiment matched all 1,009
oracle queries, plus a separate affine grid. The 36-level path fixture
becomes a tree of depth at most six.

Filled paths retain an unbounded left side. This is required by the
existing eastward parity-ray semantics: points left of the geometry
can still produce observable hits in numerical edge cases. Right, top,
and bottom bounds remain finite; stroke-only paths use all four sides.
Affine interval propagation keeps partially unbounded regions
conservative.

The full run used five warm-up rounds, 20 measured production rounds,
balanced backend order, and five separately instrumented diagnostic
rounds:

| Workload       | Reference VIR | Spatial VIR | Median speedup | Mean speedup | p95 speedup | Execute speedup |
| -------------- | ------------: | ----------: | -------------: | -----------: | ----------: | --------------: |
| `bounds-small` |      0.026 ms |    0.026 ms |          1.00× |        1.02× |       1.02× |           1.01× |
| `mixed-medium` |      0.335 ms |    0.082 ms |          4.10× |        1.36× |       1.01× |           7.19× |
| `paths-large`  |      0.811 ms |    0.530 ms |          1.53× |        1.19× |       1.02× |           1.33× |

The mixed and path medians improve, and the diagnostic split
attributes the gain to Lean execution. Bounds-only geometry is
effectively unchanged. The mixed mean improves by 26%, but expensive
path hits still dominate the tail and are not skipped by broad subtree
guards. An independent full repeat put the median speedups at 1.07×,
2.63×, and 1.74× respectively, so absolute medians are sensitive to
ambient load while the direction is stable. This candidate is useful
evidence, but not yet a production switch.

The candidate VIR package is 22,600 bytes versus 22,074 bytes for the
reference package, an increase of 526 bytes (2.4%). It loads 278 Lean
IR declarations and 57 native externs versus 246 and 53. The VIR
runtime Wasm is identical. Creation ratios are deliberately not used
as evidence because the current harness records one fixed-order mount
sample per workload.

Reproduce the experiment with:

```sh
npm run stage:vir-hit-scene
npm run stage:vir-spatial-hit-scene
npm run measure:vir-spatial-hit-scene
```

The gitignored detailed result is
`test_output/vir-spatial-hit-scene-performance.json`. No FIR
regeneration is requested until query-class analysis and tail behavior
justify accepting the representation.

## Conclusions and next actions

1. Keep the current retained typed-object boundary. It has removed the
   scene from the hot path and is not the dominant cost.
2. Treat FIR as the compiled semantic control. Its 7.2× to 20.6× tier
   speedup attributes most remaining geometry cost to VIR interpreter
   execution rather than its retained boundary.
3. Keep the accepted conservative prepared-path bounds. The opt-in
   spatial experiment confirms that subtree rejection can reduce
   median execution, but its mixed p95 needs query-class study before
   adoption or FIR rebuild.
4. Re-run the query-class and result-class breakdown for the spatial
   candidate; full-scene misses are the most sensitive regression
   signal.
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

## Repeatable FIR v2 acceptance

The Illuminate consumer accepted the regenerated FIR v2 package with
`npm run accept:fir-hit-scene`. With `ILLUMINATE_FIR_HIT_SCENE_DIR`
naming an immutable package, the command validates the pinned source
revision, source and fixture hashes, v2 input layout, zero imports,
exact Wasm exports, module-owned memory, adapter phases, resident
checkpoint behavior, disposal, and all 1,009 distinct oracle queries.
Any admission or differential failure stops before recording a result.

Successful suite runs append a compact JSONL record to
`test_output/hit-scene-performance-history.jsonl`. Each record retains
the Illuminate revision and dirty state, CPU and runtime environment,
fixture hash, VIR package-set hash, FIR BUILD and Wasm hashes,
protocol, summary statistics, phase attribution, and paired ratios.
Raw samples and per-call diagnostic arrays stay in the individual
report and are not copied into history. The showcase plots the latest
twelve paired runs, uses the first retained measurement as the
per-workload baseline, and marks the 1× FIR/VIR line explicitly.
