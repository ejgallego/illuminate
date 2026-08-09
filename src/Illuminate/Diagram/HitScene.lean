/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
module
public import Illuminate.Diagram.HitTest
import Illuminate.Geometry.Matrix
import Lean.Data.Json.FromToJson.Basic
import Lean.Data.Json.Parser
public section

namespace Illuminate

open Lean

/-- A rendering-independent tree prepared for repeated point hit tests. -/
inductive HitTree where
  /-- Contains no hittable geometry. -/
  | empty
  /-- Contains one prepared primitive. -/
  | primitive (value : HitPrimitive)
  /-- Replaces a successful child result with a numeric tag. -/
  | tag (value : Nat) (child : HitTree)
  /-- Maps a point into child coordinates with a precomputed inverse transform. -/
  | transform (inverse : Matrix) (child : HitTree)
  /-- Overlays a front tree over a back tree. -/
  | compose (back front : HitTree)
  /-- Restricts child hits to a path boundary. -/
  | clip (boundary : PathData) (child : HitTree)
deriving Repr, BEq, Inhabited

namespace HitTree

/-- Tests a prepared hit tree at a point in diagram coordinates. -/
def hitTest (tree : HitTree) (point : Point) : Click :=
  match tree with
  | .empty => .nothing
  | .primitive value => value.hitTest point
  | .tag value child =>
    if (hitTest child point).isHit then .tag value else .nothing
  | .transform inverse child => hitTest child (Matrix.applyPoint inverse point)
  | .compose back front =>
    let frontHit := hitTest front point
    if frontHit.isHit then frontHit else hitTest back point
  | .clip boundary child =>
    if boundary.contains point then hitTest child point else .nothing

end HitTree

/-- Immutable geometry and labels retained by a browser-resident hit-test service. -/
structure HitScene where
  /-- Prepared geometry in rendering order. -/
  tree : HitTree
  /-- Human-readable labels associated with numeric tags. -/
  labels : Array (Nat × String) := #[]
deriving Repr, BEq, Inhabited

/-- Allocation-conscious result returned across a browser hit-test boundary. -/
inductive HitSceneResult where
  /-- The point did not hit any geometry. -/
  | nothing
  /-- The point hit untagged geometry. -/
  | something
  /-- The point hit tagged geometry with an optional human-readable label. -/
  | tag (value : Nat) (label : String)
deriving Repr, BEq, Inhabited

namespace HitScene

/-- Looks up the human-readable label associated with a tag. -/
def label? (scene : HitScene) (tag : Nat) : Option String :=
  scene.labels.findSome? fun (value, label) => if value == tag then some label else none

/-- Tests a prepared scene at a point in diagram coordinates. -/
def hitTest (scene : HitScene) (point : Point) : Click :=
  scene.tree.hitTest point

/-- Tests a prepared scene and returns a browser-facing structured result. -/
def query (scene : HitScene) (x y : Float) : HitSceneResult :=
  match scene.hitTest (Point.mk x y) with
  | .nothing => .nothing
  | .something => .something
  | .tag value => .tag value (scene.label? value |>.getD "")

private def jsonField {α : Type} [Lean.FromJson α]
    (json : Lean.Json) (name : String) : Except String α := do
  Lean.FromJson.fromJson? (← json.getObjVal? name)

private def vecToJson (value : Vec2) : Lean.Json :=
  .mkObj [("x", toJson value.x), ("y", toJson value.y)]

private def vecFromJson (json : Lean.Json) : Except String Vec2 := do
  pure { x := ← jsonField json "x", y := ← jsonField json "y" }

private def matrixToJson (value : Matrix) : Lean.Json :=
  .mkObj [
    ("a", toJson value.a),
    ("b", toJson value.b),
    ("tx", toJson value.tx),
    ("c", toJson value.c),
    ("d", toJson value.d),
    ("ty", toJson value.ty)]

private def matrixFromJson (json : Lean.Json) : Except String Matrix := do
  pure {
    a := ← jsonField json "a"
    b := ← jsonField json "b"
    tx := ← jsonField json "tx"
    c := ← jsonField json "c"
    d := ← jsonField json "d"
    ty := ← jsonField json "ty"
  }

private def commandToJson : PathCmd → Lean.Json
  | .moveTo point => .mkObj [("kind", "moveTo"), ("point", vecToJson point)]
  | .lineTo point => .mkObj [("kind", "lineTo"), ("point", vecToJson point)]
  | .curveTo control1 control2 endpoint => .mkObj [
      ("kind", "curveTo"),
      ("control1", vecToJson control1),
      ("control2", vecToJson control2),
      ("endpoint", vecToJson endpoint)]
  | .arcTo rx ry rotation largeArc sweep endpoint => .mkObj [
      ("kind", "arcTo"),
      ("rx", toJson rx),
      ("ry", toJson ry),
      ("rotation", toJson rotation),
      ("largeArc", toJson largeArc),
      ("sweep", toJson sweep),
      ("endpoint", vecToJson endpoint)]
  | .closePath => .mkObj [("kind", "closePath")]

private def commandFromJson (json : Lean.Json) : Except String PathCmd := do
  let kind : String ← jsonField json "kind"
  match kind with
  | "moveTo" => pure (.moveTo (← vecFromJson (← json.getObjVal? "point")))
  | "lineTo" => pure (.lineTo (← vecFromJson (← json.getObjVal? "point")))
  | "curveTo" => pure (.curveTo
      (← vecFromJson (← json.getObjVal? "control1"))
      (← vecFromJson (← json.getObjVal? "control2"))
      (← vecFromJson (← json.getObjVal? "endpoint")))
  | "arcTo" => pure (.arcTo
      (← jsonField json "rx")
      (← jsonField json "ry")
      (← jsonField json "rotation")
      (← jsonField json "largeArc")
      (← jsonField json "sweep")
      (← vecFromJson (← json.getObjVal? "endpoint")))
  | "closePath" => pure .closePath
  | other => throw s!"unknown hit-scene path command: {other}"

private def pathToJson (path : PathData) : Lean.Json :=
  .arr (path.commands.map commandToJson)

private def pathFromJson (json : Lean.Json) : Except String PathData := do
  let commands : Array Lean.Json ← Lean.FromJson.fromJson? json
  pure { commands := ← commands.mapM commandFromJson }

private def primitiveToJson : HitPrimitive → Lean.Json
  | .path data hasFill strokeWidth => .mkObj [
      ("kind", "path"),
      ("data", pathToJson data),
      ("hasFill", toJson hasFill),
      ("strokeWidth", toJson strokeWidth)]
  | .bounds left right bottom top => .mkObj [
      ("kind", "bounds"),
      ("left", toJson left),
      ("right", toJson right),
      ("bottom", toJson bottom),
      ("top", toJson top)]

private def primitiveFromJson (json : Lean.Json) : Except String HitPrimitive := do
  let kind : String ← jsonField json "kind"
  match kind with
  | "path" => pure (.path
      (← pathFromJson (← json.getObjVal? "data"))
      (← jsonField json "hasFill")
      (← jsonField json "strokeWidth"))
  | "bounds" => pure (.bounds
      (← jsonField json "left")
      (← jsonField json "right")
      (← jsonField json "bottom")
      (← jsonField json "top"))
  | other => throw s!"unknown hit-scene primitive: {other}"

private def treeToJson : HitTree → Lean.Json
  | .empty => .mkObj [("kind", "empty")]
  | .primitive value => .mkObj [("kind", "primitive"), ("value", primitiveToJson value)]
  | .tag value child => .mkObj [
      ("kind", "tag"),
      ("value", toJson value),
      ("child", treeToJson child)]
  | .transform inverse child => .mkObj [
      ("kind", "transform"),
      ("inverse", matrixToJson inverse),
      ("child", treeToJson child)]
  | .compose back front => .mkObj [
      ("kind", "compose"),
      ("back", treeToJson back),
      ("front", treeToJson front)]
  | .clip boundary child => .mkObj [
      ("kind", "clip"),
      ("boundary", pathToJson boundary),
      ("child", treeToJson child)]

private partial def treeFromJson (json : Lean.Json) : Except String HitTree := do
  let kind : String ← jsonField json "kind"
  match kind with
  | "empty" => pure .empty
  | "primitive" => pure (.primitive (← primitiveFromJson (← json.getObjVal? "value")))
  | "tag" => pure (.tag
      (← jsonField json "value")
      (← treeFromJson (← json.getObjVal? "child")))
  | "transform" => pure (.transform
      (← matrixFromJson (← json.getObjVal? "inverse"))
      (← treeFromJson (← json.getObjVal? "child")))
  | "compose" => pure (.compose
      (← treeFromJson (← json.getObjVal? "back"))
      (← treeFromJson (← json.getObjVal? "front")))
  | "clip" => pure (.clip
      (← pathFromJson (← json.getObjVal? "boundary"))
      (← treeFromJson (← json.getObjVal? "child")))
  | other => throw s!"unknown hit-scene node: {other}"

/-- Serializes a prepared hit scene for one-time browser mounting. -/
def encode (scene : HitScene) : String :=
  toString <| Lean.Json.mkObj [
    ("tree", treeToJson scene.tree),
    ("labels", .arr (scene.labels.map fun (value, label) =>
      .mkObj [("value", toJson value), ("label", toJson label)]))]

/-- Parses a prepared hit scene serialized by {name}`encode`. -/
def decode (source : String) : Except String HitScene := do
  let json ← Lean.Json.parse source
  let labelsJson : Array Lean.Json ← jsonField json "labels"
  let labels ← labelsJson.mapM fun entry => do
    pure (← jsonField entry "value", ← jsonField entry "label")
  pure {
    tree := ← treeFromJson (← json.getObjVal? "tree")
    labels
  }

end HitScene

namespace Diagram

variable {β : Type}

/-- Discards rendering-only data and prepares a diagram for repeated hit tests. -/
def prepareHitTree : Diagram β → HitTree
  | .empty => .empty
  | .prim primitive => .primitive primitive.prepareHit
  | .foreign _ child => prepareHitTree child
  | .tag value child => .tag value (prepareHitTree child)
  | .named _ child => prepareHitTree child
  | .transform matrix child =>
    match Matrix.inverse matrix with
    | none => .empty
    | some inverse => .transform inverse (prepareHitTree child)
  | .compose back front => .compose (prepareHitTree back) (prepareHitTree front)
  | .withEnv _ child => prepareHitTree child
  | .warning _ child => prepareHitTree child
  | .cellophane _ child => prepareHitTree child
  | .clip boundary child => .clip boundary (prepareHitTree child)
  | .arrow _ _ _ _ child => prepareHitTree child
  | .showEnv _ _ _ child => prepareHitTree child
  | .scope child => prepareHitTree child

/-- Builds an immutable hit scene from a diagram and optional tag labels. -/
def prepareHitScene (diagram : Diagram β) (labels : Array (Nat × String) := #[]) : HitScene :=
  { tree := diagram.prepareHitTree, labels }
