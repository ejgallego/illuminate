# FIR handoff: LLVM/Emscripten Illuminate selection player

This task uses branch-only coordination. Keep the work on a named
`ejgallego/lean-fir` branch and do not open a pull request.

## Objective

Produce a browser-ready LLVM/Emscripten package for Illuminate's real
selection-only animation player. It will occupy the fourth slot in the
focused animation dashboard, beside the original JavaScript player,
VIR, and FIR-native Wasm. All four players receive the same animation
fixture and commands.

The LLVM package is a second compiler/runtime implementation of the
existing Lean state machine. Do not duplicate the state machine or add
adapter-side animation semantics.

## Reproducible Illuminate input

Consume Illuminate read-only from commit
`23f291b15b4ec1ce0e41564d040329a44acb5172` on branch
`ejgallego/feat/vir-hit-scene`. The required source hashes are:

```text
src/Illuminate/Animation/Types.lean
97a030fdd3ef718912479343cadf0131616a8a9b458901e963dc3709cf5633a3

src/Illuminate/Animation/Player.lean
e1f98f9d02118f4b61a3f935dbdf49b1c3caf7c0b52aa0f80b7232fb740cd620

src/Illuminate/Animation/FirLive.lean
941daf939d9faa966aa8fb848b4a8f7ce0525ba6420d3843067e2c97908e2121

src/Illuminate/Animation/FirSelection.lean
a80771bcc8a4b09db99f004559726654dacc102d9982909ccf863f3d60ed0e83
```

Compile the same real entries used by FIR-native v4:

```lean
Illuminate.AnimationPlayer.initialSelectionLive :
  SelectionAnimation → Except String LiveSelectionTransition

Illuminate.AnimationPlayer.transitionSelectionLive :
  SelectionAnimation → PlayerState → PlayerEvent → LiveSelectionTransition
```

Provide a scalar-tick path if the LLVM boundary can construct
`PlayerEvent.tick timestamp` internally. The generic transition
remains its semantic oracle, and timestamp transport must preserve
every IEEE-754 binary64 bit.

## Browser contract

The application must be able to create a retained player, dispatch all
six `PlayerEvent` constructors, use a scalar tick on the
animation-frame hot path, and dispose the player. The returned data is
the copied `FrameSelection` plus the Lean scheduling decision. SVG
documents, `pmap`, and `params` remain owned by JavaScript and must
not cross the compiler boundary.

Match the logical operations of `fir.illuminate-player.browser/v4`:

```text
createPlayer(animation)
dispatch(player, event)
dispatchTick(player, timestamp)
disposePlayer(player)
replayTrace(animation, events)
```

Keep the semantic and ownership constants equal to the accepted
FIR-native v4 adapter, and declare the Emscripten transport
separately:

```text
ILLUMINATE_SELECTION_PLAYER_ADAPTER_API_VERSION =
  fir.illuminate-player.browser/v4
ILLUMINATE_SELECTION_PLAYER_INPUT_LAYOUT_VERSION =
  lean-4.32-Illuminate.Animation.SelectionAnimation/v4
ILLUMINATE_SELECTION_PLAYER_OWNERSHIP_VERSION =
  fir.illuminate-player.persistent-checkpoint/v2
ILLUMINATE_SELECTION_PLAYER_HOT_EVENT_VERSION =
  fir.illuminate-player.hot-event/v1
ILLUMINATE_SELECTION_PLAYER_EMSCRIPTEN_WIRE_VERSION =
  fir.illuminate-player.emscripten-wire/v1
```

Export
`loadEmscriptenIlluminateSelectionPlayerAdapter(manifestSource, options?)`
from the browser adapter. It returns the five-operation adapter above.
The separate wire constant identifies LLVM-specific encoding without
making the semantic player API compiler-specific.

Include explicit phase timings for projection, encoding/marshal,
execution, decoding, and total call time so the dashboard can make an
apples-to-apples comparison. State which work is excluded from each
interval. Each successful operation must expose nonnegative
`encodeMs`, `executeMs`, `decodeMs`, and `totalMs`; creation
additionally exposes `projectMs`. Its memory record must expose
`currentBytes` and the instance-lifetime high-water mark `peakBytes`.

Prefer an unthreaded package that runs on Illuminate's ordinary static
server. If the generated Lean runtime requires threads, record the
exact COOP/COEP and `crossOriginIsolated` requirements in the manifest
and smoke test; do not hide that requirement in the loader.

Package through the shared VIR browser benchmark producer boundary:

```text
producer protocol: browser-benchmarks/source-package/v1
producer adapter:  fir-llvm
runtime boundary:  browser-benchmarks/bounded-runtime/v1
```

The immutable package must use these names so Illuminate can stage
producer bytes without rewriting them:

```text
README.md
SHA256SUMS
emscripten-loader.mjs
illuminate-selection-player-emscripten-adapter.mjs
illuminate-selection-player.manifest.json
illuminate-selection-player.mjs
illuminate-selection-player.wasm
smoke.mjs
```

The self-describing manifest must use `profile: "emscripten"`,
inventory the module and Wasm under `artifacts` with byte lengths and
SHA-256 values, record the exact Illuminate source commit and
relevant-file hashes, and declare the five browser methods plus all
capability versions above. Follow the existing `prettyM` FIR-LLVM
package as the structural precedent, but retain the Illuminate v4
selection projection and lifecycle contract.

## Ownership and performance constraints

- Project the animation timeline once when the player is created.
- Never transfer segment `sync`, `pmap`, or `params` into LLVM memory.
- Keep animation and player state resident across dispatches.
- Do not reconstruct resident state from a JavaScript snapshot per
  tick.
- Reclaim all player-owned state on `disposePlayer`; make disposal
  idempotent.
- Expose copied selections only, never raw runtime addresses.
- Keep DOM patch materialization and DOM application outside the
  measured compiler callback, exactly as for VIR and FIR-native.
- Report current and peak runtime memory so persistent growth is
  visible.

## Acceptance

1. All 107 legacy/VIR/FIR differential traces also match LLVM.
2. All six `PlayerEvent` constructors are covered.
3. Adjacent binary64 tick timestamps retain their exact bits.
4. Host-side materialization covers both `PatchTarget.textContent` and
   `PatchTarget.attribute`.
5. Two concurrent players are isolated, disposal is idempotent, and
   repeated creation/disposal does not retain player state.
6. A long tick run has stable memory after warmup.
7. All 16 dashboard fixtures retain DOM equality while JavaScript,
   VIR, FIR-native, and LLVM run under the same shared controls.
8. A balanced fixed-event benchmark reports callback, marshal,
   execute, decode, and outer-overhead medians and p95 values without
   changing semantics.
9. The package-local smoke test and checksums pass before the producer
   returns success.
10. The package can be consumed immutably; Illuminate does not
    regenerate or rewrite producer bytes.

## Return to Illuminate

Return the named `ejgallego/lean-fir` branch and exact head, immutable
package path, source and compiler revisions, manifest/API versions,
complete Wasm and loader hashes and sizes, threading/isolation
requirements, phase definitions, memory/lifecycle results, and every
acceptance result. Also provide the exact `artifact-builds.json`
component record needed to register this producer in the shared
VIR/FIR example catalog.
