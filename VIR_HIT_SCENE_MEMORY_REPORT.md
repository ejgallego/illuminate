# VIR retained hit-scene memory report

## PR #103 validation

VIR PR #103, `fix: make foreign JS resource lifetimes safe`, fixes the
memory growth described in this report. The validation used PR head
`5e4aac26c2b00e2f9113be5a73cf230f96584385`, with the native-runtime
frontier and Float geometry extern commits rebased on top. The
combined test head is `f85dfa5238eb61c28b9c45371c5429a798e6e9fa`.

The production differential still matches all 301 oracle queries. Its
strict stability run completes 10,000 further mixed queries with Wasm
memory fixed at 4,194,304 bytes. Before PR #103, the same assertion
observed 5,373,952 bytes after warm-up and 11,272,192 bytes after the
additional queries.

The two minimal path-result reproducers also remain exactly at
4,194,304 bytes through 50,000 calls:

|  Calls | Fill results | Stroke results |
| -----: | -----------: | -------------: |
|      0 |    4,194,304 |      4,194,304 |
|  1,000 |    4,194,304 |      4,194,304 |
|  5,000 |    4,194,304 |      4,194,304 |
| 10,000 |    4,194,304 |      4,194,304 |
| 20,000 |    4,194,304 |      4,194,304 |
| 50,000 |    4,194,304 |      4,194,304 |

Both now report 0 steady bytes per call. This strongly confirms that
the bug was in VIR's cross-boundary result ownership rather than
Illuminate's retained `JSL` handle design or path semantics.

The first full post-rebase timing run reported a 1.30 ms median query
and 1.08 ms median interpreter execution phase, compared with the
pre-PR figures below. These are diagnostic single-process samples, not
an acceptance regression; they should be compared with isolated,
repeated before/after runs before drawing a performance conclusion.

The staged PR #103 validation artifacts have these hashes:

```text
45187c73a265dd438ab5b44165c8a150f06c88163e57ad7babbfa63a209bd945  vir-upstream.wasm
59b9e681efabda8498e13406f59c8df9e7fb32cb1caabf1b3c31affe3f9ad6c6  Vir.irpkg
```

## Original finding on `feat/float-geometry-math`

VIR branch `feat/float-geometry-math` at
`e39b1cdd8f3be5105ff515c3b488a8aa81b6d345` compiles and correctly
executes Illuminate's real retained hit-scene query. All 301
runtime-neutral oracle queries match. A strict long-run check
nevertheless shows linear Wasm-memory growth in path intersection
code.

The opaque `JSL` handle boundary is not responsible. Borrowing and
dropping the retained scene, reading a scalar field, looking up a
label, traversing the tree without geometry, and testing fixed bounds
all remain flat. The problem reduces to a retained two-command line
path and one eastward trace query.

This was reported as a VIR runtime/interpreter ownership issue.
Illuminate kept its 10,000-query flat-memory assertion and did not add
a workaround; that unchanged assertion now passes on PR #103.

## Environment

- Illuminate worktree:
  `/home/egallego/lean/illuminate/.worktrees/vir-hit-scene`
- Illuminate branch: `feat/vir-hit-scene`
- Illuminate base: `c98c121488871f5d3cdb12d14533643672f1bbd6`
- Repository-local VIR checkout:
  `/home/egallego/lean/illuminate/.worktrees/vir-hit-scene/vir`
- VIR commit: `e39b1cdd8f3be5105ff515c3b488a8aa81b6d345`
- Toolchain: `leanprover/lean4:4.33.0-rc2`
- VIR package format: 10

The production package contains 21 package-set members and 296
declarations: 243 Lean IR declarations and 53 native externs. Its
interface has exactly three exports:

```text
Illuminate.HitScene.Vir.mount
Illuminate.HitScene.Vir.query
Illuminate.HitScene.Vir.dispose
```

## Production result

The runtime-neutral fixture is `test_output/hit-scene-benchmark.json`.
It contains a 4,088-byte encoded scene and 301 bit-exact queries
covering every `HitTree`, `HitPrimitive`, `PathCmd`, and
`HitSceneResult` constructor.

The quick production run passes all semantics and reports a median
untimed query of about 0.81 ms on this machine. Its separately
profiled median phases were approximately:

```text
marshal   0.0028 ms
execute   0.9881 ms
decode    0.0020 ms
host      0.0031 ms
total     1.0099 ms
```

The timing figures are informative rather than acceptance thresholds.
The important result is that execution dominates; the retained
typed-object boundary is already small.

A fresh mixed workload stays inside the initial 4 MiB through 3,010
queries, then grows to 7,995,392 bytes by query 10,000. Page growth
begins at query 3,574 and continues by 64 KiB roughly every 100--120
mixed queries. Both plain `runtime.call` and diagnostic
`runtime.callTimed` exhibit the growth.

## Isolation matrix

The diagnostic module is
`src/Illuminate/Diagram/HitScene/VirMemoryProbe.lean`; the runner is
`scripts/measure-vir-hit-scene-probes.mjs`.

These cases remain exactly at 4,194,304 bytes through 10,000 calls:

- fixed-bounds hit testing without a handle;
- `LeanRef.fromJSL` followed by immediate drop;
- retained-scene label-array size;
- structural recursive `HitTree` node counting;
- retained-scene label lookup;
- mapping a one-element `Array Float`;
- mapping a one-element `Array StrokeHit`.

The repository's ordinary VIR fixture package was also checked through
20,000 calls. These remain exactly at 4,194,304 bytes:

- `Vir.Fixtures.Basic.arrayPushChecksum`;
- `Vir.Fixtures.InterfaceShapes.arrayNatBumpAll`;
- `Vir.Fixtures.InterfaceShapes.baseArrayNatSum`.

Thus neither scalar object calls, `JSL`, recursive traversal by
itself, nor generic array push/map/fold is sufficient to reproduce the
growth.

## Minimal path reproducer

The path is mounted once as typed data:

```js
{
  commands: [
    { kind: "moveTo", value: { x: 1, y: -1 } },
    { kind: "lineTo", value: { x: 1, y: 1 } },
  ],
}
```

Each call casts an eastward ray from `(0, 0)`, which intersects the
line once. The Lean probes return the trace result arrays directly so
the normal VIR decoder consumes and releases them:

```lean
def pathFillEastResults
    (handle : PathHandle) (x y : Float) : RuntimeM (Array Float) := do
  let path ← LeanRef.fromJSL handle
  pure ((Trace.ofPathData path.commands).query (Point.mk x y) Vec2.east)

def pathStrokeEastResults
    (handle : PathHandle) (x y : Float) : RuntimeM (Array StrokeHit) := do
  let path ← LeanRef.fromJSL handle
  pure ((StrokeTrace.ofPathData path.commands 1).query (Point.mk x y) Vec2.east)
```

Observed Wasm linear-memory sizes:

|  Calls | Fill results | Stroke results |
| -----: | -----------: | -------------: |
|      0 |    4,194,304 |      4,194,304 |
|  1,000 |    4,194,304 |      4,194,304 |
|  5,000 |    4,194,304 |      4,194,304 |
| 10,000 |    4,325,376 |      4,718,592 |
| 20,000 |    6,291,456 |      7,143,424 |
| 50,000 |   12,320,768 |     14,352,384 |

Between 20,000 and 50,000 identical calls, this is approximately 201
bytes per fill call and 240 bytes per stroke call. The initial 4 MiB
allocator capacity masks the growth at low call counts, so a
1,000-call smoke test is insufficient.

Returning only `.size` instead of the arrays does not remove the
issue. A single eastward query over the fixture path also grows, while
the full eight-direction stroke test amplifies the effect. The real
tagged query reaches 15,794,176 bytes after 10,000 repeated calls.

## Reproduction

From the Illuminate worktree:

```sh
npm run stage:vir-hit-scene
lake build +Illuminate.Diagram.HitScene.VirMemoryProbe:vir
npm run measure:vir-hit-scene-probes -- \
  --long \
  --only=one-line-fill-east-results,one-line-stroke-east-results
```

Control fixtures can be rerun with:

```sh
node --no-warnings /tmp/vir_array_memory_probe.mjs
```

The temporary control script only calls declarations from VIR's
generated `fixtures-basic.irpkg`; its three exact call names are
listed above. If a repository-owned reproducer is preferred, the same
loops can be moved into VIR's boundary fixture suite.

The production semantic/stability test is:

```sh
npm run test:vir-hit-scene
```

On the original `e39b1cd` revision it intentionally failed with:

```text
AssertionError: VIR Wasm memory grew after hit-scene warmup
```

On the combined PR #103 validation head, the same command passes with
memory fixed at 4,194,304 bytes.

The short semantic check remains available as:

```sh
npm run test:vir-hit-scene -- --quick
```

## Original requested VIR follow-up

1. Reproduce the one-line fill and stroke loops above in a VIR-owned
   fixture.
2. Inspect ownership for the LCNF closure containing `pathDataHits`,
   especially arrays of constructor objects and the subsequent
   `Array.map` from `RawHit` to `Float` or `StrokeHit`.
3. Distinguish a missing LCNF decrement from an interpreter execution
   bug by running the same declaration through native Lean and the VIR
   IR interpreter.
4. Add a memory plateau assertion that runs far enough to exhaust the
   initial 4 MiB capacity; 50,000 one-line calls complete in a few
   seconds.
5. Re-run Illuminate's 301-way differential and strict 10,000-query
   stability test after the fix.

No API change is requested. The retained-handle design and the landed
Float math registry are both validated by the controls.
