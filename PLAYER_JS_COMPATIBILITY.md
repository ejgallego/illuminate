# Player compatibility with the JavaScript reference

The original JavaScript player remains Illuminate's behavioral
reference while the Lean player is optimized for VIR and FIR. The
differential trace suite compares frame, step, segment, local-frame,
patch, and playback-state outputs for valid animation data.

## Deliberate representation differences

These differences should not change observable playback:

- `AnimationPlayer.prepare` validates and projects a
  `CompiledAnimation` once.
- `PlayerAnimation` omits segment synchronization SVG. The rendering
  host keeps those strings and installs one when
  `FrameAction.segmentChanged` is true.
- `PlayerParamBinding` stores `PatchTarget.textContent` or
  `PatchTarget.attribute` instead of comparing the string
  `"textContent"` on every frame.
- `transitionPrepared` returns `Transition` directly. It does not
  allocate an `Except` result or repeat validation for every event.
- Segment selection first checks `PlayerState.renderedSegment`, then
  falls back to the same ordered search used by the reference
  implementation.
- Step lookup uses binary search for arbitrary frames and advances
  from the cached step during playback. JavaScript scans backward, but
  both select the final step whose boundary is at or before the frame.
- Patch arrays reserve their validated result capacity before values
  are added.

The compatibility wrappers `initialTransition` and `transition` still
accept a `CompiledAnimation` and return `Except String Transition`.
They prepare their input on each call and exist for callers that have
not adopted the prepared API.

## Deliberately stricter input acceptance

JavaScript relies on generated data and tolerates some malformed
structures. `AnimationPlayer.prepare` rejects them before the
unchecked transition path can use them. Prepared input requires:

- positive FPS and at least one frame;
- at least one nonempty segment;
- contiguous segments starting at frame zero and covering
  `totalFrames`;
- exactly `frameCount` parameter rows per segment;
- exactly one parameter value per binding in every row; and
- nondecreasing step frames within the animation.

These checks describe invariants already maintained by
`compileAnimation`. Rejecting malformed external data is an
intentional difference from the permissive JavaScript fallback
behavior.

## Semantics that must remain identical

- positive timestamp rounding and frame clamping;
- pause traversal after timestamp jumps;
- loop wrapping, overshoot, and deferred loop exit;
- forward and reverse directed playback;
- end-of-animation replay;
- segment-change reporting; and
- update order, element indices, targets, and serialized values.

Run `npm run test:player-traces` after staging the available runtimes.
Generated traces exercise the legacy JavaScript oracle, VIR player,
and the staged FIR-native package. A FIR package predating a player
change proves behavioral compatibility, but it must be regenerated
before its size or timings can be used to evaluate that change.

## Optimization boundary

The prepared representation still uses `Nat`. Switching frames and
indices to bounded scalar types is intentionally deferred until the
representation and persistent-player changes have been measured. This
keeps the first optimization semantics-preserving and makes any later
FIR-specific numeric tradeoff easier to attribute.
