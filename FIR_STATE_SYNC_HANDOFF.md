# FIR handoff: resident Illuminate state synchronization

This task uses branch-only coordination. Keep the work on a named
`ejgallego/lean-fir` branch and do not open a pull request.

Run the separate `FIR_UNTIMED_DISPATCH_HANDOFF.md` experiment first.
Do not combine its adapter-diagnostics change with this resident-state
experiment; Illuminate needs independent packages to attribute each
boundary improvement.

## Starting point

Use the clean scalar-tick FIR head and publish it before building on
it:

```text
FIR repository:  git@github.com:ejgallego/lean-fir.git
FIR revision:    ac7467f3af9598400be1f175510aff339ac6113a
suggested base branch: wasm/illuminate-scalar-tick

Illuminate repository: git@github.com:ejgallego/illuminate.git
Illuminate branch:     feat/vir-performance
Illuminate source:     5a5f2b7d1ced7db4eed405315146b9687fd05252
```

The accepted immutable package is:

```text
integration/illuminate-player/_build/illuminate-selection-player-packages/
  ac7467f3af95-5a5f2b7d1ced-fb32d68c8d7915e19c8b

Wasm bytes:   56,156
Wasm SHA-256: 8b13c8124ba7235e2a00cec154f42d406e6f568f071f51ec831bbb95486ae3f5
imports:      zero
memory:       module-owned
exports:      seven functions plus memory
```

Illuminate has consumed this package locally. The scalar hot path is
used only for requestAnimationFrame ticks; generic structured dispatch
remains the semantic oracle. The 107-way differential suite, adjacent
binary64 timestamp cases, lifecycle checks, concurrent players, and
10,000-tick exact-checkpoint test all pass. Scalar ticks allocate zero
host scratch bytes.

## Measured problem

After scalar tick integration, a fresh 1,200-tick core run reported:

| Workload                   | Tick wall | Encode | Execute | Decode/state sync | Rewind | Scratch |
| -------------------------- | --------: | -----: | ------: | ----------------: | -----: | ------: |
| Pause-driven slide show    |     51 µs |   1 µs |   17 µs |             24 µs |   2 µs |     0 B |
| Morphing arrows/final loop |     54 µs |   1 µs |   15 µs |             26 µs |   2 µs |     0 B |

Absolute microseconds vary between processes, but the phase ranking is
stable. Earlier instrumentation split `decodeMs` as follows:

| Decode work                      |    Pause |    Morph |
| -------------------------------- | -------: | -------: |
| Transition header and validation |  4.43 µs |  4.25 µs |
| Selection decode                 |  7.08 µs |  8.64 µs |
| Returned `PlayerState` read      | 13.77 µs | 14.06 µs |
| Persistent state-slot write      |  4.07 µs |  4.41 µs |
| JavaScript result construction   |  0.37 µs |  0.43 µs |

The regenerated DOM-inclusive dashboard then ran three balanced
five-second observations in fresh browser contexts. All 16 rows
matched the JavaScript DOM in every run:

```text
paired FIR / JS callback ratio: 2.00x median (1.93x–2.10x)
paired callback overhead:       72.7 µs median (70.1–81.6 µs)
JavaScript callback mean:       74.0 µs
FIR callback mean:              145.2 µs
```

The FIR rolling phase means were 2.6 µs input, 40.5 µs execute, 40.9
µs decode/state sync, 5.1 µs rewind, 22.0 µs DOM apply, and 25.5 µs
outer adapter gap. Browser paint and compositing are excluded. This
makes the state/result boundary the largest targeted FIR phase and
puts a concrete end-to-end ceiling on the experiment.

The adapter currently calls `decodeLiveSelectionTransition`, traverses
the returned general Lean `PlayerState`, validates five
`Nat`/`Option Nat` fields and one `Option Float`, then
`copyPlayerStateToSlot` rewrites a fixed persistent graph before the
scratch arena is rewound. State read plus slot write accounts for
42–46% of `decodeMs`. Reusing selection fields in JavaScript was
measured and rejected: it changed overall decode by only about 2%, did
not improve wall time, and added a semantic coupling.

## Requested FIR experiment

Generate an in-Wasm state synchronization path for the persistent live
player. The preferred outcome is that transition evaluation updates a
resident `PlayerState` slot, or an equivalent compact state ABI,
without JavaScript traversing and reconstructing the returned state.
Return only the browser-visible `FrameSelection` and scheduling
decision for normal dispatch.

This should be an FIR lowering/runtime capability, not a second
Illuminate state machine. Preserve these constraints:

- call the real `initialSelectionLive` and `transitionSelectionLive`
  semantics, or a mechanically generated ABI specialization of them;
- keep generic `dispatch(player, PlayerEvent)` and the pure structured
  entry as differential oracles;
- do not introduce Illuminate-side `Nat` to `UInt32`/`UInt64` casts;
- transport `Float` timestamps bit-exactly;
- keep animation projection resident and host-owned SVG patch tables
  outside Wasm;
- retain zero imports, module-owned memory, exact checkpoint rewind,
  independent player ownership, poisoning on failed execution/decode,
  and instance-drop reclamation;
- do not infer state fields from the returned selection in JavaScript.

Two acceptable implementation shapes are a generated in-place export
that copies logical state inside Wasm into the reserved persistent
slot, or a generated compact transition/result ABI with equivalent
ownership. Please report the chosen ownership invariant explicitly.

## Acceptance

The generated package should provide both the existing generic paths
and the candidate resident-state path so Illuminate can compare them
within one module. Acceptance requires:

1. all 107 legacy/VIR/FIR traces match through the generic oracle and
   the candidate path;
2. all six `PlayerEvent` constructors remain covered, with scalar tick
   equivalent to generic tick;
3. timestamps immediately below and above a binary64 boundary retain
   their exact bits;
4. both `PatchTarget` constructors materialize correctly;
5. disposal, cross-adapter ownership rejection, two concurrent
   players, and poisoned-player behavior pass;
6. 10,000 ticks keep a flat persistent checkpoint after warmup, with
   no growing resident roots;
7. Wasm retains zero imports and module-owned memory;
8. the adapter reports separate output decode and state-sync timings
   during evaluation, then documents any timing field removed by the
   final API;
9. an interleaved generic/candidate benchmark reports median and p95
   wall, execute, output decode, state sync, rewind, scratch bytes,
   and allocation calls for both Illuminate workloads.

The primary success metric is reduced callback wall time caused by
removing JavaScript state traversal/copy. Do not claim success from a
lower `decodeMs` if the work merely moved into an unmeasured phase.

## Return to Illuminate

Provide the named `ejgallego/lean-fir` branch and exact head,
immutable package path, complete and base Wasm hashes/sizes,
import/export list, adapter and ownership capability versions, source
revisions/hashes, test results, detailed paired timings, and any
remaining runtime or ownership limitation. Do not open a pull request.
