/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
import Illuminate.Diagram.HitScene.Spatial
import Vir.Attributes
import Vir.Runtime
import Vir.Js

namespace Illuminate.HitScene.SpatialVir

open Lean.Vir

/-- Lean-owned spatial hit scene retained behind an opaque JavaScript resource. -/
abbrev Handle := JSL SpatialHitScene

/-- Builds and retains a spatial index over one prepared hit scene. -/
@[vir_export]
def mount (scene : HitScene) : RuntimeM Handle :=
  LeanRef.toJSL (SpatialHitScene.ofHitScene scene)

/-- Queries a retained spatial hit scene with bit-exact binary64 diagram coordinates. -/
@[vir_export]
def query (handle : Handle) (x y : Float) : RuntimeM HitSceneResult := do
  let scene ← LeanRef.fromJSL handle
  pure (scene.query x y)

/-- Releases a retained spatial hit scene handle. -/
@[vir_export]
def dispose (handle : Handle) : RuntimeM Unit :=
  LeanRef.releaseJSL handle
