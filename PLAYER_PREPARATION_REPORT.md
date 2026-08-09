# Prepared player optimization report

## Goal

Reduce repeated work in Illuminate's Lean animation state machine when
it runs through VIR or is compiled to FIR-native Wasm, without
changing behavior for valid generated animation data.

## Implemented changes

- `AnimationPlayer.prepare` validates compiled input once and produces
  an SVG-free `PlayerAnimation`.
- Parameter bindings classify `textContent` and SVG attributes once.
- VIR mounts retain `PlayerAnimation` plus only the synchronization
  SVG array; they call `transitionPrepared` directly.
- `transitionPrepared` returns `Transition`, avoiding a successful
  `Except` result and validation on every event.
- Segment lookup first checks `PlayerState.renderedSegment`.
- Step lookup uses binary search for arbitrary frames and advances
  from the cached step during playback.
- Pause traversal reuses the selected target step instead of searching
  twice.
- Patch arrays reserve their validated capacity and use aligned
  indexed reads.
- `AnimationPlayer.replayTrace` provides a compact FIR-facing
  whole-trace entry that validates once and reserves its action array.

The old `initialTransition` and `transition` signatures remain
available as compatibility wrappers. They are not reachable from the
generated VIR package.

## Correctness and JavaScript compatibility

The differential suite now covers all six `PlayerEvent` constructors.
Its 106 fixed and generated traces agree across the legacy JavaScript
oracle, the new VIR implementation, and the previously generated
FIR-native package.

Prepared input deliberately rejects malformed structures that
JavaScript may tolerate. The exact compatibility boundary is
maintained in `PLAYER_JS_COMPATIBILITY.md`.

## VIR package shape

The following numbers compare the repository-local VIR package
immediately before this work and after the prepared player and lookup
changes:

| Measurement                |    Before |     After |             Change |
| -------------------------- | --------: | --------: | -----------------: |
| Lean IR declarations       |       641 |       675 |        +34 (+5.3%) |
| Native extern declarations |       102 |       102 |                  0 |
| Player package member      |  47,291 B |  70,502 B | +23,211 B (+49.1%) |
| Root VIR package member    | 207,318 B | 214,391 B |   +7,073 B (+3.4%) |
| JavaScript host imports    |        30 |        30 |                  0 |
| Interface exports          |        12 |        12 |                  0 |

This is a deliberate startup/code-size tradeoff: the package now
contains complete one-time structural validation and preparation code.
Its live path no longer includes the compatibility wrappers or their
repeated work. Future work should determine whether validation can be
compiled or staged separately without weakening the browser boundary.

After refreshing the private VIR checkout from the older
`feat/illuminate-runtime` branch to upstream commit
`5202d2743ebc9a27f63d52f0a4317841748f0e5d`, the closure counts and
public interface stayed unchanged. The player member decreased from
70,502 to 70,383 bytes, while the 214,391-byte root member was
unchanged. The older branch's environment-lookup commits were not
replayed because upstream already contains the maintained indexed
lookup in `f1629fa`.

## Boundary size

For the 16 generated dashboard animations, their compact browser JSON
totals 1,002,375 bytes. Removing synchronization SVG fields leaves
951,138 bytes, a 51,237-byte or 5.1% reduction. The SVG contents
themselves account for 46,807 bytes.

The aggregate is dominated by parameter-heavy morphs. Synchronization
SVG is a much larger fraction for structurally simple examples: 78.8%
for the pause-driven slide show and 75.5% for the array highlight. The
next FIR adapter must omit these strings rather than encode empty
placeholders.

## Current browser sample

`scripts/measure-player-dashboard.py` isolates the radial-gradient
spotlight, warms the rolling metric window for 2.5 seconds, and
samples a sustained loop for 5.5 seconds in fresh browser contexts.

The first five-run sample, before the VIR refresh, produced:

| Metric                      | JavaScript median | VIR median |
| --------------------------- | ----------------: | ---------: |
| Callback rate               |            59.0/s |     59.0/s |
| Mean callback               |           0.08 ms |    0.82 ms |
| p95 callback                |           0.20 ms |    2.30 ms |
| One-core callback share     |              0.5% |       4.8% |
| Long callbacks over 16.7 ms |                 0 |          0 |

VIR mean callback values ranged from 0.66 to 1.71 ms across those
runs, showing significant host-load sensitivity. This is a
reproducible post-change snapshot, not a paired proof of speedup. A
trustworthy attribution requires alternating old and new packages
under the same browser workload.

A second five-run sample after refreshing to VIR `5202d27` produced:

| Metric                      | JavaScript median | VIR median |
| --------------------------- | ----------------: | ---------: |
| Callback rate               |            59.0/s |     59.0/s |
| Mean callback               |           0.12 ms |    1.14 ms |
| p95 callback                |           0.30 ms |    2.20 ms |
| One-core callback share     |              0.7% |       6.8% |
| Long callbacks over 16.7 ms |                 0 |          0 |

The refreshed VIR means ranged from 0.64 to 2.37 ms. One run was
host-limited to about 40 callbacks per second, so this sample should
be treated as a compatibility and frame-budget gate, not evidence of a
regression from the earlier 0.82 ms median. A controlled old/new
alternating package test remains necessary for attribution.

The refresh introduced no unchecked casts or JavaScript type
assertions. `String` values cross the browser boundary through VIR's
existing `JsValue.ofString`, `JsValue.toString`, and consumed-string
ownership helpers; elements, nullable results, and node lists retain
their typed `Js` resource wrappers.

Run the sample with:

```sh
uv run scripts/measure-player-dashboard.py --runs 5
```

## FIR status

The final package compiles `Illuminate.AnimationPlayer.replayTrace`
with `PlayerAnimation` as its input. Its complete module is 50,194
bytes (18,005 bytes before the resident runtime), has zero imports,
exports only the replay entry and three arena functions, and owns its
memory. The v2 browser adapter omits synchronization SVG and passes
all 106 legacy/VIR-JSON/VIR-typed/FIR-native differential traces.
Exact generation and validation requirements are in
`FIR_PLAYER_REGENERATION.md`.

Bounded scalar types remain deferred until that package is measured.
Changing `Nat` now would combine representation, algorithmic, and
numeric effects and make the result harder to attribute.
