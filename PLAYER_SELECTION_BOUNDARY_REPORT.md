# Animation player selection-boundary comparison

## Result

Illuminate now has a selection-only VIR player at the same application
boundary as FIR v4. JavaScript, VIR selection, and FIR selection
retain the original `AnimData` object in the browser and call the
exact same `createSelectionDomRenderer`. SVG documents, parameter
bindings, and per-frame strings do not cross either Lean runtime
boundary.

A balanced three-run browser sample over all 16 showcase animations
measured:

| Candidate        | Paired JavaScript | Candidate callback | Absolute overhead | Ratio to paired JS |
| ---------------- | ----------------: | -----------------: | ----------------: | -----------------: |
| VIR selection    |          0.031 ms |           0.154 ms |          0.123 ms |              4.96× |
| VIR full         |          0.025 ms |           0.227 ms |          0.201 ms |              9.00× |
| FIR selection v4 |          0.048 ms |           0.074 ms |          0.026 ms |              1.54× |

All 16 rendered SVG DOMs matched in every observation. Selection-only
VIR was about 32% cheaper than full VIR at the whole-callback level.
Its interpreted execute phase was about 50% cheaper, which confirms
that moving patch-row construction and DOM imports out of interpreted
Lean removed real work.

The remaining VIR cost is now much easier to interpret: it is chiefly
the interpreter running the pure player transition, rather than SVG
transfer or DOM patching.

## Matched boundary

The three selection lanes differ only in who makes the playback
decision:

| Concern               | JavaScript reference | VIR selection                  | FIR selection v4           |
| --------------------- | -------------------- | ------------------------------ | -------------------------- |
| Original `AnimData`   | retained in JS       | retained in JS                 | retained in JS             |
| SVG, bindings, values | direct JS access     | never transferred              | never transferred          |
| Timeline preparation  | direct field access  | compact typed projection once  | compact Wasm encoding once |
| Player state          | JS closure fields    | Lean `RuntimeRef` behind `JSL` | persistent Wasm state slot |
| Per-tick input        | timestamp            | typed `PlayerEvent`            | encoded `PlayerEvent`      |
| Playback decision     | JavaScript           | interpreted Lean               | compiled Lean              |
| Per-tick output       | six-field selection  | same six-field selection       | same six-field selection   |
| DOM application       | shared renderer      | shared renderer                | shared renderer            |

The projection contains only FPS, total frame count, segment bounds,
and step metadata. The host does not inspect or reinterpret the
resulting playback state; it follows `scheduleNextFrame` and
materializes the selected patch row.

FIR cannot retain an arbitrary JavaScript object inside module-owned
linear memory, so its adapter encodes the compact projection and
leaves the original object in its host closure. VIR could represent
the object as an opaque `Js` resource, but that is unnecessary at this
boundary: the JavaScript renderer already retains it and Lean never
needs to inspect the heavy fields.

## VIR implementation

The compact VIR player exports four typed operations:

```text
Illuminate.Animation.Vir.mountSelectionPlayer
Illuminate.Animation.Vir.selectionPlayerSnapshot
Illuminate.Animation.Vir.dispatchSelectionPlayer
Illuminate.Animation.Vir.disposeSelectionPlayer
```

Mount validates `SelectionAnimation` once and returns a `JSL` handle.
The handle retains the compact animation and a `RuntimeRef` containing
`PlayerState` and the last `FrameSelection`. Dispatch accepts all six
`PlayerEvent` constructors, applies `transitionSelectionLive`, updates
the retained state, and returns:

```text
frame
step
segment
localFrame
segmentChanged
playback
scheduleNextFrame
```

The JavaScript host owns `requestAnimationFrame`, cancellation,
disposal, and the shared renderer. Disposing releases the `JSL` lease;
subsequent use of the released handle is rejected by VIR. No VIR
source change or application-only host import was required.

Full VIR remains available in the dashboard. It keeps the earlier
design in which Lean owns patch tables, constructs `AttributeUpdate`
arrays, retains DOM targets as `Js Element` resources, and calls DOM
imports from interpreted Lean. It is now a useful control rather than
the default candidate.

## Phase measurements

The harness uses a fresh browser context per observation, alternates
backend order, runs three 3-second observations per backend, and takes
the median of each observation's mean across 16 active players. Phase
timing was enabled. Callbacks include synchronous player and DOM work
but exclude browser painting and compositing.

| Phase                | VIR selection |                 VIR full | FIR selection |
| -------------------- | ------------: | -----------------------: | ------------: |
| Input marshal/encode |     0.0113 ms |                0.0023 ms |     0.0084 ms |
| Execute              |     0.1067 ms |                0.2154 ms |     0.0178 ms |
| Decode               |     0.0108 ms |                0.0009 ms |     0.0166 ms |
| Rewind               |     0.0000 ms |                0.0000 ms |     0.0011 ms |
| Shared DOM apply     |     0.0098 ms | 0.0798 ms within execute |     0.0142 ms |
| Outer host/adapter   |     0.0070 ms |                0.0065 ms |     0.0102 ms |
| Whole callback       | **0.1537 ms** |            **0.2265 ms** | **0.0739 ms** |

The JavaScript baseline varied between backend contexts, so ratios use
the JavaScript observation paired with each candidate. Browser timer
quantization, segment changes, and scheduling make the very small
host-rendering cells noisy. The execute-phase reduction and
whole-callback absolute deltas are the more useful signals. Phase
instrumentation itself has measurable overhead and is disabled in the
normal showcase.

Run the measurement with:

```sh
npm run measure:live-dashboard -- --duration-ms 3000 --runs 3
```

It writes raw observations and summaries to
`test_output/perf/live-dashboard-phases.json`.

The dashboard also renders this ratio directly for every example. The
numeric badge is candidate mean callback time divided by the
JavaScript mean beside it over the same rolling window. A fixed marker
denotes 1× and the bar is capped at 10× so one slow example does not
make the other bars unreadable. The aggregate candidate card reports
the ratio of the two active-row means. The structured report records
both `callbackOverheadRatio` and `callbackOverheadMs`.

## Direct transition split

Two diagnostic typed exports isolate a compact transition from
retained VIR ownership:

```text
Illuminate.Animation.Vir.initialSelectionDirect
Illuminate.Animation.Vir.transitionSelectionDirect
```

The benchmark threads the returned `PlayerState` through the direct
entry and runs the same events through a mounted selection player.
Calls are paired, their order alternates, target resolution is warm,
and every direct selection and scheduling decision must equal the
retained result. The table reports the median of five rounds with
2,000 measured ticks per workload and round:

| Workload                       | Direct execute | Retained execute | Execute delta | Retained host imports | Direct total | Retained total |
| ------------------------------ | -------------: | ---------------: | ------------: | --------------------: | -----------: | -------------: |
| Pause-driven slide show        |      0.0836 ms |        0.0893 ms |    +0.0057 ms |             0.0018 ms |    0.1660 ms |      0.1029 ms |
| Morphing arrows and final loop |      0.0737 ms |        0.0796 ms |    +0.0058 ms |             0.0015 ms |    0.1264 ms |      0.0905 ms |

`hostMs` is nested within `executeMs`; it is not additive. It
attributes the synchronous JSL and `RuntimeRef` host operations. The
execute delta is only an approximate price for retention because the
direct entry accepts and returns `PlayerState`, while the retained
entry accepts a handle and returns only the selection. Even with that
caveat, retained ownership accounts for roughly 6–9% of execute in
this paired Node sample, not most of it.

The retained boundary is substantially cheaper end to end: avoiding
repeated animation/state marshaling saves more than the handle and
runtime-reference operations cost. This rejects replacing the
production retained handle with a stateless typed transition. The
absolute Node timings are not comparable to the browser table above;
only the within-run paired deltas are used here.

Run the split with:

```sh
npm run measure:vir-selection-core
```

It writes raw samples and environment identities to
`test_output/perf/vir-selection-core.json`.

## Compatibility and lifecycle evidence

The differential suite expands both compact selection outputs through
the original browser-owned patch rows before comparison. At the FIR v4
package baseline, all 106 traces matched the legacy JavaScript, VIR
JSON, VIR typed full-action, VIR selection, FIR native full-action,
and FIR selection implementations.

The later `fix: preserve initial animation step` commit adds a 107th
trace with two steps at frame zero. JavaScript and all three VIR lanes
now select step 0. The immutable FIR native and selection packages
were compiled from the previous `Player.lean` SHA-256
`3ed87ac8d6a21c0afb2b00efcde6f5390c47be336c09214c24ead847bdb4f306`;
the corrected source SHA-256 is
`e1f98f9d02118f4b61a3f935dbdf49b1c3caf7c0b52aa0f80b7232fb740cd620`.
The first FIR result therefore reports step 1 where the corrected
oracle reports step 0. Both FIR artifacts must be regenerated before
claiming 107-way six-lane parity. No adapter-side compatibility
translation was added.

Coverage includes every `PlayerEvent` constructor, pause and loop
boundaries, timestamp jumps, replay, directed playback, segment
changes, text content, and ordinary attributes. Additional tests cover
two independent VIR selection handles, use-after-release rejection,
pending callback cancellation, and idempotent host disposal.

## Next performance question

Selection-only VIR spends approximately 0.107 ms of the 0.154 ms
browser callback in interpreted execution. The direct split now shows
that `JSL` plus `RuntimeRef` is a minority of paired execute time and
that retaining animation/state is a net win once boundary conversion
is included.

The next experiment should keep the retained generic `PlayerEvent`
path as the differential oracle and measure a specialized scalar tick
export against it. That will price custom-inductive event marshaling
without changing state ownership. If the saving is only around the
current 0.010–0.011 ms input phase, application-level specialization
is not justified; the larger remaining target is interpreter execution
of the transition itself. Full VIR should remain the end-to-end
rendering control.

For FIR, bulk animation marshaling is no longer the priority. Its
remaining tens-of-microseconds gap is distributed across event
encoding, compiled Lean execution, selection decoding, rewind, and
adapter bookkeeping.
