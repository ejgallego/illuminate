# VIR performance under Illuminate's animation runtime

Date: 2026-08-05

## Executive summary

Illuminate is a Lean diagramming library whose animation player was
ported from JavaScript to Lean using VIR. The browser-facing
implementation deliberately keeps SVG patching at the host boundary,
which makes the comparison unusually useful: the JavaScript and
Lean/VIR players consume the same animation data and perform
equivalent DOM updates, while the playback state machine runs in
JavaScript or interpreted Lean IR respectively.

In headless Chrome, an isolated Lean/VIR animation callback averaged
about 1.07 ms, compared with 0.043 ms for the JavaScript
implementation. The relative difference is large, about 25x, but an
individual VIR player remained well inside a 16.7 ms frame budget. No
isolated callback exceeded that budget.

CPU profiles consistently identified `lean_name_eq` and IR
symbol/declaration lookup as the dominant symbolized work. SVG
`setAttribute` accounted for only about 1.3–1.5% of active sampled
time, and garbage collection accounted for about 1%.

VIR and the upstream Lean IR interpreter already contain several
caches. The important finding is that they have different scopes:

- the JavaScript runtime caches a manifest export's numeric call slot;
- retained Lean callbacks store their root declaration directly;
- the upstream interpreter caches resolved internal symbols only for
  the lifetime of one interpreter invocation;
- VIR's package declaration provider does not currently index
  declarations: `find_package_decl` linearly scans every package
  declaration using `lean_name_eq`.

After an asynchronous browser callback re-enters Lean, the upstream
interpreter creates a fresh interpreter and therefore a fresh local
symbol cache. On the first occurrence of each internal target in that
invocation, the global native-symbol cache may hit, but the
interpreter still asks VIR for the declaration. For the measured
Illuminate package, that request scans as many as 743 declaration
entries.

The recommended first optimization is a VIR-owned,
package-generation-scoped declaration index. This change is confined
to VIR's package provider, does not change the IR package format or
JavaScript API, and does not require persisting an entire upstream
interpreter. A more invasive persistent resolved-symbol cache should
be considered only after measuring the indexed provider.

## Workload

The comparison page mounts all 16 current Illuminate `#animate`
examples twice:

- once with the original JavaScript playback engine;
- once with the Lean playback engine interpreted by VIR.

Both players use the same generated animation data, SVG fragments,
element indices, attribute values, controls, and browser
`requestAnimationFrame` timestamps. Every pair is driven by
synchronized play, pause, seek, reset, and auto-cycle controls.

The Lean side owns:

- elapsed-time-to-frame conversion;
- step and pause selection;
- looping and loop exit;
- segment selection;
- parameter interpolation and patch selection;
- playback state and scheduling decisions.

The browser host owns:

- installing an SVG fragment when the segment changes;
- indexing `[data-e]` elements;
- applying SVG attributes and `textContent` patches;
- registering browser callbacks and event listeners.

This is a workload of many short, repeated asynchronous calls. It is
therefore sensitive to fixed interpreter-entry and target-resolution
costs that are less visible in large, compute-heavy calls.

## Tested configuration

The measurements in this report used:

- Illuminate commit: `006dc1d1db18c5dc73d637c926cf132e88df05b5` plus
  the uncommitted VIR integration described here;
- repository-local VIR commit:
  `1dd1ff875a35eb6bd2e0a4daacdf7b9f8cdba3a7`, branch
  `feat/illuminate-runtime`, plus local browser/reference-management
  work;
- Lean toolchain: `leanprover/lean4:v4.33.0-rc2`;
- Google Chrome 150.0.7871.114, headless;
- Node.js 24.18.0;
- uv 0.9.16;
- AMD Ryzen AI 9 HX 370, 12 cores/24 threads.

The generated Illuminate package contained:

- 743 declarations;
- 641 interpreted Lean IR declarations;
- 102 native extern declarations;
- 30 JavaScript host imports;
- 12 interface exports.

The VIR checkout was not a clean upstream release checkout. Absolute
numbers should therefore be reproduced after rebasing, while the call
path and cache-lifetime observations can be reviewed directly in the
source.

Relevant Illuminate sources are:

- `src/Illuminate/Animation/Vir.lean`: VIR-backed animation runtime;
- `src/Illuminate/Animation/Player.lean`: pure playback state machine;
- `player_js/comparison.js`: synchronized comparison dashboard and
  callback metrics;
- `scripts/test-player-traces.mjs`: generated differential traces;
- `test_playwright.py`: structural, lifecycle, and visual browser
  tests.

The comparison page can be rebuilt and served with
`npm run demo:comparison`. By default it is available at
`http://127.0.0.1:8765/anim-comparison.html`.

## Measurement method

### Callback timings

The comparison page wraps `requestAnimationFrame`. For every owned
callback it records synchronous wall time from immediately before
invoking the callback until it returns. A rolling two-second window
reports:

- callback rate;
- total callback wall time as a percentage of one main thread;
- mean, p95, and maximum callback duration;
- callbacks exceeding 16.7 ms.

The metric includes playback decisions, VIR interpretation, host
calls, and synchronous DOM patching. It excludes later browser layout,
paint, and compositing. It should be read as an engine comparison, not
as total browser CPU.

Each example was also measured in isolation. All other rows were
paused and reset, the previous rolling window was allowed to expire,
and one synchronized JavaScript/VIR pair was played for 4.5 seconds
before sampling.

### CPU sampling

Chrome's CDP sampling profiler was run for eight seconds at a
requested 100 microsecond interval. This significantly perturbed
absolute callback timings, by roughly 3x in one isolated run, so it
was used only for hotspot attribution. The unprofiled callback
measurements are the throughput evidence.

Chrome also reported a substantial unsymbolized `(program)` bucket,
particularly in isolated profiles. Percentages below should therefore
be treated as evidence of relative hotspots, not complete accounting.

### Correctness checks

At every sampled row, the JavaScript and VIR SVG DOMs matched. In
addition:

- 105 generated JavaScript/VIR state-machine traces matched;
- 64 structural and visual browser tests passed;
- lifecycle tests covered cancellation, pause, independent players,
  Reveal navigation, disposal while playing, and loops;
- 515 Lean tests passed.

## Results

### Isolated callbacks

The first unprofiled 16-example run produced:

| Metric                               |   JavaScript |   Lean/VIR |
| ------------------------------------ | -----------: | ---------: |
| Mean callback across examples        |     0.043 ms |   1.071 ms |
| Median callback across examples      |     0.040 ms |   1.045 ms |
| Typical p95                          | about 0.1 ms | 1.4–1.7 ms |
| Largest observed callback            |       0.7 ms |     2.7 ms |
| Callbacks over 16.7 ms               |            0 |          0 |
| Projected callback CPU at 60 calls/s |   about 0.3% | about 6.4% |

Simple examples generally cost 0.95–1.0 ms per VIR callback. The most
expensive morphing example cost about 1.29 ms. The relatively narrow
range indicates a substantial fixed cost independent of SVG
complexity.

### Concurrent dashboard

With all 16 pairs auto-cycling:

| Metric                          | JavaScript | Lean/VIR |
| ------------------------------- | ---------: | -------: |
| Mean active callback rate       |     34.9/s |   34.9/s |
| Aggregate measured callback CPU |       0.5% |    26.8% |

The callback rate includes pause steps, completed finite animations,
and a 700 ms auto-cycle delay. It is not a claim that the browser
could sustain only 34.9 frames/s. Likewise, the dashboard did not keep
all 16 players continuously active at 60 Hz.

### Profile attribution

The first full-dashboard CPU sample attributed active self-time
approximately as follows:

| Hotspot                                        | Active self-time |
| ---------------------------------------------- | ---------------: |
| `lean_name_eq`                                 |            32.6% |
| unsymbolized `(program)`                       |            30.4% |
| native-symbol `name_hash_map::find`            |             6.5% |
| interpreter-local symbol `name_hash_map::find` |             5.1% |
| `interpreter::get_decl`                        |             4.1% |
| `interpreter::eval_body`                       |             2.7% |
| DOM `setAttribute`                             |             1.5% |
| garbage collector                              |             1.0% |

The explicitly symbolized name equality, native-symbol lookup,
local-symbol lookup, and declaration lookup together represented about
48% of active sampled self-time.

A follow-up profile after caching Illuminate's partially applied tick
closure showed the same shape:

- `lean_name_eq`: 35.0%;
- native-symbol map lookup: 7.2%;
- interpreter-local symbol map lookup: 5.7%;
- `get_decl`: 4.7%;
- DOM `setAttribute`: 1.2%;
- garbage collection: 1.0%.

The tick-closure change moved the isolated mean from 1.071 ms to 1.021
ms, a nominal 4.7% reduction, but run-to-run variation was larger and
concurrent aggregate CPU moved in the opposite direction. No
statistically reliable speedup is claimed. More importantly, the
dominant name-resolution profile was unchanged.

## Existing lookup layers

### JavaScript export call slots

`web/src/runtime/core.js` maintains `entryCallCache`.
`resolveCallSlot` calls `vir_resolve_call_export` only when
`cache.callSlot` is absent, then reuses the numeric slot. Calls made
through `vir.call(name, ...)` therefore do not repeatedly scan the
manifest or resolve the package export slot.

### Retained callback roots

`web/src/runtime/callbacks.js` and
`wasm/upstream_shim/abi/closure_abi.cpp` retain Lean callback closures
as rooted resources. An interpreted partial-application closure stores
its declaration. When a browser callback fires, the closure stub
enters that stored declaration rather than resolving the callback's
root by name.

Browser `requestAnimationFrame` is one-shot, so each registration
still owns and releases a callback lease. Illuminate now reuses the
same partially applied Lean closure across registrations, but that
does not preserve the interpreter's internal cache across callback
invocations.

### Upstream interpreter-local symbol cache

In `third_party/lean4-src/src/library/ir_interpreter.cpp`, each
`interpreter` owns:

- `m_symbol_cache`, mapping `Lean.Name` to declaration/native
  resolution;
- `m_constant_cache`, storing evaluated nullary results;
- argument, join-point, and call stacks.

`lookup_symbol` checks `m_symbol_cache`, then the global native-symbol
cache, and finally obtains the declaration through `get_decl`. The
global native-symbol cache stores an address and boxed flag, but not
the environment-dependent declaration. Even on a global native-cache
hit, `lookup_symbol` calls `get_decl` before inserting a new local
entry.

`with_interpreter` reuses the active interpreter for nested
synchronous calls with identical environment/options. Otherwise it
constructs a new interpreter. A retained callback invoked after the
prior browser-to-Lean call returned therefore gets a new
`m_symbol_cache`.

This behavior is reasonable for the general upstream interpreter:
environments can change or be backtracked, and a stored closure can be
invoked in another context.

### VIR package declaration provider

VIR implements `lean_ir_find_env_decl` in
`wasm/upstream_shim/interpreter/interpreter_bridge.cpp`. It delegates
to `find_package_decl`.

`find_package_decl`, `find_package_boxed_decl`,
`find_package_init_name`, and `find_host_import_symbol` in
`wasm/upstream_shim/package/package_decl_provider.cpp` currently
iterate their vectors and call `lean_name_eq` on each candidate.

The package decoder in `package_ir_decoder.cpp` reconstructs names
recursively at each serialized occurrence. Equal function names are
therefore not guaranteed to share object identity. `lean_name_eq`
first checks pointer identity and stored hashes, then walks
hierarchical name components when needed.

## Likely hot path

For the first occurrence of an internal function target during an
animation callback, the current path is:

```text
FAp or PAp in immutable package IR
    |
    v
interpreter-local m_symbol_cache       miss: new interpreter
    |
    v
global native-symbol cache             usually hit after warmup
    |
    v
interpreter::get_decl
    |
    v
lean_ir_find_env_decl
    |
    v
VIR find_package_decl                  linear scan over g_entries
    |
    v
interpreter-local cache insertion
```

This explains how target-resolution caching can exist while
`lean_name_eq` remains hot: the cached native result lacks the
declaration, the local declaration cache dies with the callback's
interpreter, and the provider's declaration lookup is linear.

The profile does not by itself attribute every `lean_name_eq` sample
to the package-provider loop. Instrumented comparison counts should
confirm the exact share before and after any change. Nevertheless,
eliminating the linear scan is independently justified and low risk.

## Recommended first change: package declaration indices

### Scope

Implement this in VIR's package provider only. Do not persist a whole
upstream interpreter and do not change Illuminate.

### Data structure

One possible representation is:

```cpp
struct package_lookup_indices {
    name_hash_map<uint32_t> declarations;
    name_hash_map<uint32_t> boxed_declarations;
    name_hash_map<uint32_t> initializer_names;
    name_hash_map<uint32_t> host_imports;
    uint32_t generation = 0;
};
```

The integer values index the existing package-owned vectors. This
avoids storing pointers that could be invalidated if a vector moves
and makes ownership explicit: map keys retain their names; values do
not own declarations or strings.

For the smallest initial patch, only `declarations` and
`boxed_declarations` are required. Initializer and host-import indices
can be included if instrumentation shows relevant lookup volume or if
maintainers prefer consistent provider behavior.

### Construction

After decoded vectors have been moved into `g_entries` and related
package state:

1. reserve index capacity based on vector sizes;
2. insert every unboxed declaration name and vector index;
3. insert every boxed base name and vector index;
4. preserve current first-match behavior by not overwriting an
   existing key;
5. record the current `g_package_generation`;
6. mark the package loaded and run initializers.

The indices must be available while initializers run because
initializer execution uses the same interpreter/provider path.

### Lookup

`find_package_decl` becomes a hash lookup followed by
`g_entries[index].decl`. Missing names return `nullptr` exactly as
before. The boxed path uses a separate index so boxed and unboxed
names cannot collide semantically.

### Invalidation and ownership

`clear_loaded_package_state` should:

1. clear all indices, releasing their retained name keys;
2. release package vector entries as it does today;
3. clear the vectors;
4. increment `g_package_generation`.

If index construction fails or a package initializer fails, normal
package clearing must remove the partially or fully constructed
indices.

The existing generation counter is already a suitable invalidation
identity. JavaScript package replacement currently creates a
replacement WebAssembly runtime, but same-instance load failure and
future reload paths should still be correct.

### Semantic argument

The cache records only:

```text
package generation x Lean.Name -> existing package vector slot
```

It does not cache evaluated values, IO results, reference counts, or
interpreter control state. A loaded package's declaration vectors are
immutable. For a given generation, an indexed lookup therefore returns
the same declaration object as the existing first-match linear scan.

This keeps the optimization within VIR's stronger package-lifetime
invariant and avoids weakening the upstream interpreter's
environment/backtracking rules.

## Optional second change: persistent resolved-symbol metadata

After indexing the provider, remeasure before considering this stage.

If rebuilding `m_symbol_cache` remains expensive, VIR could provide a
package-scoped cache containing only resolved symbol metadata:

```cpp
struct resolved_symbol {
    decl declaration;
    void * native_address;
    bool boxed;
};

unordered_map<object *, resolved_symbol> targets_by_name_object;
```

The raw `Lean.Name` object pointer is a useful hot key because names
embedded in the decoded IR graph remain alive and immutable until
package clearing. Different objects representing equal names may
receive separate cache entries, but each stable call-site name object
resolves only once. Correctness does not rely on interning.

This stage is more invasive because asynchronous callbacks enter
through interpreter closure stubs, not only through VIR's
`run_interpreter_function`. A cache passed only to `run_boxed` would
not automatically be visible when such a closure later re-enters the
interpreter.

A viable design would require a minimal interpreter extension or
maintained patch that lets a newly constructed interpreter obtain an
optional external symbol-resolution cache. In VIR, the provider would
return the cache for the current package generation. Nested calls
would continue to use the already active interpreter.

Important constraints:

- cache only declaration/native resolution, never `m_constant_cache`
  values;
- do not reuse argument, join-point, or call stacks;
- insert only after successful complete resolution;
- make the cache generation-scoped and clear it before package IR
  objects are released;
- account explicitly for reentrant calls;
- keep existing behavior unchanged when no external cache is
  configured.

Persisting the entire interpreter is not recommended. Its mutable
stacks, evaluated constant cache, exception state, and upstream
environment assumptions introduce unnecessary semantic and lifetime
risk.

## Possible later improvement: name canonicalization

The current decoder reconstructs every serialized name occurrence. A
shared decoder-side name interner, or a future package-format name
table, could make equal names pointer-identical throughout a package.
Existing `name_hash_map` equality would then usually terminate at the
first pointer check.

This is complementary to declaration indexing, but it carries
additional decoder ownership complexity and possibly a package-format
decision. It should not block the provider-index experiment.

## Alternatives considered

### Caching the Illuminate tick closure

Illuminate now lazily constructs one partially applied tick closure
per player and clears it at disposal. This is semantically faithful
and avoids reconstructing that closure, but it does not preserve
internal interpreter resolution state. Measurements found no reliable
large improvement, and the name-resolution profile remained unchanged.

### One shared `tickAll` call

An application-level scheduler could update every active player
through one Lean entry per browser frame. Nested calls would share one
interpreter-local cache and this may substantially improve
multi-player scaling.

This remains a useful Illuminate optimization, but applications should
not need to batch unrelated callbacks to avoid a linear package
declaration scan. It also would not address the one-player fixed floor
as directly.

### Moving more DOM work into JavaScript

The profile does not support this as the primary response. Both
players already share equivalent DOM work, and explicit `setAttribute`
time was about 1.3–1.5% of active samples.

### AOT-compiled WebAssembly

An AOT path would change the performance class of the workload but is
outside the scope of this targeted interpreter/provider improvement.

## Correctness test plan

Package-provider tests should cover:

1. first, middle, and last declaration lookup;
2. missing declaration lookup;
3. a separately allocated but structurally equal `Lean.Name`;
4. boxed and unboxed names with no accidental collision;
5. duplicate names preserving the current first-match result, or
   explicit duplicate rejection if maintainers choose to strengthen
   package validation;
6. package A load, clear, then package B load without stale A results;
7. initializer failure followed by complete cache clearing;
8. repeated load/clear cycles with stable Lean reference counts;
9. two WebAssembly runtime instances remaining isolated;
10. existing package, native-wrapper, host-import, callback,
    resource-lifecycle, and package-replacement smoke tests.

Illuminate should continue to run:

- all 105 differential playback traces;
- the 16-pair DOM comparison dashboard;
- pause/cancellation/disposal tests;
- two-player independence tests;
- Reveal reverse-navigation and slide-change tests.

## Performance validation plan

### Instrumentation

Add development or benchmark counters for:

- interpreter constructions;
- `lookup_symbol` calls and local hits/misses;
- `find_package_decl` calls;
- declaration-index hits/misses;
- linear comparisons in the baseline implementation;
- boxed declaration and host-import lookups;
- current package generation.

Counters are preferable to inferring all provider work from sampled
`lean_name_eq` stacks.

### Microbenchmarks

Measure declaration hits at the beginning, middle, and end of packages
of increasing size, plus misses. Report
package-load/index-construction time and index memory alongside lookup
throughput.

Also add a repeated fresh-entry interpreter benchmark, because a
single long interpreter invocation benefits from the existing local
cache and does not reproduce the browser callback pattern.

### Illuminate macrobenchmark

Repeat the unprofiled isolated-player benchmark with multiple
interleaved baseline/candidate runs. Report medians and confidence
intervals rather than comparing one run per revision.

Track:

- mean and p95 callback duration;
- callbacks over 16.7 ms;
- 60 Hz loop CPU for the morphing-arrows and radial-gradient examples;
- 16-player aggregate callback CPU;
- DOM equality and playback state equality.

Then repeat the CDP profile qualitatively. The expected signal is a
large reduction in `lean_name_eq` and `get_decl` attribution. If
callback time remains near 1 ms while provider comparison counts
collapse, the next investigation should focus on the remaining
interpreter-local/native maps and generic IR dispatch rather than DOM
or host-resource ownership.

## Review questions for VIR maintainers

1. Does the package provider intentionally use linear vectors because
   package sizes were expected to remain small, or is an index already
   planned?
2. Should duplicate declaration names preserve first-match behavior or
   be rejected at package-load validation?
3. Would maintainers prefer indices for declarations only in the first
   patch, or all name-addressed package tables together?
4. Is `g_package_generation` intended to become the common
   invalidation key for package-owned caches?
5. If a second-stage persistent symbol cache is needed, would an
   optional upstream interpreter cache/context API be acceptable, or
   should it remain a VIR-local vendored patch?
6. Is package-format name interning already on the roadmap?

## Recommendation

Implement and benchmark the package declaration and boxed-declaration
indices first. This is the smallest change that directly addresses a
demonstrated linear hot path, remains entirely within VIR's immutable
package semantics, and leaves the upstream interpreter unchanged.

Only after that result is measured should VIR consider persistent
resolved-symbol metadata across asynchronous interpreter entries. That
second stage may be valuable, but the current provider scan is a
simpler and safer cause to remove first.
