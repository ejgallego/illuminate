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

## Compatibility and lifecycle evidence

The differential suite expands both compact selection outputs through
the original browser-owned patch rows before comparison. All 106
traces match the legacy JavaScript, VIR JSON, VIR typed full-action,
VIR selection, FIR native full-action, and FIR selection
implementations.

Coverage includes every `PlayerEvent` constructor, pause and loop
boundaries, timestamp jumps, replay, directed playback, segment
changes, text content, and ordinary attributes. Additional tests cover
two independent VIR selection handles, use-after-release rejection,
pending callback cancellation, and idempotent host disposal.

## Next performance question

Selection-only VIR spends approximately 0.107 ms of the 0.154 ms
callback in interpreted execution. Marshal and decode together account
for about 0.022 ms; the shared DOM renderer is below 0.010 ms in this
sample. The next investigation should therefore split the execute
phase rather than further redesigning the data boundary:

1. Measure `transitionSelectionLive` through a direct typed entry
   without `JSL` and `RuntimeRef` to establish the pure interpreter
   cost.
2. Compare it with the persistent handle path to price
   `LeanRef.fromJSL` and `RuntimeRef.get`/`set` ownership work.
3. Only then test specialized scalar tick/advance exports or a
   retained dispatcher callback. Those change the call shape and
   should be justified by measured handle or custom-inductive
   overhead.
4. Keep the generic `PlayerEvent` path as the differential oracle and
   retain the full VIR renderer as the end-to-end control.

For FIR, bulk animation marshaling is no longer the priority. Its
remaining tens-of-microseconds gap is distributed across event
encoding, compiled Lean execution, selection decoding, rewind, and
adapter bookkeeping.
