/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: David Thrane Christiansen
-/
module
import IlluminateTests.Helpers
import Illuminate.Diagram.HitScene
public section


open Illuminate

/-!
# Hit test tests
-/

def testHitTest_filledRect_interior : IO Unit := do
  let d : Diagram SVG := Diagram.rect 10 10
  let result := d.hitTest (Point.mk 0 0)
  assertTrue result.isHit "filled rect interior should hit"

def testHitTest_filledRect_outside : IO Unit := do
  let d : Diagram SVG := Diagram.rect 10 10
  let result := d.hitTest (Point.mk 20 20)
  assertTrue (!result.isHit) "filled rect outside should miss"

def testHitTest_filledRect_strokeBoundary : IO Unit := do
  let d : Diagram SVG := Diagram.rect 10 10 (stroke := { width := 2 })
  -- Point at x=5.5 is outside the fill (half-width = 5) but within stroke (width 2, extends to 6)
  let result := d.hitTest (Point.mk 5.5 0)
  assertTrue result.isHit "stroke boundary should hit"

def testHitTest_noFill_interior : IO Unit := do
  let d : Diagram SVG := Diagram.fromStroke (PathData.rect 10 10) { width := 1 }
  let result := d.hitTest (Point.mk 0 0)
  assertTrue (!result.isHit) "no-fill interior should miss"

def testHitTest_noFill_strokeBoundary : IO Unit := do
  let d : Diagram SVG := Diagram.fromStroke (PathData.rect 10 10) { width := 2 }
  -- Point near the boundary (x=4.5, half-width=5, stroke width=2, so edge is at 4..6)
  let result := d.hitTest (Point.mk 4.5 0)
  assertTrue result.isHit "no-fill stroke boundary should hit"

def testHitTest_transparentFill_interior : IO Unit := do
  let d : Diagram SVG := Diagram.rect 10 10 (fill := .solid { color := Color.transparent })
  let result := d.hitTest (Point.mk 0 0)
  assertTrue result.isHit "transparent solid fill interior should hit"

def testHitTest_tag : IO Unit := do
  let d : Diagram SVG := .tag 42 (Diagram.rect 10 10)
  let result := d.hitTest (Point.mk 0 0)
  match result with
  | .tag n => assertTrue (n == 42) "tag should be 42"
  | _ => throw <| IO.userError "expected Click.tag"

def testHitTest_tag_miss : IO Unit := do
  let d : Diagram SVG := .tag 42 (Diagram.rect 10 10)
  let result := d.hitTest (Point.mk 20 20)
  match result with
  | .nothing => pure ()
  | _ => throw <| IO.userError "expected Click.nothing for miss"

def testHitTest_compose_frontToBack : IO Unit := do
  -- b (front, tag 2) is a small rect at origin; a (back, tag 1) is a large rect
  let a : Diagram SVG := .tag 1 (Diagram.rect 20 20)
  let b : Diagram SVG := .tag 2 (Diagram.rect 6 6)
  let d := Diagram.compose a b
  -- Hit the center: should get tag 2 (front)
  let result := d.hitTest (Point.mk 0 0)
  match result with
  | .tag n => assertTrue (n == 2) "front layer should win"
  | _ => throw <| IO.userError "expected Click.tag"

def testHitTest_compose_fallthrough : IO Unit := do
  let a : Diagram SVG := .tag 1 (Diagram.rect 20 20)
  let b : Diagram SVG := .tag 2 (Diagram.rect 6 6)
  let d := Diagram.compose a b
  -- Hit outside b but inside a: should get tag 1 (back)
  let result := d.hitTest (Point.mk 8 0)
  match result with
  | .tag n => assertTrue (n == 1) "should fall through to back layer"
  | _ => throw <| IO.userError "expected Click.tag"

def testHitTest_transform : IO Unit := do
  let d : Diagram SVG := Diagram.transform (Matrix.translate 10 0) (Diagram.rect 4 4)
  -- Rect is now centered at (10, 0), spans 8..12 in x
  let hitInside := d.hitTest (Point.mk 10 0)
  let hitOutside := d.hitTest (Point.mk 0 0)
  assertTrue hitInside.isHit "translated rect at center should hit"
  assertTrue (!hitOutside.isHit) "origin should miss translated rect"

def testHitTest_circle : IO Unit := do
  let d : Diagram SVG := Diagram.circle 5
  let hitInside := d.hitTest (Point.mk 0 0)
  let hitOutside := d.hitTest (Point.mk 6 0)
  assertTrue hitInside.isHit "circle interior should hit"
  assertTrue (!hitOutside.isHit) "outside circle should miss"

def testHitTest_gradientFill_interior : IO Unit := do
  let g := Gradient.vertical 10 #[
    { offset := 0, color := Color.red },
    { offset := 1, color := Color.blue }
  ]
  let d : Diagram SVG := Diagram.rect 10 10 (fill := .resolved (.gradient g))
  let result := d.hitTest (Point.mk 0 0)
  assertTrue result.isHit "gradient fill interior should hit"

def testHitTest_gradientFill_outside : IO Unit := do
  let g := Gradient.vertical 10 #[
    { offset := 0, color := Color.red },
    { offset := 1, color := Color.blue }
  ]
  let d : Diagram SVG := Diagram.rect 10 10 (fill := .resolved (.gradient g))
  let result := d.hitTest (Point.mk 20 20)
  assertTrue (!result.isHit) "gradient fill outside should miss"

def testPreparedHitScene_matchesDiagram : IO Unit := do
  let back : Diagram SVG := .tag 1 (Diagram.rect 24 20)
  let front : Diagram SVG :=
    .transform (Matrix.translate 6 0) <|
      .clip (PathData.circle 7) <|
        .tag 2 (Diagram.circle 5 (stroke := { width := 2 }))
  let text : Diagram SVG :=
    .transform (Matrix.translate 0 14) <| Diagram.text "prepared" { fontSize := 10 }
  let image : Diagram SVG :=
    .transform (Matrix.translate (-12) 0) <|
      .prim (.image { path := "prepared.svg", width := 6, height := 8 })
  let curvePath := PathData.empty
    |>.moveTo (Vec2.mk (-5) (-4))
    |>.curveTo (Vec2.mk (-2) 7) (Vec2.mk 2 7) (Vec2.mk 5 (-4))
    |>.lineTo (Vec2.mk (-5) (-4))
    |>.close
  let curve : Diagram SVG :=
    .transform (Matrix.translate 0 (-14)) <| Diagram.fromPath curvePath
  let styled : Diagram SVG :=
    .transform (Matrix.translate 15 14) <|
      Diagram.styledLines [[({ fontSize := 9 }, "styled")]]
  let diagram := Diagram.compose
    (Diagram.compose (Diagram.compose back front) curve)
    (Diagram.compose (Diagram.compose text image) styled)
  let scene := diagram.prepareHitScene #[(1, "back"), (2, "front")]
  let decoded ← match HitScene.decode scene.encode with
    | .ok value => pure value
    | .error message => throw <| IO.userError s!"prepared hit scene failed to decode: {message}"
  assertTrue (decoded == scene) "prepared hit scene codec should round-trip"
  let specialPoints := [
    Point.mk 0 0,
    Point.mk 6 0,
    Point.mk 12 0,
    Point.mk (-12) 0,
    Point.mk 0 14,
    Point.mk 40 40
  ]
  let gridPoints := (List.range 17).flatMap fun x =>
    (List.range 17).map fun y =>
      Point.mk ((x.toFloat - 8) * 3) ((y.toFloat - 8) * 3)
  let points := specialPoints ++ gridPoints
  for point in points do
    let expected := diagram.hitTest point
    let actual := decoded.hitTest point
    assertTrue (actual == expected) s!"prepared hit scene mismatch at ({point.x}, {point.y})"
  assertTrue (scene.label? 2 == some "front") "prepared hit scene should retain labels"
  assertTrue (scene.query 6 0 == .tag 2 "front") "prepared query should return its tag label"

def hitTestTests : List (String × IO Unit) :=
  [ ("hitTest: filled rect interior", testHitTest_filledRect_interior)
  , ("hitTest: filled rect outside", testHitTest_filledRect_outside)
  , ("hitTest: filled rect stroke boundary", testHitTest_filledRect_strokeBoundary)
  , ("hitTest: no-fill interior", testHitTest_noFill_interior)
  , ("hitTest: no-fill stroke boundary", testHitTest_noFill_strokeBoundary)
  , ("hitTest: transparent fill interior", testHitTest_transparentFill_interior)
  , ("hitTest: tag hit", testHitTest_tag)
  , ("hitTest: tag miss", testHitTest_tag_miss)
  , ("hitTest: compose front-to-back", testHitTest_compose_frontToBack)
  , ("hitTest: compose fallthrough", testHitTest_compose_fallthrough)
  , ("hitTest: transform", testHitTest_transform)
  , ("hitTest: circle", testHitTest_circle)
  , ("hitTest: gradient fill interior", testHitTest_gradientFill_interior)
  , ("hitTest: gradient fill outside", testHitTest_gradientFill_outside)
  , ("hitTest: prepared scene agrees", testPreparedHitScene_matchesDiagram)
  ]
