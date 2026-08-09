# VIR performance after indexed package lookup

Date: 2026-08-05

## Executive summary

Illuminate exercises VIR as a browser runtime for many short,
asynchronous Lean calls. A Lean animation callback decides playback
state and emits SVG patch operations; JavaScript owns scheduling and
applies the patches. The JavaScript and Lean/VIR players consume the
same animation data and run side by side, which makes DOM and playback
equality directly observable.

VIR commit `8b3c1a12ecacd24a512b678f012e1814e3eb0335` fixes decoded
`Lean.Name` hashes and replaces linear package declaration scans with
`lean::name_hash_map<uint32_t>` indices. The focused fresh-interpreter
benchmark improved from 403.4 to 58.9 microseconds per entry, a 6.85x
speedup. In an Illuminate acceptance run, a sustained VIR animation
callback improved from about 1.10 to 0.545 milliseconds. The lookup
change is effective and should be kept.

The post-change Illuminate profile has the predicted shape:

- `lean_name_eq` is no longer a leading symbol;
- the package declaration map is now 6.36% of attributable samples;
- package, native, and interpreter-local lookup together with
  `get_decl` and `lookup_symbol` account for about 14.9%;
- including interpreter call dispatch raises that cluster to about
  18.9%;
- generic IR body evaluation accounts for 12.6%;
- DOM `setAttribute` accounts for 5.7%;
- garbage collection accounts for 3.4%.

The next VIR-facing experiment should therefore address
resolved-symbol state across asynchronous interpreter entries. It
should not persist an entire interpreter. A caller-owned,
provider-revision-scoped resolution cache could retain only immutable
declaration/native resolution metadata and seed each fresh
interpreter's local symbol cache. VIR's loaded package generation is a
good first consumer because package declarations are immutable until
the set is cleared.

This report describes the evidence, the cache boundary and ownership
rules, and an acceptance plan. It does not claim that the proposed
cache is already proven profitable; the next step is a small
instrumented prototype measured with the existing focused and
Illuminate workloads.

## Workload

Illuminate is a Lean diagramming library with an animation player
ported from JavaScript to Lean. The first port deliberately preserves
the existing compact animation data and SVG fragments.

Lean owns:

- elapsed-time-to-frame conversion;
- step and pause selection;
- loop wrapping and loop exit;
- segment selection;
- parameter interpolation and patch selection;
- playback state and scheduling decisions.

JavaScript owns:

- `requestAnimationFrame` registration;
- installing a new SVG fragment on a segment change;
- indexing `[data-e]` SVG elements;
- applying SVG attributes and `textContent` patches;
- external lifecycle adapters for standalone HTML, Reveal, and
  InfoView.

The comparison dashboard mounts all 16 current examples twice: once
with the legacy JavaScript engine and once through one shared VIR
runtime. Each pair receives the same timestamps and controls. The page
reports rolling callback FPS, synchronous callback time, p95, maximum
time, and a one-core CPU estimate. It also checks that the resulting
SVG DOMs match.

The workload is intentionally hostile to per-entry fixed costs. A
callback does little Lean computation, returns to the browser, and
enters Lean again on the next frame. Multiple independent animations
repeat that pattern concurrently.

## Tested configuration

- Illuminate base commit: `006dc1d1db18c5dc73d637c926cf132e88df05b5`,
  plus the uncommitted VIR integration in this repository;
- repository-local VIR commit:
  `8b3c1a12ecacd24a512b678f012e1814e3eb0335`;
- Lean: 4.33.0-rc2, commit `d8b18978322de05a8f3dba51ef03cf5461676c17`;
- Google Chrome: 150.0.7871.114, headless;
- Node.js: 24.18.0;
- uv: 0.9.16;
- machine: AMD Ryzen AI 9 HX 370, 12 cores/24 threads, x86-64.

Illuminate's modular package set contains 36 packages and, after
loading, 743 declarations: 641 interpreted IR declarations and 102
native extern declarations. Its interface has 12 exports and 30
JavaScript host imports.

The relevant sources are:

- Illuminate `src/Illuminate/Animation/Player.lean`: pure state
  machine;
- Illuminate `src/Illuminate/Animation/Vir.lean`: browser-facing Lean
  runtime;
- Illuminate `player_js/comparison.js`: paired dashboard and metrics;
- Illuminate `scripts/test-player-traces.mjs`: differential state
  traces;
- VIR `wasm/upstream_shim/package/package_decl_provider.cpp`: package
  indices;
- VIR `wasm/upstream_shim/interpreter/interpreter_bridge.cpp`:
  interpreter entry and declaration-provider bridge;
- VIR `third_party/lean4-src/src/library/ir_interpreter.cpp`: upstream
  interpreter-local and global caches;
- VIR `web/src/runtime/core.js`: interface export and numeric
  call-slot cache.

## Accepted lookup improvement

The original lookup cost had two independent causes.

First, VIR's local `lean_name_mk_string` and `lean_name_mk_numeral`
implementations wrote the constant hash `1729` into decoded names.
This defeated the hash short-circuit in `lean_name_eq` and collapsed
every attempted name hash map into one bucket.

Second, `find_package_decl` and `find_package_boxed_decl` linearly
scanned all loaded declarations for every fresh interpreter cache
miss.

The accepted implementation now:

1. computes the same string and numeral name hashes as Lean;
2. builds separate `lean::name_hash_map<uint32_t>` indices for
   declaration names and boxed base names after all package-set
   members are appended;
3. stores stable declaration-vector slots as map values;
4. rejects duplicate declaration and boxed-base names;
5. deletes the indices before releasing the package-owned names and
   declarations.

No package-format or JavaScript API change was needed.

VIR's six-pass, order-balanced focused benchmark measured:

| Comparison                                     | Execution paired median | Package-load paired median |
| ---------------------------------------------- | ----------------------: | -------------------------: |
| Original to correct hashes plus indexed lookup |                  -84.8% |                     -26.2% |

The aggregate fresh-entry median moved from 403.4 to 58.9
microseconds. Package loading moved from 12.44 to 9.07 milliseconds.
All six execution and all six package-load passes improved. These
results are documented in VIR's
`docs/ENVIRONMENT_LOOKUP_PERFORMANCE.md`.

An Illuminate sustained-loop measurement also moved from approximately
1.10 milliseconds mean and 1.60 milliseconds p95 to 0.545 milliseconds
mean and 0.75 milliseconds p95. The corresponding one-core callback
estimate moved from about 6.6% to 3.3%. This is the application-level
acceptance signal that the focused benchmark was intended to predict.

## Correctness status

The integrated repository passes:

- 515 Lean tests;
- 105 generated JavaScript/VIR differential playback traces;
- 64 structural, lifecycle, disposal, Reveal, and visual browser
  tests;
- JavaScript checking through TypeScript;
- `lake build --wfail` and `lake shake`.

The browser suite covers pause and cancellation, fragment rewind,
disposal while playing, package/widget replacement, two independent
animations, and SVG DOM equality. No visual baseline was changed for
the VIR integration.

## Post-index measurement method

### Unprofiled callback baseline

The dashboard wraps each owned animation-frame callback and measures
synchronous wall time immediately before and after invoking it. A
rolling two-second window excludes older activity. For each run:

1. a fresh browser context loaded the integrated dashboard;
2. all players were paused and reset;
3. 2.5 seconds elapsed to prune old samples;
4. example 13, the radial-gradient spotlight, entered its sustained
   loop;
5. statistics were read after 5.5 seconds;
6. the browser context was discarded.

Eight runs were collected. The host was unusually busy: load averages
were 12.70, 14.47, and 15.20, and even the JavaScript player ranged
from 29.0 to 58.5 callbacks per second. These results establish a
reproducible integrated snapshot but should not be compared
numerically with the earlier controlled before/after run.

| Metric                  | JavaScript median | Lean/VIR median | JavaScript range | Lean/VIR range |
| ----------------------- | ----------------: | --------------: | ---------------: | -------------: |
| Callback rate           |            49.5/s |          49.5/s |      29.0-58.5/s |    24.5-58.5/s |
| Mean callback           |          0.225 ms |         2.30 ms |     0.19-0.50 ms |   1.82-3.37 ms |
| p95 callback            |           0.45 ms |         3.70 ms |     0.40-0.80 ms |   2.90-6.50 ms |
| One-core callback share |              1.1% |           10.7% |         0.9-1.5% |      8.3-11.5% |
| Maximum callback        |           1.05 ms |         5.50 ms |    0.50-11.10 ms |  3.20-12.20 ms |

No callback in these runs exceeded the 16.7 millisecond frame budget.

### CPU sampling

Chrome's CDP profiler sampled the development, symbolized VIR Wasm
runtime at a requested 100 microsecond interval. The full 16-pair
dashboard ran for eight seconds. Profiling perturbs timings, so the
profile is used only for hotspot attribution.

The sample contained 8,193 milliseconds of deltas. Chrome assigned
53.18% to unsymbolized `(program)` and 0.35% to `(idle)`, leaving
3,807 milliseconds of attributable samples. Percentages below
normalize against that attributable bucket. They are diagnostic rather
than a complete accounting of browser CPU.

| Self-time hotspot                              | Attributable samples |
| ---------------------------------------------- | -------------------: |
| `interpreter::eval_body`                       |               12.58% |
| package declaration `name_hash_map::find`      |                6.36% |
| DOM `setAttribute`                             |                5.69% |
| `interpreter::call`                            |                4.00% |
| global native-symbol `name_hash_map::find`     |                3.45% |
| garbage collector                              |                3.38% |
| interpreter-local symbol `name_hash_map::find` |                2.80% |
| `memcmp`                                       |                2.56% |
| `interpreter::get_decl`                        |                1.41% |
| `interpreter::lookup_symbol`                   |                0.88% |
| interpreter destruction                        |                0.92% |
| `createHostResource` plus `HostResource`       |                1.73% |
| `createVirCallbackLease`                       |                0.60% |

The conservative resolution subtotal is 14.9%:

```text
package declaration map       6.36%
global native-symbol map      3.45%
interpreter-local symbol map  2.80%
get_decl                      1.41%
lookup_symbol                 0.88%
                              -----
                             14.90%
```

Including `interpreter::call` gives 18.9%. `memcmp` is not included
because the profile alone does not prove how much belongs to name
comparison.

The important qualitative result is that `lean_name_eq`, formerly the
dominant symbol, has left the leading profile entirely. The remaining
cost is no longer a linear provider defect. It is repeated resolution
and cache reconstruction around otherwise short interpreter entries.

## Why existing caches do not remove this cost

VIR and the upstream interpreter already cache several different
things. The scope of each cache explains the post-index profile.

### JavaScript export call slots

`web/src/runtime/core.js` keeps `entryCallCache`. After
`vir_resolve_call_export` returns a numeric call slot, later calls
reuse that slot. The manifest export is not repeatedly resolved by
name.

This cache gets the browser to the exported Lean entry efficiently. It
does not resolve internal functions referenced by interpreted IR.

### Retained callback roots

VIR roots retained Lean closures. A retained partially applied closure
stores its root declaration, so the callback does not need to resolve
its root by name when the browser later invokes it.

This optimization is semantically faithful and already used by
Illuminate. It does not preserve the interpreter's internal symbol
cache after the callback returns.

### Upstream interpreter-local cache

Every upstream `interpreter` owns `m_symbol_cache`, mapping
`Lean.Name` to a `symbol_cache_entry` containing a declaration and
native-symbol metadata. Nested synchronous calls with the same
environment and options reuse the active interpreter. An asynchronous
callback after the previous call returned creates a new interpreter,
so its `m_symbol_cache` starts empty.

This local lifetime is necessary for normal Lean because environments
can change or be backtracked.

### Global native-symbol cache

The upstream global native-symbol cache stores a native address and
whether the boxed symbol was selected. On a hit, `lookup_symbol` still
calls `get_decl(fn)` before inserting a complete entry into the fresh
local cache. It therefore does not eliminate provider declaration
lookup.

### Indexed VIR provider

VIR now resolves `get_decl` through a package-generation-owned hash
index. This is much cheaper than the old scan, but a new interpreter
still performs the map lookup once for each internal symbol
encountered during that callback.

The steady asynchronous path is therefore:

```text
retained browser callback
    |
    v
fresh upstream interpreter
    |
    v
interpreter-local m_symbol_cache             miss
    |
    v
global native-symbol cache                   often hit
    |
    +---------------------------------------------+
    |                                             |
    v                                             v
get_decl                                  native metadata
    |
    v
VIR package declaration name_hash_map
    |
    v
insert complete entry into local cache
```

The complete local entry is discarded when the callback returns, then
rebuilt on the next animation frame.

## Proposed next experiment

### Goal

Allow a caller with an immutable, revisioned declaration provider to
reuse resolved symbol metadata across top-level interpreter
invocations without reusing interpreter execution state.

The desired cached value is conceptually:

```cpp
struct resolved_symbol {
    decl declaration;
    void * native_address;
    bool native_is_boxed;
};
```

The cache identity must include at least:

```text
provider identity
x provider revision
x relevant interpreter options
x Lean.Name
```

For VIR, one loaded package set is immutable. Its revision changes
before the provider can return a different declaration for the same
name. That gives the cache a stronger invariant than a general mutable
Lean environment.

### Suggested boundary

The clean upstream direction is an optional caller-owned
resolution-cache interface next to an explicit declaration-provider
interface. A fresh interpreter can consult that cache on a local miss
and insert the returned metadata into `m_symbol_cache`. Existing
callers without the interface retain today's behavior.

A minimal experimental interface might provide operations equivalent
to:

```cpp
struct symbol_resolution_cache {
    void * state;
    uint64_t provider_revision;
    bool (*find)(void * state, name const & fn, resolved_symbol & out);
    void (*insert)(void * state, name const & fn, resolved_symbol const & value);
};
```

The exact types should follow upstream Lean conventions. The important
part is that the upstream interpreter, not only VIR's outer
`run_interpreter_function`, uses the cache. Retained closures re-enter
through interpreter closure stubs, so an outer wrapper cache would
miss the animation callback path.

Another viable shape is to let the caller provide a pre-populated
immutable symbol table for the current provider revision. This may be
simpler than callbacks if upstream can express the ownership
precisely.

### Ownership and invalidation requirements

The cache must:

1. retain any `Lean.Name` and declaration objects it stores;
2. release the cache before the package provider releases package IR
   objects;
3. invalidate all entries when the provider revision changes;
4. insert only fully resolved successful entries;
5. cache misses only if the provider contract guarantees
   revision-stable negative results;
6. remain isolated per VIR Wasm runtime instance;
7. behave correctly during nested and reentrant interpreter calls;
8. avoid raw pointers into vectors unless the vectors are guaranteed
   immovable for the entire revision;
9. preserve the existing path when no external cache is supplied.

The cache must not retain:

- argument, join-point, or call stacks;
- exception or tracing state;
- evaluated nullary values from `m_constant_cache`;
- callback leases or browser resources;
- mutable interpreter options or environment state.

Persisting the entire interpreter is not recommended. The measured
target is resolution metadata, while a whole interpreter also owns
mutable stacks, evaluated constants, and environment-sensitive state.

### VIR-local prototype

Before proposing a final upstream API, VIR can carry a small
maintained patch against its pinned Lean interpreter to validate the
effect:

1. add a monotonically increasing package-provider revision;
2. create one external resolved-symbol cache per loaded package
   generation;
3. expose it to every fresh interpreter, including retained-closure
   entry;
4. clear it before `clear_loaded_package_state` releases names and
   declarations;
5. collect exact cache hit, miss, insertion, and invalidation
   counters;
6. run the focused benchmark and Illuminate acceptance suite.

If the cache does not materially reduce callback time, it should not
be upstreamed merely because the profile contains lookup symbols.

## Instrumentation requested

Sampling identifies the target but cannot answer how many lookups are
repeated. The prototype should count:

- top-level interpreter constructions;
- nested interpreter reuses;
- local symbol-cache hits and misses;
- external resolution-cache hits and misses;
- global native-symbol cache hits and misses;
- package declaration-index hits and misses;
- resolved symbols inserted per top-level entry;
- cache entries alive per package revision;
- cache invalidations and released key/declaration references.

For Illuminate, reporting unique resolved names and total resolutions
per frame would show the maximum possible benefit before changing the
implementation.

## Acceptance plan

### Focused VIR benchmark

Use VIR's existing fresh-entry workload with byte-identical packages
and an order-balanced schedule:

```sh
npm run bench:paired -- \
  --npm-script bench:env-lookup \
  --repeat 6 \
  --out build/perf/env-lookup/resolved-cache-abba \
  --bench-arg=--iterations=1000 \
  --bench-arg=--samples=9 \
  ../vir-baseline ../vir-candidate
```

Record execution, package loading, cache construction time, live cache
size, and ownership counters. Identical-code AB/BA controls are
important because small one-off movements were noisy in the
declaration-index study.

### Illuminate acceptance workload

Rebuild and stage the repository-local VIR runtime:

```sh
npm run stage:vir
npm run test:vir-traces
npm run demo:comparison
```

Then measure:

- the isolated radial-gradient sustained loop;
- the morphing-arrows example;
- all 16 players auto-cycling;
- mean, p95, maximum, long frames, and one-core callback share;
- JavaScript/VIR DOM and playback-state equality;
- disposal and replacement with callbacks pending.

Use multiple fresh contexts and interleave baseline and candidate
builds. CPU profiles should use symbolized development Wasm only for
attribution, never for headline timing.

The minimum success criterion is a consistent reduction in focused
fresh-entry time and isolated Illuminate callback time without
package-load, memory, lifecycle, or reference-count regressions. A
profile movement without an unprofiled timing movement is
insufficient.

### Correctness cases

The cache-specific tests should cover:

1. repeated resolution in one interpreter and across fresh
   interpreters;
2. package A load, clear, and package B load with an overlapping name;
3. failed package load and initializer failure;
4. a separately allocated but structurally equal `Lean.Name`;
5. interpreted, native, boxed, unboxed, missing, and host-import
   targets;
6. nested synchronous calls and asynchronous retained callbacks;
7. callback disposal while a frame is pending;
8. runtime disposal and package replacement while callbacks exist;
9. two Wasm runtime instances with no shared cache state;
10. repeated load/clear cycles with balanced Lean reference counts.

## Alternatives and follow-up work

### One shared application tick

Illuminate could run all active players through one `tickAll` entry
per browser frame. Internal calls would then share one
interpreter-local cache, and the full dashboard would amortize
interpreter setup across players.

This is a promising Illuminate optimization after the VIR experiment.
It does not address the one-player fixed floor, and unrelated
applications should not need to batch callbacks to recover
revision-stable resolution metadata.

### More JavaScript DOM work

The renderer already keeps DOM patching in JavaScript. `setAttribute`
is about 5.7% of attributable post-index samples, smaller than the
conservative symbol resolution cluster. Moving playback decisions back
into JavaScript would defeat the port without addressing the measured
interpreter boundary.

### Callback-resource pooling

Host-resource construction and callback leasing are visible but
individually small. They should be reconsidered only after resolution
caching or if exact counters show unexpected allocation volume. Any
pooling must preserve VIR's ownership, revocation, and disposal
guarantees.

### Decoder-wide name interning

Interning equal decoded names could make equality cheaper and reduce
duplicate cache keys. It adds decoder ownership complexity and is no
longer the leading post-index signal. It should be measured separately
rather than bundled with the resolution-cache prototype.

### AOT WebAssembly

AOT compilation would change the overall performance class, but it is
a much larger design decision and is not required to investigate this
fixed interpreter-entry cost.

## Questions for VIR and Lean maintainers

1. Is a caller-owned, provider-revision-scoped symbol cache compatible
   with the intended upstream declaration-provider API?
2. Which interpreter options participate in symbol-resolution identity
   beyond provider identity and revision?
3. Can upstream expose a cache value type without making private
   interpreter implementation details public?
4. Should native metadata remain in the existing global cache while
   only the declaration half is supplied externally, or is one
   complete resolved entry simpler and faster?
5. Should negative symbol resolution be externally cached, or only
   successful complete entries?
6. What is the preferred ownership convention for cached `decl` and
   `name` values across an upstream C++ API?
7. Can retained interpreted closure entry receive the same
   provider/cache context without adding VIR-specific callback
   machinery?
8. Would maintainers prefer a VIR-only measured prototype before
   discussing an upstream interface?

## Recommendation

Keep the correct-name-hash and package-index changes as they stand.
They deliver a large focused and application-level improvement,
eliminate the former linear scan hotspot, and preserve package
ownership semantics.

Next, build one instrumented VIR-local prototype of a
package-revision-scoped resolved-symbol cache exposed to every fresh
interpreter entry. Treat its exact hit rate, unprofiled fresh-entry
timing, isolated Illuminate callback timing, and reference-lifetime
tests as the decision gate. If it succeeds, use the prototype to shape
the smallest general upstream provider/cache API. If it does not, the
next measured candidates are interpreter dispatch and application
batching, not further package lookup work.
