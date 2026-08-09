# FIR selection-player v4 handoff

## Objective

Generate a separately versioned persistent FIR package for
Illuminate's selection-only player. The package must keep SVG
synchronization documents, parameter bindings, and per-frame parameter
strings in JavaScript. Lean remains the sole owner of frame timing,
steps, pauses, loops, seeks, segment selection, and playback state.

This is the measured optimization target. Do not replace or mutate the
accepted v3 package.

## Illuminate source

Consume the sources read-only from:

```text
/home/egallego/lean/illuminate/.worktrees/vir-performance
```

Illuminate branch and current tracked base:

```text
branch: feat/vir-performance
base:   006dc1d1db18c5dc73d637c926cf132e88df05b5
```

The worktree is intentionally dirty. Use these exact source hashes:

```text
src/Illuminate/Animation/Types.lean
97a030fdd3ef718912479343cadf0131616a8a9b458901e963dc3709cf5633a3

src/Illuminate/Animation/Player.lean
3ed87ac8d6a21c0afb2b00efcde6f5390c47be336c09214c24ead847bdb4f306

src/Illuminate/Animation/FirLive.lean
941daf939d9faa966aa8fb848b4a8f7ce0525ba6420d3843067e2c97908e2121

src/Illuminate/Animation/FirSelection.lean
a80771bcc8a4b09db99f004559726654dacc102d9982909ccf863f3d60ed0e83
```

The first three hashes are unchanged from the accepted v3 package.
Illuminate currently builds with Lean 4.33.0-rc2; the FIR generation
lane currently uses Lean 4.32.0. Compile the exact new source under
FIR's toolchain and report any source-compatibility issue rather than
editing Illuminate in the FIR worktree.

## Lean entries

Compile these real entries from `Illuminate.Animation.FirSelection`:

```lean
Illuminate.AnimationPlayer.initialSelectionLive :
  SelectionAnimation → Except String LiveSelectionTransition

Illuminate.AnimationPlayer.transitionSelectionLive :
  SelectionAnimation → PlayerState → PlayerEvent → LiveSelectionTransition
```

`SelectionAnimation.timeline` is a `PlayerAnimation`, but every
segment must have empty `paramMap` and `params` arrays.
`initialSelectionLive` rejects a nonempty patch table and reuses
`validatePrepared` for timeline invariants. Both entries reuse
`initialPrepared`/`transitionPrepared`; do not duplicate or
special-case the state machine.

`LiveSelectionTransition.selection` contains exactly:

```text
frame
step
segment
localFrame
segmentChanged
playback
```

It intentionally contains no attribute names, text markers, or
parameter strings.

## Browser projection and adapter

Project the existing browser `AnimData` once at `createPlayer`:

```text
SelectionAnimation.timeline.fps         := animation.fps
SelectionAnimation.timeline.totalFrames := animation.totalFrames
SelectionAnimation.timeline.segments    :=
  animation.segments.map ({ sf, fc, ... }) =>
    { startFrame := sf, frameCount := fc, paramMap := #[], params := #[] }
SelectionAnimation.timeline.steps       := animation.steps
```

Do not encode `sync`, `pmap`, or `params`. JavaScript already retains
the original `AnimData` for DOM rendering.

Use these proposed capability identifiers:

```text
browser adapter: fir.illuminate-player.browser/v4
input layout:    lean-4.32-Illuminate.Animation.SelectionAnimation/v4
ownership:       fir.illuminate-player.persistent-checkpoint/v2
runtime:         fir.illuminate-player.complete-runtime/v1
```

The module should export exactly these functions in addition to
module-owned memory:

```text
Illuminate.AnimationPlayer.initialSelectionLive
Illuminate.AnimationPlayer.transitionSelectionLive
fir_heap_frontier
fir_heap_set_frontier
fir_heap_rewind
fir_heap_alloc
```

Keep the v3 ownership model: one shared `WebAssembly.Module`, one
instance per opaque player, retained selection animation and fixed
state slot below a persistent checkpoint, per-call event/result
scratch above it, zeroed scratch, exact rewind, idempotent disposal,
and no Wasm address exposed to application JavaScript.

The browser result may expose `selection` as `action` to reuse the
existing scheduler, but it must not synthesize an update array.
Illuminate's `createFirSelectionDomRenderer` indexes the host-owned
`pmap` and `params[localFrame]` and handles both `textContent` and
ordinary attributes.

## Acceptance

The generated package should demonstrate:

1. all 106 reference traces match after host-side patch-row
   materialization;
2. all six `PlayerEvent` constructors are supported;
3. binary64 timestamps around the 50 ms rounding boundary are
   bit-exact;
4. both text-content and attribute bindings materialize correctly;
5. two players remain isolated;
6. pending callbacks are cancelled and disposal is idempotent;
7. 10,000 tick dispatches return exactly to the checkpoint;
8. the Wasm has zero function imports and zero memory imports; and
9. the 16-example browser dashboard retains 16/16 DOM matches.

For the 621,193-byte morph workload, the v3 graph used 997,480 bytes,
9,547 persistent allocations, and 16 pages. A temporary selection
projection using the existing v3 entry used 12,648 bytes, 324
allocations, and one page. The new entry omits even the empty
per-frame rows, so a reasonable package smoke gate is:

```text
resident selection animation <= 16 KiB
persistent allocations <= 400
memory pages after creation == 1
```

Report phase timings for projection, selection encoding, execution,
selection decoding, rewind, and outer overhead. Do not add UInt/Nat
conversion work in this iteration: sampled profiles identify string
transfer, not scalar arithmetic, as the dominant cost.

## Illuminate-side checks already present

```sh
lake build Illuminate.Animation.FirSelection
lake build IlluminateTests.Animation
npm run test:fir-live-host
npx tsc --noEmit -p player_js/jsconfig.json
```

The Lean test compares selection state, output, and scheduling with v3
across all event constructors and verifies rejection of transferred
patch tables. The JavaScript test materializes both patch-target forms
from a host-owned row.

Return the immutable package path, FIR functional commit,
complete/base Wasm hashes and sizes, exact imports/exports, adapter
constants, source hashes, ownership measurements, phase measurements,
and all acceptance results.

## Wasm-generation follow-up: hot-event marshaling

The accepted v4 adapter makes the steady-state call as
`dispatch(player, { kind: "tick", timestamp })`. The animation graph
is retained, so the input cost below is only construction and encoding
of that one tagged event; it is not SVG, patch-table, or
animation-data transfer.

Two independent Illuminate measurements put that cost in perspective:

| Harness                           | Whole FIR callback | Event encode | Wasm execute | Result decode |     Rewind | Shared DOM |
| --------------------------------- | -----------------: | -----------: | -----------: | ------------: | ---------: | ---------: |
| Node, pause workload              |           0.010 ms |     0.001 ms |     0.003 ms |      0.004 ms |  <0.001 ms |        n/a |
| Node, morph workload              |           0.009 ms |     0.001 ms |     0.003 ms |      0.004 ms |  <0.001 ms |        n/a |
| Chromium, 16-example balanced run |         0.04814 ms |   0.00477 ms |   0.01073 ms |    0.01196 ms | 0.00070 ms | 0.00780 ms |

The Node figures are means from 12 fresh player-creation rounds and
1,200 dispatches after 60 warmups. The browser figure is the aggregate
mean from three fresh-context, 3,000 ms balanced-order runs with 16/16
DOM matches. Its paired JavaScript callback was 0.02976 ms, so FIR was
1.62× JS and the absolute gap was 0.01838 ms. Event encoding was 9.9%
of the whole FIR callback, 44% of Wasm execution time, and 26% of that
FIR-to-JS gap. Result decoding was a larger single boundary phase, so
event encoding is an important target but not the only boundary
target.

The most useful next wasm-generation experiment is a
constructor-specific hot path such as
`dispatchTick(player, timestamp)`. It should construct
`PlayerEvent.tick timestamp` inside Wasm and call the same
`transitionSelectionLive`; the generic `dispatch` remains the semantic
oracle and handles the five less frequent event constructors. This
isolates the cost of generic JavaScript tagged-object/Lean-inductive
lowering without changing Illuminate semantics or adding scalar casts.
The timestamp must remain a bit-exact binary64 `Float`.

Compare the generic and scalar paths in the same adapter and report
event encode, execute, decode, rewind, whole callback, and scratch
bytes. If the scalar entry removes most of the encode phase, the
reusable FIR improvement is constructor-specific adapter exports,
reusable event slots, or cheaper generic inductive lowering. If it
does not, split the existing `encodeMs` label further because it also
contains adapter bookkeeping.

This experiment belongs in FIR's wasm-generation adapter/compiler
lane; Illuminate should supply the workload, differential oracle, and
browser measurements. A regenerated package must use the corrected
`Player.lean` hash
`e1f98f9d02118f4b61a3f935dbdf49b1c3caf7c0b52aa0f80b7232fb740cd620` and
pass all 107 differential traces. In particular, do not optimize the
currently staged v4 Wasm in place: it predates the duplicate
frame-zero initialization fix.
