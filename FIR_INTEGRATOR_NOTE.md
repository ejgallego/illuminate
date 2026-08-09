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

## Illuminate acceptance after publication

After the FIR branch is published, Illuminate will:

1. update the immutable package ratchet to the seven-function export
   surface;
2. require the hot-event capability and `dispatchTick` adapter method;
3. keep generic dispatch in the 107-trace differential suite;
4. add scalar/generic tick equivalence, bit-adjacent Float, lifecycle,
   and frontier checks;
5. switch only animation-frame ticks to `dispatchTick` in the live
   host;
6. rerun package smoke, 107-way differential, TypeScript, Lean,
   structural, visual, and dashboard performance checks.

Measured provisionally before the clean publication, the scalar entry
removed the 40-byte event allocation, reduced event encoding by
62–64%, and reduced median callback time by 4.6–8.8%. It is a small
independent improvement; the next high-value FIR target remains
in-place resident state synchronization, which currently accounts for
42–46% of `decodeMs`.
