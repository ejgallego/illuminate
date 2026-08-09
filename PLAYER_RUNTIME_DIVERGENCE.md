# Illuminate player runtime divergence ledger

## Purpose

The JavaScript player remains the behavioural reference while
Illuminate moves animation decisions into Lean. This ledger
distinguishes observable semantic changes from representation and
ownership changes introduced to reduce VIR and FIR overhead.

The acceptance rule is strict: an unexplained action mismatch is
recorded with its exact trace and stops integration. The browser
adapter must not repair or reinterpret a native result.

## Current boundary

| Area                                                  | JavaScript reference                                                   | Lean/VIR/FIR implementation                                                           | Classification                    | Evidence                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------- |
| Frame, step, pause, loop, and directed-play decisions | Mutable JavaScript player fields                                       | `PlayerState` and `PlayerEvent` transitions                                           | No intended semantic divergence   | 106 deterministic legacy/VIR/FIR traces                           |
| Timestamp arithmetic                                  | JavaScript binary64 and positive rounding                              | Lean `Float`, transported as binary64, with JavaScript-compatible rounding            | No intended semantic divergence   | Boundary traces around frame rounding and non-integral timestamps |
| Invalid generated data                                | Assumes the generator supplied valid data                              | Rejects malformed FPS, segments, steps, and parameter alignment once                  | Intentional validation difference | Lean validation tests and native rejected-create tests            |
| Synchronization SVG                                   | Stored and installed by JavaScript                                     | Never transferred into the player; the browser installs it using the selected segment | Representation-only divergence    | SVG-free `PlayerAnimation` source and DOM structural tests        |
| Patch target classification                           | Compares each attribute name with `textContent` while rendering        | Converts once to `PatchTarget.textContent` or `PatchTarget.attribute`                 | Representation-only divergence    | Differential actions exercise both constructors                   |
| Parameter selection                                   | Selects the segment's local parameter row in JavaScript                | Lean emits the complete `AttributeUpdate` array                                       | No intended semantic divergence   | Full action-array differential tests                              |
| Scheduling                                            | JavaScript derives whether to request another frame from mutable flags | Lean returns `scheduleNextFrame`; the host only follows it                            | Ownership-boundary divergence     | Host test covers schedule, cancellation, and disposal             |
| Player ownership                                      | Ordinary JavaScript object and callback closure                        | VIR runtime reference or opaque FIR player handle                                     | Runtime-only divergence           | Two-player isolation and wrong-owner tests                        |
| Per-event memory                                      | JavaScript garbage-collected allocations                               | FIR persistent animation/state below a checkpoint and resettable scratch above it     | Runtime-only divergence           | Required 10,000-tick frontier plateau                             |
| DOM writes                                            | Applies every update returned for a frame                              | Applies every update returned for a frame                                             | No current operational divergence | Side-by-side DOM comparison                                       |

## Proposed compact live boundary

The compact timeline/action boundary is not implemented. It will be
considered only after the persistent FIR baseline is accepted.

The proposed change removes parameter strings and bindings from the
native timeline. Lean would still select the frame, step, segment, and
local frame; the browser would use those indices to retrieve immutable
rendering data and apply it. This changes where a mechanical array
lookup occurs, but it does not move pause, loop, seek, timing, or
playback decisions into JavaScript.

The existing full `FrameAction` path will remain the oracle. A
differential test must expand every compact action through the
original animation data and match the full action exactly before the
compact boundary can be enabled.

## Change protocol

1. Records every semantic, transport, ownership, or DOM-write
   difference in this ledger.
2. Keeps legacy JavaScript traces and full Lean actions as independent
   oracles.
3. Measures initialization and steady-state dispatch separately.
4. Applies host-rendering optimizations uniformly to JS, VIR, and FIR.
5. Requires an immutable runtime package, exact source hashes, and a
   clean producer handoff.
6. Stops on a differential mismatch instead of adding adapter-side
   semantic translation.

## Ownership

- Illuminate owns the state-machine contract, differential traces,
  host renderer, dashboard, and consumer acceptance gates.
- VIR owns reference lifetime, typed call-plan caching, and
  interpreter-side phase reporting.
- FIR owns native closure generation, resident helpers, opaque
  handles, checkpoint reclamation, and generated browser adapters.
