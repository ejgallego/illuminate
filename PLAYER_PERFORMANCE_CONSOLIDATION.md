# Illuminate player performance consolidation

## Decision summary

The selection-only boundary is the right architecture. It keeps the
original animation and SVG patch data in JavaScript, runs the real
Lean playback state machine, and uses one shared DOM renderer for
JavaScript, VIR, and FIR. The measurements no longer justify changing
that boundary or moving playback semantics back into JavaScript.

Three results are strong enough to drive the next work:

1. FIR is close to the JavaScript callback cost in the browser, but
   its native core is now dominated by output decoding and
   persistent-state synchronization, not by animation input or Lean
   execution.
2. VIR selection is dominated by interpreted execution. Retained `JSL`
   and `RuntimeRef` ownership is a small part of that execute cost and
   is a net win after avoided state marshaling is counted.
3. Absolute browser microsecond values are too sensitive to machine
   state for regression gating. Paired candidate/JavaScript ratios and
   phase shares are much more repeatable.

The priority order is therefore:

1. regenerate FIR from the corrected Illuminate source and restore
   107-trace parity;
2. split FIR result decoding from persistent-state synchronization;
3. optimize the measured state-sync/result boundary;
4. profile VIR's remaining interpreted transition execution;
5. only then consider the smaller event-encoding paths or Illuminate
   algorithm changes.

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

The consolidated run used:

```text
Illuminate: b233ce7c2ad1c1c68ba5bc74554d14ab49c3d4a8
VIR:        552cfa5b860908d2f0b3696f3fb22236521b8f0f
FIR:        eb6024e4425a86d7d5a8a060d037bc134896a881
FIR Wasm:   0371d430f2b04dab6ad7e545c22aa591bb177fc853f366d77aeae8a4c3ac5474
Node:       24.18.0
CPU:        AMD Ryzen AI 9 HX 370
```

The current FIR artifact predates Illuminate's duplicate frame-zero
fix. Its source uses the old `Player.lean` SHA-256
`3ed87ac8d6a21c0afb2b00efcde6f5390c47be336c09214c24ead847bdb4f306`;
the corrected source is
`e1f98f9d02118f4b61a3f935dbdf49b1c3caf7c0b52aa0f80b7232fb740cd620`.
Performance measurements remain useful, but the package must not be
described as the current semantic result until it passes the 107th
differential trace.

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
charts while retaining the phase observer, so visualization work does
not perturb the measurement.

## VIR selection core

The focused Node harness pairs the direct typed transition with the
retained player, alternates call order, uses a warm target-resolution
cache, and checks every result for equality. Each workload has five
rounds of 2,000 measured ticks after 200 warmups.

| Workload                   | Direct total | Retained total | Retained/direct | Direct execute | Retained execute | Execute delta |
| -------------------------- | -----------: | -------------: | --------------: | -------------: | ---------------: | ------------: |
| Pause-driven slide show    |    0.1281 ms |      0.0821 ms |           0.64× |      0.0648 ms |        0.0705 ms |       +5.8 µs |
| Morphing arrows/final loop |    0.1200 ms |      0.0833 ms |           0.69× |      0.0668 ms |        0.0723 ms |       +5.5 µs |

Retaining the animation and state saves 31–36% end to end because it
removes repeated state marshaling. The retained handle adds only about
8–9% to execute, and its measured host imports are about 1–2 µs.
Approximately 86% of retained core time is interpreted execution.

Consequences:

- Do not replace the retained player with a stateless transition.
- Do not redesign `RuntimeRef` or `JSL` ownership for this workload.
- Do profile the interpreter while executing
  `transitionSelectionLive`.
- A specialized tick input can save only the small retained marshal
  phase unless it also enables a more general VIR lowering
  improvement.

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

The large 621 KB animation is no longer a large Wasm-boundary
workload. It retains only 648 bytes, stays on one memory page, uses
one 40-byte scratch allocation per tick, and returns exactly to its
checkpoint. Bulk animation marshaling and memory ownership are solved
at this boundary.

## Ranked next actions

### P0 — regenerate the semantic baseline

Owner: FIR wasm-generation lane plus Illuminate integration.

Build the selection package from the corrected `Player.lean`, stage it
without adapter-side translations, and require all 107 differential
traces, bit-exact timestamps, both patch targets, lifecycle tests,
exact rewinds, zero imports, and 16/16 browser DOM matches.

### P1 — split FIR decode attribution

Owner: FIR wasm-generation adapter.

Report at least:

```text
result validation
selection/action decode
PlayerState read and validation
persistent state-slot write
JavaScript result construction
```

The immediate question is whether `copyPlayerStateToSlot` accounts for
most of the 46–47% core decode phase. Do this before proposing a new
ABI.

### P2 — optimize persistent state/result transfer

Owner: FIR compiler/runtime and generated adapter design.

If state synchronization dominates, test a flat scalar state/result
ABI or a generated persistent state cell that avoids reconstructing
and traversing a general Lean object graph every tick. Keep the public
Lean transition pure and the generic structured entry as the
differential oracle. Avoid repeated `Nat`/`UInt` casting at the
application layer and keep timestamps as bit-exact binary64 values.

The theoretical ceiling is larger than the event-encoding experiment:
decode and state sync are about 46–47% of core time, versus 10–11% for
event encoding.

### P3 — profile VIR interpreted execution

Owner: VIR.

Use the retained selection entry and the two fixed workloads.
Attribute the remaining execute phase after the environment-lookup and
inductive-normalizer caches already present in the local VIR branch.
Compare against FIR's 3–4 µs compiled execute phase to distinguish
application work from interpreter work.

Do not start with `RuntimeRef`: paired evidence prices retained
ownership at only about 5–6 µs while avoiding 38–46 µs of repeated
marshal/decode work.

### P4 — measure the scalar tick path

Owner: FIR first; VIR only if it generalizes.

Retain generic `dispatch(player, PlayerEvent)` as the oracle and
compare it with `dispatchTick(player, timestamp)`. This isolates
tagged-object/inductive input lowering. Its current ceiling is about
10–11% of FIR core time, so it ranks behind decode/state
synchronization.

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

npm run measure:live-dashboard -- --duration-ms 3000 --runs 3
```

Raw structured outputs are written to:

```text
test_output/perf/vir-selection-core.json
test_output/perf/fir-live-phases.json
test_output/perf/live-dashboard-phases.json
```
