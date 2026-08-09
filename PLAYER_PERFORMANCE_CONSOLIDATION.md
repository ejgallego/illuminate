# Illuminate player performance consolidation

## Decision summary

The selection-only boundary is the right architecture. It keeps the
original animation and SVG patch data in JavaScript, runs the real
Lean playback state machine, and uses one shared DOM renderer for
JavaScript, VIR, and FIR. The measurements no longer justify changing
that boundary or moving playback semantics back into JavaScript.

Six results are now strong enough to drive the next work:

1. Both corrected FIR packages pass all 107 differential traces
   against the JavaScript oracle, VIR JSON, VIR typed, and VIR
   selection implementations.
2. FIR is close to the JavaScript callback cost in the browser, but
   42–46% of its `decodeMs` is persistent-state reading and writing.
   JavaScript result construction is less than 1% of `decodeMs`.
3. VIR selection is dominated by interpreted execution. Retained `JSL`
   and `RuntimeRef` ownership is a small part of that execute cost and
   is a net win after avoided state marshaling is counted.
4. A constructor-specific FIR `dispatchTick` prototype removes the
   40-byte event allocation and saves 4.6–8.8% median callback time,
   but leaves the larger state/result boundary unchanged.
5. Absolute browser microsecond values are too sensitive to machine
   state for regression gating. Paired candidate/JavaScript ratios and
   phase shares are much more repeatable.
6. The live `requestAnimationFrame` dashboard cannot resolve
   Illuminate's detailed host-observer cost: same-runtime on/off
   ranges span both faster and slower outcomes. FIR v4 also performs
   generated-adapter timing in both modes, so the current off lane is
   not yet a timing-free production baseline.

The priority order is therefore:

1. give FIR an optional timing-free dispatch path so production and
   diagnostic adapter costs can be measured separately, following
   [FIR_UNTIMED_DISPATCH_HANDOFF.md](FIR_UNTIMED_DISPATCH_HANDOFF.md);
2. give FIR a generated in-place resident-state update or equivalent
   compact state ABI, while retaining generic dispatch as the oracle;
3. preserve interpreter-local declaration/symbol caches across VIR's
   repeated retained calls;
4. land and consume a clean scalar-tick FIR package as a smaller,
   independent improvement;
5. add the fixed-event browser regression harness described below;
6. defer application-level type rewrites until these runtime boundary
   changes are measured.

## Compared implementations

| Lane             | Playback decision                 | Animation payload                           | Per-tick result     | DOM rendering      |
| ---------------- | --------------------------------- | ------------------------------------------- | ------------------- | ------------------ |
| JavaScript       | original JavaScript state machine | original JS object                          | direct JS selection | shared JS renderer |
| VIR selection    | interpreted Lean                  | compact projection retained behind a handle | six-field selection | shared JS renderer |
| FIR selection v4 | FIR-native Wasm                   | compact projection retained in Wasm         | six-field selection | shared JS renderer |
| VIR full         | interpreted Lean                  | full Lean-owned patch model                 | patch operations    | VIR DOM imports    |

The first three lanes are the apples-to-apples comparison. Full VIR is
retained as a useful end-to-end control, but it deliberately has a
wider boundary.

## Measurement identities

The completed P0–P4 run used:

```text
Illuminate: 3a6920c392717c4995c4e3bd1f980801f39f2b5e
VIR:        552cfa5b860908d2f0b3696f3fb22236521b8f0f
FIR:        c797b6db8ef435cdb39a75e53f86e0b73048181f
FIR v3:     a4de0ec22d50c5070dbfa90969dc95c41be6f747955f60c8f9620baeafefbfa5
FIR v4:     1c3064d4ee5b9ea0f96055b03e50e8477d29ce6f2313c23c9dcfc83d314eecd8
Node:       24.18.0
CPU:        AMD Ryzen AI 9 HX 370
```

Both immutable FIR packages use the corrected `Player.lean` SHA-256
`e1f98f9d02118f4b61a3f935dbdf49b1c3caf7c0b52aa0f80b7232fb740cd620`.
The staged v3 package is 50,211 bytes; the selection-only v4 package
is 55,527 bytes. Both have zero imports and module-owned memory. The
consumer package tests, package smoke tests, 10,000-dispatch frontier
checks, and the full differential runner pass:

```text
107 legacy/VIR-JSON/VIR-typed/VIR-selection/FIR-native/FIR-selection player traces matched
```

## Browser result: use paired ratios

The browser harness runs all 16 animations, includes synchronous DOM
patching, excludes paint and compositing, uses a fresh context for
each observation, and balances backend order. All observations
retained 16/16 DOM matches.

Across the recent balanced campaigns, the paired callback ratios
remain in a narrower band than the absolute callback times:

| Candidate     | Current paired median | Current observation range | Recent campaign medians | Interpretation                         |
| ------------- | --------------------: | ------------------------: | ----------------------: | -------------------------------------- |
| VIR selection |              6.11× JS |                5.65–6.35× |        about 4.95–6.11× | interpreter transition dominates       |
| VIR full      |             10.32× JS |               9.59–11.10× |         about 9.0–10.7× | interpreter plus Lean-owned DOM path   |
| FIR selection |              1.65× JS |                1.49–2.13× |        about 1.54–1.71× | native core is close; boundary remains |

In one balanced run, the JavaScript mean for the same backend moved by
more than 3× between observations, and the candidate moved with it.
The paired ratios stayed within these ranges:

```text
VIR selection: 5.65×, 6.35×, 6.11×
VIR full:      10.32×, 9.59×, 11.10×
FIR selection: 1.65×, 1.49×, 2.13×
```

This makes absolute browser microseconds diagnostic, not a regression
gate. The harness now records the median and range of per-observation
paired ratios instead of relying only on a ratio of independent
aggregate medians. Benchmark mode also suppresses the detailed phase
charts in both lanes; only the profiled lane retains the phase
observer, so visualization work does not perturb the comparison.

### Host-profiler observer matrix

The 2026-08-09 matrix used four balanced five-second rounds per mode
and the scalar-tick FIR v4 package at `ac7467f3`. Each backend-round
used one fresh page and runtime for both modes, reset all callback
metrics between modes, and balanced which mode ran first. Every
observation retained 16/16 DOM matches. The table reports the paired
per-round change caused by enabling Illuminate's detailed host
observer while leaving phase charts hidden:

| Backend       | JS median change | Candidate median change | Candidate on/off ratio and range |
| ------------- | ---------------: | ----------------------: | -------------------------------: |
| VIR selection |          −2.1 µs |                −17.1 µs |               0.95× (0.54–2.32×) |
| VIR full      |          +1.6 µs |                −43.3 µs |               0.90× (0.51–2.70×) |
| FIR selection |          −4.3 µs |                −10.1 µs |               0.99× (0.36–1.24×) |

Every candidate range crosses 1× and every paired delta range crosses
zero. Even same-runtime pairing cannot price this observer inside the
live animation workload; scheduling and workload-phase noise are
larger than the effect. The negative medians are not speedups.

This also does not show that FIR timing is free. The generated v4
adapter still calls `performance.now()`, constructs timing and memory
records, and freezes the result on every tick in both modes. The
matrix isolates only Illuminate's additional observer. A fixed-event
browser harness is required to measure that observer, and a generated
timing-free dispatch mode is required before calling the FIR off lane
a production baseline.

## VIR selection core

The focused Node harness pairs the direct typed transition with the
retained player, alternates call order, uses a warm target-resolution
cache, and checks every result for equality. Each workload has five
rounds of 2,000 measured ticks after 200 warmups.

| Workload                   | Direct total | Retained total | Retained/direct | Direct execute | Retained execute | Execute delta |
| -------------------------- | -----------: | -------------: | --------------: | -------------: | ---------------: | ------------: |
| Pause-driven slide show    |    0.4542 ms |      0.2655 ms |           0.58× |      0.2192 ms |        0.2315 ms |      +12.4 µs |
| Morphing arrows/final loop |    0.3512 ms |      0.2506 ms |           0.71× |      0.2031 ms |        0.2195 ms |      +16.4 µs |

Retaining the animation and state saves 29–42% end to end because it
removes repeated state marshaling. The retained handle adds only about
6–8% to execute, and its measured host imports are about 4–5 µs. The
absolute values moved with machine load relative to the earlier run,
but the architectural result did not change.

Consequences:

- Do not replace the retained player with a stateless transition.
- Do not redesign `RuntimeRef` or `JSL` ownership for this workload.
- Do profile the interpreter while executing
  `transitionSelectionLive`.
- A specialized tick input can save only the small retained marshal
  phase unless it also enables a more general VIR lowering
  improvement.

### Focused VIR interpreter profile

A separate Chrome CDP profile used the symbolized development Wasm and
a tight retained `dispatchSelectionPlayer` loop with no DOM work. It
completed 57,820 ticks in 10 seconds. Of 10,134.6 ms sampled, 9,996.1
ms was attributable. The largest self-time symbols were:

| Self-time symbol/family            | Attributable samples |
| ---------------------------------- | -------------------: |
| interpreter `eval_body`            |               11.41% |
| interpreter `call`                 |                7.24% |
| package declaration hash lookup    |                6.63% |
| interpreter symbol-cache lookup    |                5.29% |
| `dlmalloc`                         |                5.10% |
| `memcmp`                           |                4.88% |
| `dlfree`                           |                4.65% |
| interpreter symbol-cache insertion |                3.89% |
| native-symbol cache lookup         |                3.55% |
| interpreter `eval_expr`            |                3.01% |
| interpreter `get_decl`             |                2.74% |
| constant-cache insertion           |                2.56% |
| interpreter `lookup_symbol`        |                2.37% |

The profile is diagnostic rather than a throughput measurement, but
its shape is unambiguous. Repeated name/cache lookup and construction
remain comparable to core expression interpretation, and allocation,
freeing, reference counting, and interpreter destruction form another
substantial family. Export target resolution is already cached on the
JavaScript side; the remaining opportunity is to preserve suitable
interpreter-local declaration/symbol state across retained calls.

## FIR selection core

The FIR harness uses 12 creation rounds and 1,200 fixed-60 Hz ticks
after 60 warmups. The two animations differ dramatically in original
JSON size but use only 648–1,064 bytes for the resident selection
projection.

| Workload                   | Tick wall | Event encode |   Execute | Decode/state sync |    Rewind | Scratch |
| -------------------------- | --------: | -----------: | --------: | ----------------: | --------: | ------: |
| Pause-driven slide show    | 0.0141 ms |    0.0013 ms | 0.0045 ms |         0.0061 ms | 0.0004 ms |    40 B |
| Morphing arrows/final loop | 0.0114 ms |    0.0012 ms | 0.0031 ms |         0.0050 ms | 0.0004 ms |    40 B |

Absolute FIR tick time varied substantially between two consecutive
process runs, from roughly 11–14 µs to 69–93 µs. The phase proportions
remained almost unchanged:

| Phase                                    | Stable share of measured FIR total |
| ---------------------------------------- | ---------------------------------: |
| Result decode plus state synchronization |                             46–47% |
| Compiled Lean execution                  |                             29–34% |
| Event encoding                           |                             10–11% |
| Rewind                                   |                           about 3% |
| Adapter bookkeeping outside named phases |                               7–8% |

The current `decodeMs` includes more than decoding the six-field
selection. It also calls `copyPlayerStateToSlot`, which reads and
validates the returned `PlayerState`, handles five `Nat`/`Option Nat`
values and an `Option Float`, and rewrites the persistent state slot
before scratch memory is rewound. This is the largest actionable FIR
boundary cost.

An instrumentation-only adapter probe split that phase further. It was
applied to a disposable staged copy, checked against all 107 traces,
measured, and then replaced by the canonical package.

| Decode subphase              | Pause slide median | Morphing median | Share of `decodeMs` |
| ---------------------------- | -----------------: | --------------: | ------------------: |
| Transition header/validation |            4.43 µs |         4.25 µs |              10–11% |
| Selection/action decode      |            7.08 µs |         8.64 µs |              18–20% |
| Returned state read          |           13.77 µs |        14.06 µs |              32–36% |
| Persistent state-slot write  |            4.07 µs |         4.41 µs |           about 10% |
| JavaScript result object     |            0.37 µs |         0.43 µs |            under 1% |

State read plus state-slot write accounts for 42–46% of `decodeMs`.
The result object is not a meaningful target.

As an upper-bound experiment, the adapter reused `frame`, `step`, and
`segment` from the already decoded action instead of rereading those
fields from the returned state. An interleaved 4,000-tick A/B with
identical instrumentation reduced state-read median from 2.255 to
1.763 µs (22%), but reduced `decodeMs` only from 6.212 to 6.081 µs
(2%) and did not improve wall time (12.834 versus 12.924 µs). It also
couples the adapter to a Lean state/action invariant. The experiment
was rejected and the canonical package restored.

The large 621 KB animation is no longer a large Wasm-boundary
workload. It retains only 648 bytes, stays on one memory page, uses
one 40-byte scratch allocation per tick, and returns exactly to its
checkpoint. Bulk animation marshaling and memory ownership are solved
at this boundary.

### Scalar tick experiment

The FIR generation lane produced a constructor-specific entry:

```text
dispatchTick(player, timestamp)
```

It constructs `PlayerEvent.tick` inside Wasm, transports the timestamp
as bit-exact binary64 bits over an `i64`, and retains generic
`dispatch(player, PlayerEvent.tick)` as the semantic oracle. Eight
balanced rounds of 240 samples per mode matched action digests and
gave:

| Workload                   | Generic wall | Scalar wall | Wall change | Generic encode | Scalar encode |  Scratch |
| -------------------------- | -----------: | ----------: | ----------: | -------------: | ------------: | -------: |
| Pause-driven slide show    |     44.59 µs |    42.54 µs |       −4.6% |        7.07 µs |       2.70 µs | 40 → 0 B |
| Morphing arrows/final loop |     40.36 µs |    36.82 µs |       −8.8% |        5.97 µs |       2.17 µs | 40 → 0 B |

The scalar path removes 62–64% of event encoding, but execute and
decode are unchanged within noise. This is a worthwhile small hot-path
specialization, not a substitute for fixing state transfer. FIR
reproduced the measured 56,156-byte Wasm and SHA-256
`8b13c8124ba7235e2a00cec154f42d406e6f568f071f51ec831bbb95486ae3f5`
from clean revision `ac7467f3`; Illuminate now consumes that immutable
package locally.

## Completed gates and resulting actions

### P0 — corrected semantic baseline: complete

Owner: FIR wasm-generation lane plus Illuminate integration.

The corrected v3 and v4 packages are staged without adapter-side
translations. All 107 differential traces, bit-exact timestamps, both
patch targets, lifecycle tests, exact rewinds, and zero-import package
checks pass. The live dashboard retains 16/16 DOM matches.

### P1 — FIR decode attribution: complete

Owner: FIR wasm-generation adapter.

The disposable instrumentation reported:

```text
result validation
selection/action decode
PlayerState read and validation
persistent state-slot write
JavaScript result construction
```

State read and write account for 42–46% of `decodeMs`; JavaScript
result construction accounts for less than 1%.

### P2 — persistent state/result transfer: next FIR priority

Owner: FIR compiler/runtime and generated adapter design.

The JavaScript action-reuse prototype did not improve wall time and
was rejected. FIR should now test a generated persistent state cell or
equivalent in-place resident mutation that avoids reconstructing and
traversing a general Lean object graph every tick. Keep the public
Lean transition pure and the generic structured entry as the
differential oracle. Avoid repeated `Nat`/`UInt` casting at the
application layer and keep timestamps as bit-exact binary64 values.

The theoretical ceiling is larger than the event-encoding experiment:
decode and state sync are about 46–47% of core time, versus 10–11% for
event encoding.

### P3 — VIR interpreted execution profile: complete

Owner: VIR.

The focused retained-entry profile attributes the remaining execute
phase to interpreter evaluation, repeated declaration/symbol cache
work, and allocation/reclamation. VIR should investigate preserving
the interpreter-local caches across retained calls.

Do not start with `RuntimeRef`: paired evidence prices retained
ownership at only about 5–6 µs while avoiding 38–46 µs of repeated
marshal/decode work.

### P4 — scalar tick path: consumed locally

Owner: FIR first; VIR only if it generalizes.

Generic `dispatch(player, PlayerEvent)` remains the oracle. Illuminate
now consumes the clean immutable package at FIR revision `ac7467f3`.
Only requestAnimationFrame ticks use the constructor-specific entry;
the 107-trace suite still exercises generic structured dispatch. The
hot path removes the event allocation, uses zero host scratch bytes,
and saved 4.6–8.8% median wall time in the balanced A/B experiment.
Publishing that FIR revision on a named `ejgallego/lean-fir` branch is
still required for remote reproducibility. State synchronization
remains the next higher-value target.

After consumer integration, the three-run DOM-inclusive dashboard
measured FIR at a paired median `2.00x` JavaScript (`1.93x–2.10x`), or
72.7 µs median callback overhead, with 16/16 DOM matches. FIR's
rolling phase means included 40.5 µs execute and 40.9 µs decode/state
sync; input encoding was only 2.6 µs. This confirms that further event
marshaling work is no longer the priority.

### P5 — make browser comparisons reproducible

Owner: Illuminate.

Use paired per-observation ratios and report ranges. Keep detailed
phase visualization suppressed during automated measurement. For a
regression gate, add a fixed-event browser harness with explicit
warmup and enough iterations to report median and p95; retain the live
`requestAnimationFrame` dashboard as the end-to-end correctness and
interaction diagnostic.

### Deferred

- Further `Player.lean` algorithm changes: FIR executes the real
  transition in only a few microseconds, so runtime boundaries
  currently offer more benefit.
- Bounded scalar rewrites in Illuminate: avoid semantic divergence and
  casting until the FIR state-sync experiment establishes that scalar
  representation is the blocker.
- Full VIR DOM optimization: selection-only VIR is the production
  boundary; full VIR should remain a lifecycle and host-import stress
  control.

## Reproduction

```sh
npm run measure:vir-selection-core

ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/immutable/v4-package \
  npm run measure:fir-live

npm run measure:live-dashboard -- --duration-ms 3000 --runs 4
```

The live-dashboard report pairs `host-profiler-off` and
`host-profiler-on` observations for every backend and benchmark round.
Each backend-round gets a fresh page and runtime shared by both modes,
callback metrics are reset between modes, backend and profiler order
are balanced, and phase charts are suppressed. FIR v4 still collects
its generated-adapter timings in both modes, so the off mode measures
removal of Illuminate's detailed host observer only.

Raw structured outputs are written to:

```text
test_output/perf/vir-selection-core.json
test_output/perf/fir-live-phases.json
test_output/perf/live-dashboard-phases.json
```
