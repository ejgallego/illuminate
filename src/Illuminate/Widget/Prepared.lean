/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
module
public import Illuminate.Backend.SVG
public import Illuminate.Diagram.HitScene
import Illuminate.Diagram.Compile
import Lean.DocString.Syntax
public section

namespace Illuminate

/-- SVG markup and matching prepared geometry produced by one widget evaluation. -/
structure PreparedWidgetDiagram where
  /-- Rendered SVG markup. -/
  svg : String
  /-- Prepared geometry matching {name (full := PreparedWidgetDiagram.svg)}`svg`. -/
  scene : HitScene
  /-- Serialized hit scene matching {name (full := PreparedWidgetDiagram.svg)}`svg`. -/
  hitScene : String
deriving Repr, BEq, Inhabited

/-- Renders a widget diagram and prepares the geometry used for local hit testing. -/
def prepareWidgetDiagram
    (diagram : Diagram SVG) (labels : Array (Nat × String) := #[]) : PreparedWidgetDiagram :=
  let scene := diagram.prepareHitScene labels
  {
    svg := diagram.renderDiagram (padding := 5)
    scene
    hitScene := scene.encode
  }
