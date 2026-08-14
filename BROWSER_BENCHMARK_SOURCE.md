# Browser benchmark source package

Illuminate owns the semantic input and JavaScript oracle used by VIR’s
canonical browser benchmark catalog. VIR invokes its repository-owned
producer from an exact clean checkout with:

```sh
scripts/export-browser-benchmark-source.mjs \
  --output /fresh/output/directory \
  --checkout producer=/path/to/illuminate
```

The producer derives the toolchain from the checkout's exact
`lean-toolchain` pin. The output directory must not exist. The command
writes only below that directory and emits:

- `workload/examples.json`: the 16 Lean-compiled animation fixtures;
- `workload/anim_core.js`: the production JavaScript animation
  helpers;
- `workload/js-player-trace.mjs`: the deterministic JavaScript
  state-machine oracle;
- `workload/vir-player-trace.mjs`: the typed VIR projection and result
  normalizer;
- `BUILD.json`, `SHA256SUMS`, and a package-local `smoke.mjs`.

The package advertises `browser-benchmarks/source-package/v1`. It
deliberately contains no VIR or FIR binaries: VIR owns catalog
orchestration and artifact assembly. FIR’s full-action v3 package
already has a fresh-output exporter; the current selection package
still needs the equivalent FIR-owned entry point.

For direct local use, `npm run export:browser-benchmark-source --`
also accepts `--source PATH --toolchain NAME` instead of `--checkout`.
The two source forms cannot be combined. This source-only package
rejects unknown checkout roles and every `--package` argument.
