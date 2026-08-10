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

Run the VIR diagnostic and stage its visual report with:

```sh
lake test --wfail
npm run stage:vir-hit-scene
npm run profile:vir-hit-scene
npm run stage:hit-scene-performance
```

The structured result is `test_output/vir-hit-scene-profile.json`. It
retains aggregate, query-class, result-class, phase, and raw samples.
The static page also has a live button that reruns the production and
diagnostic passes in the current browser tab.

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

## Conclusions and next actions

1. Keep the current retained typed-object boundary. It has removed the
   scene from the hot path and is not the dominant cost.
2. Use the incoming FIR package to separate native algorithm cost from
   VIR interpreter overhead on exactly the same tiered fixtures.
3. Add a cheap prepared bounding box before expensive path fill and
   stroke tests. Then consider bounds on composed subtrees or a small
   spatial index so obvious misses do not walk every path.
4. Re-run the result-class breakdown after each algorithmic change;
   full-scene misses are the most sensitive regression signal.
5. Preserve the 301-query semantic differential and 10,000-query 4 MiB
   memory plateau as acceptance gates.

The current memory validation still stays at 4,194,304 bytes for tag,
untagged, miss, mixed, and instrumented mixed loops. No Illuminate
workaround is needed for resource ownership after VIR PR #103.
