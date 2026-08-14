/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: David Thrane Christiansen
-/
module
import IlluminateTests.AnimationExamples
import Lean.Data.Json.Printer
public section

open Illuminate Lean

private def animationCatalogueJson : Json :=
  .arr <| animationExampleCatalogue.map fun (title, animation) =>
    .mkObj [
      ("title", .str title),
      ("data", compiledAnimationToLeanJson animation)]

def main (args : List String) : IO UInt32 := do
  match args with
  | [output] =>
    IO.FS.writeFile output (toString animationCatalogueJson ++ "\n")
    IO.println s!"wrote {output} ({animationExampleCatalogue.size} animation examples)"
    pure 0
  | _ =>
    IO.eprintln "usage: illuminate-browser-benchmark-source OUTPUT"
    pure 2
