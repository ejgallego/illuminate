# FIR-native player performance and live integration handoff

## Scope and accepted artifacts

Illuminate now consumes two immutable FIR packages for different
purposes:

- the v2 `replayTrace` package remains the independent 106-trace
  differential oracle;
- the v4 `initialSelectionLive`/`transitionSelectionLive` package is
  the persistent live player used by the comparison dashboard; and
- the accepted v3 package remains a frozen full-action performance
  baseline.

The accepted selection-player package is:

- FIR functional commit: `eb6024e4425a86d7d5a8a060d037bc134896a881`;
- immutable package: `eb6024e4425a-006dc1d1db18-3de20de4815a9e7bc26a`;
- complete Wasm: 55,518 bytes;
- Wasm SHA-256:
  `0371d430f2b04dab6ad7e545c22aa591bb177fc853f366d77aeae8a4c3ac5474`;
- adapter: `fir.illuminate-player.browser/v4`;
- input layout:
  `lean-4.32-Illuminate.Animation.SelectionAnimation/v4`;
- ownership: `fir.illuminate-player.persistent-checkpoint/v2`;
- imports: zero functions and zero memories; and
- exports: `initialSelectionLive`, `transitionSelectionLive`, the
  three frontier operations, allocator, and module-owned memory.

The package was built from the exact frozen Illuminate sources checked
by the consumer gate. Their SHA-256 values are:

- `Types.lean`:
  `97a030fdd3ef718912479343cadf0131616a8a9b458901e963dc3709cf5633a3`;
- `Player.lean`:
  `3ed87ac8d6a21c0afb2b00efcde6f5390c47be336c09214c24ead847bdb4f306`;
- `FirLive.lean`:
  `941daf939d9faa966aa8fb848b4a8f7ce0525ba6420d3843067e2c97908e2121`;
- `FirSelection.lean`:
  `a80771bcc8a4b09db99f004559726654dacc102d9982909ccf863f3d60ed0e83`.

## Final v4 measurements

The v4 harness used 12 creation rounds and 1,200 fixed-60 Hz ticks
after 60 warmup ticks, on the same Node, V8, CPU, and animation inputs
as the v3 baseline below:

| Workload                       | Browser JSON | Create wall | Projection | Selection encode | Resident selection | Tick wall | Event encode |  Execute |   Decode |    Rewind | Tick scratch |
| ------------------------------ | -----------: | ----------: | ---------: | ---------------: | -----------------: | --------: | -----------: | -------: | -------: | --------: | -----------: |
| Pause-driven slide show        |      6,694 B |    0.147 ms |   0.006 ms |         0.035 ms |            1,064 B |  0.010 ms |     0.001 ms | 0.003 ms | 0.004 ms | <0.001 ms |         40 B |
| Morphing arrows and final loop |    621,193 B |    0.104 ms |   0.001 ms |         0.012 ms |              648 B |  0.009 ms |     0.001 ms | 0.003 ms | 0.004 ms | <0.001 ms |         40 B |

The 621 KB animation is no longer a 621 KB Wasm-boundary workload. Its
v3-to-v4 creation median falls from 24.711 ms to 0.104 ms (about
238×), encode time from 21.335 ms to 0.012 ms (about 1,778×), and the
resident animation graph from 997,480 bytes to 648 bytes (about 1,539×
smaller). Median tick wall time also falls from 0.031 ms to 0.009 ms.
The complete self-contained Wasm grows by 5,315 bytes, about 10.6%,
which is a favorable trade for eliminating the dominant payload
transfer.

This inversion is useful evidence: the large morph now creates faster
than the small slide show because v4 cost follows timeline structure
(segments and steps), not SVG or parameter-string volume. The browser
continues to own `sync`, `pmap`, and `params`; Lean alone returns
frame, step, segment, local frame, segment change, playback state, and
the scheduling decision.

The DOM-inclusive five-second dashboard sample retained 16/16 matches
for both backends:

| Backend          | DOM matches | Mean callback across rows | Phase total | Input encode |  Execute |   Decode |    Rewind | DOM materialize/apply |
| ---------------- | ----------: | ------------------------: | ----------: | -----------: | -------: | -------: | --------: | --------------------: |
| VIR typed        |       16/16 |                  0.124 ms |    0.119 ms |     0.001 ms | 0.116 ms | 0.001 ms |  0.000 ms |              0.036 ms |
| FIR selection v4 |       16/16 |                  0.029 ms |    0.024 ms |     0.003 ms | 0.008 ms | 0.006 ms | <0.001 ms |              0.004 ms |

In this run FIR v4's mean measured callback was about 76% lower than
VIR's. Browser timer granularity makes the individual sub-0.01 ms
phase means directional; the Node medians are the stronger evidence
for the boundary-cost reduction.

Acceptance covered all 106 legacy/VIR-JSON/VIR-typed/FIR-native traces
after host-side patch materialization, all six `PlayerEvent`
constructors, bit-adjacent binary64 timestamps around 50 ms, both
patch-target forms, concurrent players, cancellation and idempotent
disposal, 10,000 exact checkpoint rewinds, zero Wasm imports, and the
16-example dashboard. No adapter-side timing or playback translation
was introduced.

Reproduction:

```sh
ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/immutable/v4-package \
  npm run test:fir-live-package
ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/immutable/v4-package \
  npm run stage:fir-live
ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/immutable/v4-package \
  npm run measure:fir-live
npm run measure:live-dashboard
```

## Final v3 measurements

The core harness used 12 creation rounds and 1,200 measured fixed-60
Hz ticks after 60 warmup ticks. Results are medians collected with
Node 24.18.0 on an AMD Ryzen AI 9 HX 370:

| Workload                       | Browser JSON | Create wall | Animation encode | Resident animation | Tick wall | Event encode |  Execute |   Decode |   Rewind | Tick scratch |
| ------------------------------ | -----------: | ----------: | ---------------: | -----------------: | --------: | -----------: | -------: | -------: | -------: | -----------: |
| Pause-driven slide show        |      6,694 B |    0.339 ms |         0.160 ms |            3,800 B |  0.031 ms |     0.002 ms | 0.009 ms | 0.015 ms | 0.001 ms |         40 B |
| Morphing arrows and final loop |    621,193 B |   24.711 ms |        21.335 ms |          997,480 B |  0.031 ms |     0.002 ms | 0.008 ms | 0.016 ms | 0.001 ms |         40 B |

The main result is that steady dispatch no longer scales with the
animation payload. The large animation is encoded only at player
creation; its 21.3 ms encode accounts for about 86% of the 24.7 ms
creation median. Per-tick action decoding is now the largest core
phase. Scratch returns exactly to the persistent checkpoint after each
call and stays at a 40-byte median in these traces.

The DOM-inclusive dashboard ran all 16 examples for five seconds per
backend. It uses real `requestAnimationFrame` callbacks and SVG
patching but excludes browser paint and compositing:

| Backend   | DOM matches | Mean callback across rows | Phase total |  Execute |   Decode |               DOM apply |
| --------- | ----------: | ------------------------: | ----------: | -------: | -------: | ----------------------: |
| VIR typed |       16/16 |                  0.283 ms |    0.273 ms | 0.265 ms | 0.001 ms | 0.080 ms within execute |
| FIR live  |       16/16 |                  0.177 ms |    0.152 ms | 0.038 ms | 0.067 ms |                0.020 ms |

FIR's mean callback was about 37% lower than VIR's in this run. This
is a useful baseline, not a general ranking: it is one browser run,
rows have different source FPS values, and the browser timer is
coarser than the Node measurements. The structured report retains
every row and phase so later runs can be compared without relying on
this aggregate.

Reproduction:

```sh
ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/immutable/v3-package \
  npm run test:fir-live-package
ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/immutable/v3-package \
  npm run stage:fir-live
ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/immutable/v3-package \
  npm run measure:fir-live
npm run measure:live-dashboard
```

The core report is `test_output/perf/fir-live-phases.json`; the
browser report is `test_output/perf/live-dashboard-phases.json`.

## Focused profile and next target

A 100 μs V8 CPU sample separated the representative 621 KB player's
creation and dispatch paths. The creation slice repeated the real
`createPlayer`/`disposePlayer` path 100 times. Its exclusive samples
were:

| Creation bucket        | Samples |
| ---------------------- | ------: |
| UTF-8 builtins         |   48.9% |
| FIR adapter JavaScript |   39.9% |
| Garbage collection     |    4.1% |
| Wasm                   |    2.2% |

The largest individual self-time entries were UTF-8 `encode` (37.3%),
the adapter's `Encoder.string` (14.4%), the V8 UTF-8 helper (11.2%),
the arena `allocate` wrapper (7.3%), and garbage collection (4.1%).
Transition execution is not the creation bottleneck.

A separate 200,000-tick slice attributed 67.9% of samples to adapter
JavaScript and 19.5% to Wasm. Constructor/header readers and action
decoding dominate the named adapter samples. This path is only about
0.03 ms per normal tick, however, so reducing it has much less
user-visible value than reducing creation.

Chrome reached the same conclusion in the actual dashboard. Replacing
all 16 VIR players with FIR players took 363.8 ms and retained 16/16
DOM matches. UTF-8 encoding and `Encoder.string` were the largest
attributable functions. The steady five-second run remained around
0.16 ms mean callback time. Chrome assigned much of the remaining work
to an unsymbolized `(program)` bucket, so the Node profile and
explicit phase timers are the stronger attribution evidence.

### Payload shape

The morph animation contains 9,070 parameter strings occupying 579,636
UTF-8 bytes. There are 6,141 distinct values occupying 373,352 bytes.
String interning could therefore remove at most 206,284 payload bytes,
about 36%, while still transferring and decoding most values. Path
data accounts for 62% of the bytes and transforms for 38%.

### Compact-boundary experiment

A temporary adapter experiment retained the SVG patch table in the
browser and sent only timing, segment bounds, and steps to Wasm. Lean
continued to choose frame, step, segment, local frame, segment change,
and playback state. The host reconstructed each update row from those
indices, and every measured action was compared with the unmodified v3
action.

The experiment alternated baseline and compact order over 30 creation
passes and 50 blocks of 1,000 ticks. It is an upper-bound design
probe, not a replacement package or an accepted benchmark:

| Metric                                              | v3 baseline | Compact experiment | Change |
| --------------------------------------------------- | ----------: | -----------------: | -----: |
| Stress creation median                              |   62.344 ms |           2.819 ms | -95.5% |
| Resident animation graph                            |   997,480 B |           12,648 B | -98.7% |
| Persistent allocations                              |       9,547 |                324 | -96.6% |
| Memory pages                                        |          16 |                  1 | -93.8% |
| Dispatch median, including host row materialization |   0.0659 ms |          0.0490 ms | -25.6% |

The absolute stress timings are higher than the normal 12-round
benchmark because the experiment repeatedly creates both candidates
and induces more collection. The order-balanced relative result,
allocation counts, and byte counts all support the same target.

### Selection-only v4 boundary

`Illuminate.Animation.FirSelection` implements the source side of the
compact boundary without modifying the accepted v3 modules. It adds:

- `SelectionAnimation`, whose retained `PlayerAnimation` contains only
  timing, segment bounds, and steps;
- `FrameSelection`, containing frame, step, segment, local frame,
  segment change, and playback status;
- `initialSelectionLive`; and
- `transitionSelectionLive`.

Both entry points reuse `initialPrepared` and `transitionPrepared`, so
there is still one playback state machine. The initial entry validates
the timeline through `validatePrepared` and rejects any nonempty patch
table. The JavaScript `createFirSelectionDomRenderer` then applies the
host-owned row selected by Lean.

This avoids new scalar casts: the sampled evidence does not justify
changing frame/index types before removing the string boundary.
Acceptance must reuse the 106 traces after host-side materialization,
all event and patch-target cases, binary64 boundary timestamps, two
players, callback cancellation/disposal, the 10,000-tick frontier
test, and all 16 dashboard DOM comparisons. String interning remains a
valid smaller FIR-adapter optimization, but its measured ceiling is
much lower and it leaves per-tick string decoding in place.

## Historical v2 whole-trace results

The following measurements describe the v2
`Illuminate.AnimationPlayer.replayTrace` package at FIR commit
`658d36e6388197649da7a63198aec8454306727d`. They explain why v2
remains a test oracle rather than the live backend. The reproducible
harness is `scripts/measure-fir-native.mjs`.

### Fixed whole-trace results

| Workload                       | Events |  Project |    Encode |  Execute |    Decode |     Total | Frontier growth |
| ------------------------------ | -----: | -------: | --------: | -------: | --------: | --------: | --------------: |
| Pause-driven slide show        |      0 | 0.134 ms |  1.096 ms | 0.077 ms |  0.187 ms |  1.672 ms |         4,904 B |
| Pause-driven slide show        |      1 | 0.104 ms |  1.034 ms | 0.124 ms |  0.230 ms |  1.699 ms |         5,488 B |
| Pause-driven slide show        |     30 | 0.080 ms |  1.561 ms | 1.166 ms |  1.795 ms |  4.569 ms |        29,424 B |
| Morphing arrows and final loop |      0 | 1.790 ms | 49.937 ms | 0.129 ms |  0.037 ms | 52.946 ms |       998,248 B |
| Morphing arrows and final loop |      1 | 2.029 ms | 50.577 ms | 0.301 ms |  0.105 ms | 53.521 ms |       998,736 B |
| Morphing arrows and final loop |     30 | 2.036 ms | 60.378 ms | 1.447 ms | 14.709 ms | 78.924 ms |     1,428,688 B |

The parameter-heavy animation is 621,193 bytes as generated browser
JSON. Its compact FIR object graph occupies about 997 KB before any
event is processed and performs about 9,537 resident input
allocations. Encoding the animation dominates a zero-event call.

Warm compilation plus instantiation of the 50 KB module had a 1.329 ms
median after warmup (1.806 ms p95). This is cheap enough that
per-player instances remain a possible ownership strategy, but it does
not solve per-event arena growth.

### Paired FIR-native and VIR-typed boundary

The harness alternates fresh FIR and VIR runtimes over the identical
prepared 30-event morph trace. Each observation is the median of seven
calls, with setup excluded.

| Runtime    |                                        Boundary input |  Execute |    Decode | Total wall |
| ---------- | ----------------------------------------------------: | -------: | --------: | ---------: |
| FIR native |      47.595 ms prepare, including 1.179 ms projection | 1.550 ms | 14.607 ms |  58.313 ms |
| VIR typed  | 36.647 ms marshal; projection performed before timing | 9.382 ms | 10.525 ms |  56.930 ms |

FIR executes the Lean closure about six times faster in this workload.
That gain is presently hidden by repeated object-graph encoding and
action decoding. The paired FIR wall-time delta had a -2.8% median but
ranged from -27.3% to +29.7%; the honest conclusion is parity within
the noise, not a total-time winner.

### Why whole-trace replay cannot be the live backend

Replaying every event prefix models the tempting adapter workaround of
appending a timestamp and calling `replayTrace` on every animation
frame:

| Workload                       | Prefixes replayed | Cumulative time | Resident frontier growth |
| ------------------------------ | ----------------: | --------------: | -----------------------: |
| Pause-driven slide show        |             1–120 |      328.369 ms |              7,399,000 B |
| Morphing arrows and final loop |              1–30 |    1,572.023 ms |             36,191,424 B |

This path repeatedly projects and encodes the animation, recomputes
every preceding transition, decodes every preceding action, and
retains all allocations until the instance is discarded. Its time and
space costs grow quadratically with the trace length. It must remain a
differential-test backend.

## Integrated live boundary

Illuminate now provides two thin FIR-facing declarations in
`Illuminate.Animation.FirLive`:

```lean
initialLive : PlayerAnimation → Except String LiveTransition
transitionLive : PlayerAnimation → PlayerState → PlayerEvent → LiveTransition
```

`LiveTransition` contains the next `PlayerState`, the `FrameAction`,
and `scheduleNextFrame`. The last field is computed from
`PlaybackStatus.isActive` in Lean, so the browser host does not
duplicate playback semantics.

`player_js/fir_live_player.js` supplies the matching host boundary.
It:

- accepts an opaque native player handle;
- sends one `PlayerEvent` per interaction or animation callback;
- follows Lean's `scheduleNextFrame` decision;
- installs browser-owned synchronization SVG when requested;
- applies only the returned text or attribute updates; and
- cancels callbacks and disposes the handle idempotently.

The dashboard candidate side is abstracted behind `advance`, `pause`,
`seek`, and `dispose`. Its backend selector enables FIR only after a
staged package passes the v3 contract checks. The host contract has a
deterministic fake-adapter test:

```sh
npm run test:fir-live-host
```

The consumer-side package gate intentionally requires an immutable
package directory, not the moving `illuminate-player-current` pointer:

```sh
ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/illuminate-player-packages/package-id \
  npm run test:fir-live-package
```

The gate checks the adapter, input-layout, and ownership versions; the
zero-import Wasm surface; exact Illuminate source hashes; all six
events; both patch targets; binary64 values immediately around a frame
rounding boundary; two simultaneous players; owner isolation; pending
callback cancellation; idempotent disposal; and a 10,000-tick scratch
frontier plateau. The existing 106-trace test remains the independent
JavaScript semantic oracle.

Accepted live packages are staged atomically in a separate directory,
so the v2 whole-trace package remains available to the 106-way oracle:

```sh
ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/illuminate-player-packages/package-id \
  npm run stage:fir-live
```

The dashboard probes `test_output/fir-live` and enables its FIR option
only when the v3 adapter validates. Switching candidates pauses both
columns at their current frame, disposes the old native or VIR player,
mounts the new backend, and checks the resulting SVG DOM against the
JavaScript reference. Its phase panel reports event encoding, native
execution, decoding, frontier rewind, DOM application, outer overhead,
scratch high-water, and one-time creation/resident memory.

Two reproducible measurement surfaces cover the live boundary:

```sh
ILLUMINATE_FIR_LIVE_PLAYER_DIR=/absolute/path/to/immutable/package \
  npm run measure:fir-live
npm run measure:live-dashboard
```

The first dispatches fixed 60 Hz timestamps directly and writes the
core-only `test_output/perf/fir-live-phases.json`. The second drives
the real browser dashboard and writes the DOM-inclusive rolling sample
to `test_output/perf/live-dashboard-phases.json`; browser paint and
compositing remain outside that measurement.

The accepted adapter implements this boundary:

```ts
interface FirLivePlayerAdapter {
    createPlayer(animation: AnimData):
        | {
              ok: true;
              player: opaque;
              action: FrameAction;
              scheduleNextFrame: boolean;
          }
        | { ok: false; error: string };

    dispatch(
        player: opaque,
        event: PlayerEvent,
    ):
        | {
              ok: true;
              action: FrameAction;
              scheduleNextFrame: boolean;
          }
        | { ok: false; error: string };

    disposePlayer(player: opaque): void;
}
```

The adapter retains `PlayerAnimation` and `PlayerState` in Wasm. It
encodes only a `PlayerEvent` on dispatch, exposes no Wasm address, and
returns copied actions. Each player owns a separate instance. The
animation and fixed state slot live below a persistent checkpoint;
temporary input and output live above it, are cleared, and are rewound
after every call. Disposing the opaque handle releases the instance.

## Acceptance results

The final package passed every Illuminate-side gate:

1. The original JavaScript, VIR JSON, VIR typed, and v2 FIR native
   implementations matched all 106 generated traces.
2. The v3 event-by-event gate exercised `advance`, `pause`, `seek`,
   `playTo`, `loopAt`, and `tick`.
3. `PatchTarget.attribute` and `PatchTarget.textContent` both decoded
   correctly.
4. Timestamps immediately below and above 50 ms retained their exact
   binary64 values.
5. Two players remained isolated, pending callbacks were cancelled,
   and disposal was idempotent.
6. A 10,000-tick stress run retained one memory page and returned to
   its persistent checkpoint after every dispatch.
7. The browser backend switch preserved the frame, disposed the old
   backend, mounted FIR, and kept all 16 SVG DOMs equal to JavaScript.

No Illuminate-side workaround or adapter-side semantic translation was
needed. The next optimization target is the one-time input encoder,
especially the 9,547 allocations and roughly 997 KB resident graph for
the 621 KB morph animation. Steady-state dispatch is already small and
bounded; within it, copied action decoding is the largest measured
phase.
