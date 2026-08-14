import Lake
open Lake DSL

package «illuminate-benchmark-source» where
  leanOptions := #[⟨`autoImplicit, false⟩]
  buildDir := ".lake/build-benchmark-source"

input_dir playerJs where
  text := true
  path := "player_js"

lean_lib «Illuminate» where
  srcDir := "src"
  needs := #[playerJs]

lean_lib «IlluminateTests» where
  srcDir := "test"
  leanOptions := #[⟨`linter.missingDocs, false⟩]

lean_exe «illuminate-browser-benchmark-source» where
  srcDir := "test"
  root := `ExportBrowserBenchmark
  leanOptions := #[⟨`linter.missingDocs, false⟩]
