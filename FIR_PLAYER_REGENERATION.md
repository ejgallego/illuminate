# FIR-native player regeneration handoff

Illuminate now exposes an SVG-free trace entry intended for the next
FIR-native package:

```lean
Illuminate.AnimationPlayer.replayTrace :
  PlayerAnimation → List PlayerEvent → Except String (Array FrameAction)
```

The same function is also exposed through VIR's structured-value ABI
as:

```lean
Illuminate.Animation.Vir.replayTraceTyped :
  PlayerAnimation → List PlayerEvent → Except String (Array FrameAction)
```

The JavaScript projection and result normalization used by the
differential suite live in `scripts/lib/vir-player-trace.mjs`. The
typed VIR entry and the older JSON compatibility entry both pass all
106 traces against the legacy JavaScript player. Use the typed
entry—not the JSON compatibility entry—for VIR/FIR boundary and
execution comparisons.

This replaces the previous native facade's `CompiledAnimation` input
and manual event loop. It calls the real player state machine,
validates the compact input once, reserves the complete result array,
and calls `transitionPrepared` without per-event validation or
`Except` allocation.

## Input layout

The adapter should encode these existing Illuminate declarations
directly:

```lean
structure PlayerAnimation where
  fps : Nat
  totalFrames : Nat
  segments : Array PlayerSegment
  steps : Array StepInfo

structure PlayerSegment where
  startFrame : Nat
  frameCount : Nat
  paramMap : Array PlayerParamBinding
  params : Array (Array String)

structure PlayerParamBinding where
  element : Nat
  target : PatchTarget

inductive PatchTarget
  | textContent
  | attribute (name : String)
```

When converting Illuminate's browser animation data:

- omit every segment's `sync` field;
- map `e` to `PlayerParamBinding.element`;
- map `a === "textContent"` to `PatchTarget.textContent`;
- map every other `a` to `PatchTarget.attribute a`; and
- preserve timestamps as bit-exact binary64 values.

The browser retains synchronization SVG and uses the returned
`segment` and `segmentChanged` fields to select it. No SVG string
should enter Wasm memory.

## Required comparison

Please report the old and new values for:

- source declarations and resident helpers;
- base and complete-runtime Wasm byte lengths;
- function and memory imports;
- function exports;
- encoded input bytes for every dashboard example;
- prepare, execute, and decode timings for identical traces; and
- resident frontier growth.

The repository's current trace suite contains 106 cases and exercises
all six `PlayerEvent` constructors. A regenerated adapter should pass:

```sh
ILLUMINATE_NATIVE_PLAYER_DIR=/absolute/package/path npm run stage:players
npm run test:player-traces
```

The final v2 package was generated from FIR commit
`658d36e6388197649da7a63198aec8454306727d`. Illuminate validates its
metadata, source hashes, zero-import contract, exact public exports,
and module-owned memory before staging it. The immutable package
passes all 106 legacy/VIR-JSON/VIR-typed/FIR-native differential
traces.

## Follow-up live contract

Whole-trace replay remains useful for differential testing. A live
dashboard backend will additionally need an instance API equivalent
to:

```text
create(PlayerAnimation) → PlayerHandle + initial FrameAction
dispatch(PlayerHandle, PlayerEvent) → FrameAction
dispose(PlayerHandle)
```

That API should retain the prepared animation and player state,
reclaim its arena on disposal, and avoid retransferring animation data
on each tick.
