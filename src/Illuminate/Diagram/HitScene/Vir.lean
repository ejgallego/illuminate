/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
import Illuminate.Diagram.HitScene
import Vir.Attributes
import Vir.Runtime
import Vir.Js

namespace Illuminate.HitScene.Vir

open Lean.Vir

/-- Lean-owned immutable hit scene retained behind an opaque JavaScript resource. -/
abbrev Handle := JSL HitScene

/-- Retains one prepared hit scene for repeated browser queries. -/
@[vir_export]
def mount (scene : HitScene) : RuntimeM Handle :=
  LeanRef.toJSL scene

/-- Queries a retained hit scene with bit-exact binary64 diagram coordinates. -/
@[vir_export]
def query (handle : Handle) (x y : Float) : RuntimeM HitSceneResult := do
  let scene ← LeanRef.fromJSL handle
  pure (scene.query x y)

/-- Releases a retained hit scene handle. -/
@[vir_export]
def dispose (handle : Handle) : RuntimeM Unit :=
  LeanRef.releaseJSL handle
