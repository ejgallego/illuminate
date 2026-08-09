# FIR integrator note: Illuminate scalar tick

This integration uses branch-only coordination. Do not create or
depend on pull requests for Illuminate or FIR.

## Source contract

Use the following exact Illuminate source for the current scalar-tick
package:

```text
repository: git@github.com:ejgallego/illuminate.git
branch:     feat/vir-performance
revision:   5a5f2b7d1ced7db4eed405315146b9687fd05252
```

The duplicate-frame-zero semantic fix is commit
`6f16cdc3d4320c093b53a9d381b92bfbb689b2ce` in that history. The source
inventory is:

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

Please record the repository, branch, and revision in FIR's
integration tree and make `integration/illuminate-player/check.sh`
reject a mismatched source checkout before generation. The branch name
is informative; the immutable revision and source hashes are the
actual contract.

## FIR handoff to publish

The local FIR wasm-generation worktree is clean at:

```text
float-setter support: 87a8e557
scalar-tick head:      ac7467f3af9598400be1f175510aff339ac6113a
```

Please publish that stack to a named `ejgallego/lean-fir` branch and
report the remote branch plus exact head. Do not use a pull request.
Also change the FIR README wording from “v3 artifact is unchanged” to
“v3 API remains unchanged”; the closure fingerprints and Wasm size
changed.

## Generated package identity

The clean local package is:

```text
integration/illuminate-player/_build/illuminate-selection-player-packages/
  ac7467f3af95-5a5f2b7d1ced-fb32d68c8d7915e19c8b
```

Its accepted identity for Illuminate-side validation is:

```text
complete Wasm bytes: 56,156
complete Wasm SHA-256: 8b13c8124ba7235e2a00cec154f42d406e6f568f071f51ec831bbb95486ae3f5
function imports: 0
memory imports: 0
memory owner: module
function exports: 7
adapter API: fir.illuminate-player.browser/v4
hot-event API: fir.illuminate-player.hot-event/v1
ownership: fir.illuminate-player.persistent-checkpoint/v2
```

The new public function is
`IlluminateFirNative.transitionSelectionTickLive._fir_bit_exact`. The
adapter exposes `dispatchTick(player, timestamp)`, constructs
`PlayerEvent.tick` in Wasm, transports the timestamp as binary64 bits
over `i64`, and performs zero host scratch allocations. Generic
`dispatch(player, { kind: "tick", timestamp })` remains the semantic
oracle.

The package checksum gate and packaged smoke pass, including 10,000
ticks at a flat checkpoint and zero hot-event scratch bytes.

## Illuminate consumer acceptance

Illuminate has now completed the consumer-side work locally:

1. the immutable package ratchet requires the seven-function export
   surface;
2. the host requires the hot-event capability and `dispatchTick`
   adapter method;
3. generic dispatch remains in the 107-trace differential suite;
4. scalar/generic tick equivalence, bit-adjacent Float, lifecycle, and
   frontier checks pass;
5. only animation-frame ticks use `dispatchTick` in the live host;
6. package smoke, the 107-way differential, TypeScript, all 523 Lean
   tests, `lake shake`, and all 64 structural/visual browser tests
   pass.

The clean package removes the 40-byte event allocation. The balanced
A/B reduced event encoding by 62–64% and median callback time by
4.6–8.8%. Publishing FIR revision `ac7467f3` on a named branch is
still required. The next task is specified in
`FIR_STATE_SYNC_HANDOFF.md`: in-place resident state synchronization
currently accounts for 42–46% of `decodeMs`.
