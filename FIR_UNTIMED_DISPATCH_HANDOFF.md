# FIR handoff: timing-free Illuminate production dispatch

This task uses branch-only coordination. Keep the work on a named
`ejgallego/lean-fir` branch and do not open a pull request.

## Starting point

Use the accepted scalar-tick FIR v4 package as the semantic and
ownership baseline:

```text
FIR revision:       ac7467f3af9598400be1f175510aff339ac6113a
adapter API:        fir.illuminate-player.browser/v4
Wasm SHA-256:       8b13c8124ba7235e2a00cec154f42d406e6f568f071f51ec831bbb95486ae3f5
Wasm bytes:         56,156
imports:            zero
memory:             module-owned

Illuminate branch:  feat/vir-performance
Illuminate head:    90b81c41d3223da6fe818194ae52d613a36f7aa1
```

Illuminate consumes this immutable package successfully. All 107
legacy/VIR/FIR differential traces, binary64 timestamp cases,
lifecycle checks, concurrent players, and the 10,000-tick exact
checkpoint test pass. The scalar tick uses zero host scratch bytes and
keeps generic structured dispatch as its oracle.

## Problem to isolate

The v4 adapter's `dispatchCore` always collects diagnostics, even when
Illuminate disables its detailed host observer. Every tick still:

- calls `performance.now()` around the total, encode, execute, decode,
  and rewind intervals;
- reads and records frontier and memory-page diagnostics;
- constructs timing and memory objects;
- uses `Object.values`, object spreads, and `Object.freeze` to build
  the returned diagnostic records.

Consequently, Illuminate's current `host-profiler-off` lane is not a
timing-free production path. Hiding or dropping `result.timings` after
the call would not remove the work.

Illuminate added a v5 browser matrix with 24 observations: three
backends, profiling off/on, and four balanced five-second rounds. Both
modes share the same page and runtime within each backend-round, reset
all callback metrics between modes, alternate which mode runs first,
and suppress phase charts. All observations retain 16/16 DOM matches.

The live `requestAnimationFrame` workload cannot resolve the extra
Illuminate observer cost:

| Backend       | Candidate on/off median | Range      |
| ------------- | ----------------------: | ---------- |
| VIR selection |                   0.95× | 0.54–2.32× |
| VIR full      |                   0.90× | 0.51–2.70× |
| FIR selection |                   0.99× | 0.36–1.24× |

Every range crosses 1× and every paired time-delta range crosses zero.
The negative medians are noise, not speedups. This result motivates a
fixed-event benchmark and does not establish that adapter diagnostics
are free.

## Requested FIR experiment

Provide distinct production and diagnostic tick paths in one generated
package. The preferred v5 browser API is:

```text
dispatchTick(player, timestamp)       -- production, timing-free
dispatchTickTimed(player, timestamp)  -- diagnostic, current phase data
```

Equivalent names are acceptable, but the production method should be
the ordinary/default API. Avoid a fresh per-tick options object. Both
methods must invoke the same compiled scalar-tick semantics and differ
only in adapter diagnostics.

The production path must:

- make no timing-clock calls;
- construct no timing, memory, or phase-report objects;
- avoid diagnostic `Object.values`, spreads, and freezes;
- return only the success/error result, copied `FrameSelection`, and
  `scheduleNextFrame` decision required by the browser host;
- retain ownership checks, result validation needed for safety, exact
  checkpoint rewind, poisoning after execution/decode/rewind failure,
  and instance-drop reclamation;
- preserve bit-exact binary64 timestamp transport and zero tick-input
  scratch allocation;
- retain zero Wasm imports and module-owned memory.

Do not duplicate or simplify Illuminate's state machine. Refactor the
generated adapter around one semantic execution/decoding core, with
diagnostic collection optional at the adapter level. Do not combine
this experiment with the resident-state ABI change from
`FIR_STATE_SYNC_HANDOFF.md`; keeping state transfer unchanged lets the
consumer attribute the timing-only delta.

Generic `dispatch(player, PlayerEvent)` and the pure structured trace
entry remain semantic oracles. A symmetric timed/untimed generic
dispatch is welcome, but the requestAnimationFrame scalar tick is the
required hot path.

## Acceptance

The package should contain both paths so Illuminate can run an
interleaved A/B without swapping modules. Acceptance requires:

1. all 107 differential traces match through generic dispatch, timed
   scalar tick, and timing-free scalar tick;
2. all six `PlayerEvent` constructors remain covered by the generic
   oracle;
3. adjacent binary64 timestamps preserve their exact bits;
4. both `PatchTarget` constructors continue to decode correctly;
5. disposal, cross-adapter rejection, concurrent players, and poisoned
   player behavior pass for both scalar paths;
6. 10,000 timing-free ticks keep a flat checkpoint, zero host scratch,
   and no growing roots;
7. the complete Wasm retains zero imports and module-owned memory;
8. a deterministic fixed-event benchmark performs explicit warmup,
   alternates timed/untimed order, checks action digests after every
   batch, and reports median and p95 wall time for both Illuminate
   workloads;
9. the report states exactly which clock calls and JavaScript
   diagnostic allocations are absent from the production path;
10. the package manifest advertises the two methods and whether timing
    and memory records are present in each result.

The primary metric is whole-call wall time. Do not claim improvement
merely because timing fields disappeared or their work moved into an
unmeasured helper.

## Illuminate integration

Illuminate will map detailed profiling off to the timing-free method
and detailed profiling on to the timed method, without adapter-side
semantic translation. It will retain the current live RAF dashboard as
an end-to-end diagnostic and add a fixed-event browser harness for the
timed/untimed A/B.

After this timing-only experiment is accepted, the separate
`FIR_STATE_SYNC_HANDOFF.md` request remains the next FIR optimization.

## Return to Illuminate

Provide the named `ejgallego/lean-fir` branch and exact head,
immutable package path, complete/base Wasm hashes and sizes,
import/export list, adapter/capability versions, source revisions and
hashes, all test results, and the raw deterministic A/B report. Do not
open a pull request.
