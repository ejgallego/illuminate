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

| Area                                                  | JavaScript reference                                                   | Lean/VIR/FIR implementation                                                          | Classification                    | Evidence                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------- | ----------------------------------------------------------------- |
| Frame, step, pause, loop, and directed-play decisions | Mutable JavaScript player fields                                       | `PlayerState` and `PlayerEvent` transitions                                          | No intended semantic divergence   | 106 deterministic legacy/VIR/FIR traces                           |
| Timestamp arithmetic                                  | JavaScript binary64 and positive rounding                              | Lean `Float`, transported as binary64, with JavaScript-compatible rounding           | No intended semantic divergence   | Boundary traces around frame rounding and non-integral timestamps |
| Invalid generated data                                | Assumes the generator supplied valid data                              | Rejects malformed FPS, segments, steps, and parameter alignment once                 | Intentional validation difference | Lean validation tests and native rejected-create tests            |
| Synchronization SVG                                   | Stored and installed by JavaScript                                     | Selection VIR/FIR leave it in JavaScript; full VIR retains it beside the pure player | Representation-only divergence    | Compact projection guards and DOM structural tests                |
| Patch target classification                           | Compares each attribute name with `textContent` while rendering        | Converts once to `PatchTarget.textContent` or `PatchTarget.attribute`                | Representation-only divergence    | Differential actions exercise both constructors                   |
| Parameter selection                                   | Selects the segment's local parameter row in JavaScript                | Full VIR emits updates; selection VIR/FIR return indices for the shared JS renderer  | Boundary-only divergence          | Expanded compact actions match full actions                       |
| Scheduling                                            | JavaScript derives whether to request another frame from mutable flags | Lean returns `scheduleNextFrame`; the host only follows it                           | Ownership-boundary divergence     | Host test covers schedule, cancellation, and disposal             |
| Player ownership                                      | Ordinary JavaScript object and callback closure                        | VIR `JSL` handle or opaque FIR instance handle                                       | Runtime-only divergence           | Two-player isolation, release, and wrong-owner tests              |
| Per-event memory                                      | JavaScript garbage-collected allocations                               | FIR persistent animation/state below a checkpoint and resettable scratch above it    | Runtime-only divergence           | Required 10,000-tick frontier plateau                             |
| DOM writes                                            | Applies every update returned for a frame                              | Applies every update returned for a frame                                            | No current operational divergence | Side-by-side DOM comparison                                       |

## Compact live boundary

The compact timeline/action boundary is implemented by FIR v4 and the
selection-only VIR player. It removes parameter strings and bindings
from the Lean timeline. Lean still selects the frame, step, segment,
local frame, segment-change flag, playback state, and whether another
callback is required. The browser uses those indices to retrieve
immutable rendering data and apply it. This moves a mechanical array
lookup without moving pause, loop, seek, timing, or playback decisions
into JavaScript.

The existing full `FrameAction` path remains the oracle. Differential
tests expand every compact action through the original animation data
and require exact agreement before either compact runtime is accepted.

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
