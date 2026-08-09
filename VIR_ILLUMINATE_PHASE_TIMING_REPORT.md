# Illuminate on current VIR: boundary and retained-callback timing

Date: 2026-08-08

## Executive summary

Recent VIR main contains a real and valuable optimization: it caches
the normalization plans used to lower custom inductive values. In a
focused Illuminate workload containing 4,096 `PlayerEvent`
constructors, the cache reduced marshal time by a paired median 82.1%
and total call time by 13.7%. All 12 marshal observations improved.

That optimization does not materially change the representative
whole-trace call. Its 611,001-byte animation value is dominated by
strings and arrays, and its paired total-time delta was 0.03%, within
substantial run-to-run noise. More importantly, it is not the main
cost of the live player. Illuminate prepares the animation once and
retains the player state; each animation frame passes only the browser
timestamp resource into an existing Lean callback.

New retained-callback phase timing measures that real asynchronous
path. In a six-round order-balanced browser sample, the instrumented
callback medians were:

| Phase                               |   Median |
| ----------------------------------- | -------: |
| Marshal                             | 0.061 ms |
| Execute                             | 1.606 ms |
| Nested host calls                   | 0.473 ms |
| Decode                              | 0.026 ms |
| VIR total                           | 1.768 ms |
| Outer JavaScript adapter beyond VIR | 0.126 ms |

`host` is contained in `execute`; the rows are not additive. Execute
accounts for about 90.8% of VIR total. Host imports account for about
29.5% of execute, leaving roughly 1.13 ms in the interpreter and Lean
program. Marshal and decode together are only about 4.9% of VIR total.

The next optimization target is therefore execution across repeated
fresh interpreter entries, followed by attribution within host
imports. It is not another representation rewrite at the live
timestamp boundary.

## Revisions and artifacts

The experiment is in the isolated Illuminate worktree
`/home/egallego/lean/illuminate/.worktrees/vir-performance` on branch
`feat/vir-performance`. The main Illuminate checkout remains clean.

- Illuminate base: `006dc1d1db18c5dc73d637c926cf132e88df05b5`, plus
  the worktree changes described here.
- Private VIR base commit: `552cfa5b860908d2f0b3696f3fb22236521b8f0f`,
  plus the retained-callback timing change.
- VIR main used for the normalization comparison:
  `6c7e6d2510402d7a104135036ae75fcab30db91e`.
- Previous normalization control:
  `5202d2743ebc9a27f63d52f0a4317841748f0e5d`.
- Updated timed-call branch used as the JavaScript runtime base:
  `686aa24b1f7f4136b771bb85a8fd814c1da00c71`.
- Lean: `leanprover/lean4:4.33.0-rc2`.
- Browser: Google Chrome 150.0.7871.114, headless.
- Release Wasm SHA-256:
  `488a4a5e4f52bec15e1458964e34c5cf9182ad308a53d83c7e95a299eee60563`.

The candidate and normalization control use byte-identical release
Wasm. The control replaces only `vir-codec.js` and
`vir-value-normalizers.js` with the 5202 versions, while retaining the
same packages, timed-call API, host bindings, and Wasm. This isolates
the main normalization-plan cache.

The staged Illuminate package has 783 declarations: 681 Lean IR
declarations and 102 native externs, 30 JavaScript host imports, and
13 interface exports.

## Experiment 1: custom-inductive normalization cache

Both Node experiments use fresh runtimes per outer observation, two
warm-up rounds, 12 measured rounds, and alternating AB/BA order.
Runtime creation and package loading are outside the timed region.
Result projection and action normalization are also outside it. Every
result is checked for semantic parity.

### Representative trace

The representative input is “Morphing arrows and final loop”: a
611,001-byte projected animation and 30 events. Each observation takes
the median of seven calls to reduce scheduler outliers.

| Runtime         |      Wall |   Marshal |  Execute |   Decode |     Total |
| --------------- | --------: | --------: | -------: | -------: | --------: |
| 5202 normalizer | 53.203 ms | 39.288 ms | 7.965 ms | 7.379 ms | 53.173 ms |
| Main normalizer | 55.092 ms | 36.645 ms | 6.390 ms | 9.413 ms | 55.072 ms |

The paired total delta is +0.03%. Individual paired samples are
extremely noisy, so neither the 6.7% lower aggregate marshal median
nor the other phase movements establish a representative speedup. The
safe conclusion is no measurable total improvement for this
string/array-heavy value.

### Focused `PlayerEvent` trace

The focused input is one prepared small animation plus 4,096
`.advance` events. It directly stresses repeated custom-inductive
normalization.

| Runtime         |       Wall |   Marshal |   Execute |    Decode |      Total |
| --------------- | ---------: | --------: | --------: | --------: | ---------: |
| 5202 normalizer | 116.977 ms | 25.752 ms | 58.373 ms | 33.063 ms | 116.958 ms |
| Main normalizer | 103.695 ms |  2.366 ms | 51.318 ms | 46.504 ms | 103.666 ms |

The paired marshal delta is -82.1%; all 12 samples improve. The paired
total delta is -13.7%, with nine of 12 samples improving. Execute and
decode vary too much to assign causal changes to those phases. This
confirms that VIR main fixes the intended mechanism.

Raw reports:

- `test_output/perf/vir-main-call-phases.json`
- `test_output/perf/vir-main-call-phases-focused-events.json`

## Experiment 2: the live retained callback

VIR's public `callTimed` path observes top-level exports, not retained
Lean closures later invoked by `requestAnimationFrame`. The private
VIR checkout now adds:

- `VirCallback.callTimed(...args)`;
- `VirRuntime.setCallbackTimingObserver(observer | null)`;
- the same marshal, execute, nested-host, decode, and total
  definitions used by top-level calls;
- an uninstrumented fast path with one null-observer branch when no
  observer is installed.

The observer is cleared on runtime disposal and remains attached to
the public runtime wrapper across package replacement. No Wasm ABI or
package format change is required. The runtime callback lifecycle
suite covers explicit timed calls, observed calls, observer removal,
timing-stack cleanup, and callback ownership.

The Illuminate dashboard attributes observations to the animation
whose browser callback is active. It retains the existing outer
callback wall clock, so the display can distinguish VIR from
JavaScript adapter work. Phase timing is opt-in because it reads the
clock several times per callback.

The live workload isolates row 13, the sustained radial-gradient
spotlight loop. Each of six rounds measures timing enabled and
disabled in a fresh browser context, alternating ON→OFF and OFF→ON.
The warm-up is 2.5 seconds and the sample is 4.5 seconds.

| Metric                      | Timing on | Direct path |
| --------------------------- | --------: | ----------: |
| JS callback mean            |   0.17 ms |     0.18 ms |
| VIR outer callback mean     |   1.88 ms |     1.70 ms |
| VIR p95                     |   2.95 ms |     2.70 ms |
| VIR one-core callback share |     9.65% |       8.95% |

The paired median observer overhead is +10.8% for VIR mean callback
time; five of six rounds are slower. The JS control is also noisy,
including one severe host-load pair, so 10.8% is a diagnostic estimate
rather than a stable runtime constant. It is nevertheless sufficient
to keep phase timing off by default.

Raw report:

- `test_output/perf/vir-retained-callback-timing-overhead.json`

## What is expensive now

The live callback does not remarshal the animation. Its 0.061 ms
marshal phase mainly lowers the timestamp resource and creates the
callback argument vector. Decode is similarly small because the
callback returns `Unit`.

The 1.606 ms execute phase contains two distinct costs:

1. about 0.473 ms in synchronous host imports;
2. about 1.13 ms in Lean execution and VIR interpreter/runtime work.

The host portion includes `RuntimeRef` reads/modifications, SVG
attribute or text updates, control updates, and scheduling the next
animation frame. A sustained frame performs several small host
crossings. Before changing that boundary, VIR should report host time
by import target so `RuntimeRef`, DOM patches, and scheduling can be
separated.

The non-host execute remainder is consistent with the previously
observed cost of starting a fresh interpreter and rebuilding per-entry
resolved-symbol state. VIR already caches the exported numeric call
slot and the retained callback root, and its package provider is
indexed. Those caches do not preserve the upstream interpreter's local
symbol cache across asynchronous entries.

## Divergence from the JavaScript reference

Observable playback remains the compatibility contract, but the Lean
runtime has intentionally diverged internally to avoid VIR/FIR
overhead:

- validation and projection happen once at mount;
- `PlayerAnimation` omits synchronization SVG, which stays in the
  browser host;
- patch targets are classified once as text or named attributes;
- the live transition returns `Transition` directly instead of
  allocating a successful `Except` for every event;
- segment selection checks the rendered segment before searching;
- arbitrary step lookup uses binary search, while ordinary playback
  advances from cached state;
- patch arrays reserve validated capacity;
- one partially applied tick closure is retained across frame
  registrations;
- JavaScript owns DOM installation, patching, scheduling, and external
  Reveal/InfoView lifecycle adapters.

The prepared Lean input is deliberately stricter than JavaScript for
malformed data, but all valid generated behavior must remain equal.
The 106 differential traces currently match legacy JavaScript, VIR
JSON, VIR typed, and the staged FIR-native package.

## Recommendations

1. Keep VIR main's custom-inductive normalization-plan cache. It has
   strong focused evidence and benefits typed APIs that cross such
   values frequently.
2. Upstream the retained-callback timing surface as an opt-in
   diagnostic. Keep the no-observer path to one branch before the
   existing closure call and document that timing perturbs short
   calls.
3. Measure a provider-revision-scoped cross-entry symbol-resolution
   cache on the live callback. Do not persist a complete interpreter;
   retain only immutable resolution metadata and invalidate it when
   the package set changes.
4. Add per-host-target timing before redesigning the DOM boundary. If
   patch calls dominate, evaluate a typed bulk patch import; if
   `RuntimeRef` dominates, improve persistent-state access instead.
5. Keep bounded scalar conversion deferred until a regenerated FIR
   package can isolate it. The live VIR timestamp boundary already
   spends very little time marshaling, so changing every `Nat` now
   would add semantic and casting risk without addressing the measured
   bottleneck.

## Validation status

At the time of this report:

- the private VIR runtime suite passes all 18 tests;
- the full prior private VIR suite passes package, ABI, runtime,
  fixture, callback, host-binding, and InfoView checks;
- 106 legacy/VIR-JSON/VIR-typed/FIR-native traces match;
- 520 Illuminate Lean tests pass;
- the TypeScript/JSDoc check passes;
- the release Wasm is byte-identical to the control artifact.

The remaining repository-wide browser, formatting,
import-minimization, and final full VIR checks should be rerun after
the final source edits.
