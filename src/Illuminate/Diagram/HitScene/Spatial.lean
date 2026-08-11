/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
module
public import Illuminate.Diagram.HitScene
import Illuminate.Geometry.Matrix
public section

namespace Illuminate

/-- Conservative axis-aligned bounds used to reject whole hit-test subtrees. -/
structure HitRegion where
  /-- Lower horizontal bound when its presence flag is true. -/
  left : Float := 0
  /-- Upper horizontal bound when its presence flag is true. -/
  right : Float := 0
  /-- Lower vertical bound when its presence flag is true. -/
  bottom : Float := 0
  /-- Upper vertical bound when its presence flag is true. -/
  top : Float := 0
  /-- Indicates that the horizontal lower bound is valid. -/
  hasLeft : Bool := false
  /-- Indicates that the horizontal upper bound is valid. -/
  hasRight : Bool := false
  /-- Indicates that the vertical lower bound is valid. -/
  hasBottom : Bool := false
  /-- Indicates that the vertical upper bound is valid. -/
  hasTop : Bool := false
deriving Repr, BEq, Inhabited

namespace HitRegion

private structure Axis where
  lower : Float := 0
  upper : Float := 0
  hasLower : Bool := false
  hasUpper : Bool := false

private def finiteAxis (lower upper : Float) : Axis :=
  { lower, upper, hasLower := true, hasUpper := true }

private def scaleAxis (coefficient : Float) (axis : Axis) : Axis :=
  if coefficient == 0 then finiteAxis 0 0
  else if coefficient > 0 then
    let lower := coefficient * axis.lower
    let upper := coefficient * axis.upper
    {
      lower
      upper
      hasLower := axis.hasLower && lower == lower
      hasUpper := axis.hasUpper && upper == upper
    }
  else if coefficient < 0 then
    let lower := coefficient * axis.upper
    let upper := coefficient * axis.lower
    {
      lower
      upper
      hasLower := axis.hasUpper && lower == lower
      hasUpper := axis.hasLower && upper == upper
    }
  else {}

private def addAxis (first second : Axis) : Axis :=
  let lower := first.lower + second.lower
  let upper := first.upper + second.upper
  {
    lower
    upper
    hasLower := first.hasLower && second.hasLower && lower == lower
    hasUpper := first.hasUpper && second.hasUpper && upper == upper
  }

private def translateAxis (offset : Float) (axis : Axis) : Axis :=
  let lower := axis.lower + offset
  let upper := axis.upper + offset
  {
    lower
    upper
    hasLower := axis.hasLower && lower == lower
    hasUpper := axis.hasUpper && upper == upper
  }

private def xAxis (region : HitRegion) : Axis :=
  {
    lower := region.left
    upper := region.right
    hasLower := region.hasLeft
    hasUpper := region.hasRight
  }

private def yAxis (region : HitRegion) : Axis :=
  {
    lower := region.bottom
    upper := region.top
    hasLower := region.hasBottom
    hasUpper := region.hasTop
  }

private def ofAxes (x y : Axis) : HitRegion :=
  {
    left := x.lower
    right := x.upper
    bottom := y.lower
    top := y.upper
    hasLeft := x.hasLower
    hasRight := x.hasUpper
    hasBottom := y.hasLower
    hasTop := y.hasUpper
  }

private def expandLower (present : Bool) (value : Float) : Float :=
  if !present then value
  else
    let expanded := value - (value.abs + 1) * 1e-12
    if expanded == expanded then expanded else value

private def expandUpper (present : Bool) (value : Float) : Float :=
  if !present then value
  else
    let expanded := value + (value.abs + 1) * 1e-12
    if expanded == expanded then expanded else value

/-- Tests whether a point lies within every finite side of a conservative region. -/
def contains (region : HitRegion) (point : Point) : Bool :=
  (!region.hasLeft || point.x >= region.left) &&
    (!region.hasRight || point.x <= region.right) &&
    (!region.hasBottom || point.y >= region.bottom) &&
    (!region.hasTop || point.y <= region.top)

/-- Computes conservative bounds containing both input regions. -/
def union (first second : HitRegion) : HitRegion :=
  {
    left := Min.min first.left second.left
    right := Max.max first.right second.right
    bottom := Min.min first.bottom second.bottom
    top := Max.max first.top second.top
    hasLeft := first.hasLeft && second.hasLeft
    hasRight := first.hasRight && second.hasRight
    hasBottom := first.hasBottom && second.hasBottom
    hasTop := first.hasTop && second.hasTop
  }

/-- Transforms a conservative region through an affine matrix. -/
def transform (matrix : Matrix) (region : HitRegion) : HitRegion :=
  let x := region.xAxis
  let y := region.yAxis
  let transformedX := translateAxis matrix.tx <| addAxis (scaleAxis matrix.a x) (scaleAxis matrix.b y)
  let transformedY := translateAxis matrix.ty <| addAxis (scaleAxis matrix.c x) (scaleAxis matrix.d y)
  let result := ofAxes transformedX transformedY
  -- Guard arithmetic is intentionally rounded outwards. This also absorbs the
  -- small reconstruction error when an accepted HitTree stores only an inverse
  -- matrix and spatial mounting recovers its forward transform.
  {
    result with
    left := expandLower result.hasLeft result.left
    right := expandUpper result.hasRight result.right
    bottom := expandLower result.hasBottom result.bottom
    top := expandUpper result.hasTop result.top
  }

end HitRegion

/-- A prepared hit tree augmented with conservative subtree guards. -/
inductive SpatialHitTree where
  /-- Contains no hittable geometry. -/
  | empty
  /-- Contains one prepared primitive. -/
  | primitive (value : HitPrimitive)
  /-- Replaces a successful child result with a numeric tag. -/
  | tag (value : Nat) (child : SpatialHitTree)
  /-- Maps a point into child coordinates with a precomputed inverse transform. -/
  | transform (inverse : Matrix) (child : SpatialHitTree)
  /-- Overlays a front tree over a back tree. -/
  | compose (back front : SpatialHitTree)
  /-- Restricts child hits to a path boundary. -/
  | clip (boundary : PathData) (child : SpatialHitTree)
  /-- Rejects points outside conservative bounds before testing a child subtree. -/
  | guard (region : HitRegion) (child : SpatialHitTree)
deriving Repr, BEq, Inhabited

namespace SpatialHitTree

/-- Tests a spatially prepared hit tree at a point in diagram coordinates. -/
def hitTest (tree : SpatialHitTree) (point : Point) : Click :=
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
  | .guard region child =>
    if region.contains point then hitTest child point else .nothing

end SpatialHitTree

/-- Immutable labels and spatially indexed geometry for repeated point hit tests. -/
structure SpatialHitScene where
  /-- Prepared geometry in rendering order. -/
  tree : SpatialHitTree
  /-- Human-readable labels associated with numeric tags. -/
  labels : Array (Nat × String) := #[]
deriving Repr, BEq, Inhabited

namespace SpatialHitScene

/-- Looks up the human-readable label associated with a tag. -/
def label? (scene : SpatialHitScene) (tag : Nat) : Option String :=
  scene.labels.findSome? fun (value, label) => if value == tag then some label else none

/-- Tests a spatially prepared scene at a point in diagram coordinates. -/
def hitTest (scene : SpatialHitScene) (point : Point) : Click :=
  scene.tree.hitTest point

/-- Tests a spatially prepared scene and returns a browser-facing structured result. -/
def query (scene : SpatialHitScene) (x y : Float) : HitSceneResult :=
  match scene.hitTest (Point.mk x y) with
  | .nothing => .nothing
  | .something => .something
  | .tag value => .tag value (scene.label? value |>.getD "")

private structure PreparedTree where
  tree : SpatialHitTree := .empty
  region? : Option HitRegion := none
deriving Inhabited

private def PreparedTree.guarded (prepared : PreparedTree) : SpatialHitTree :=
  match prepared.region? with
  | none => prepared.tree
  | some region => .guard region prepared.tree

private def primitiveRegion : HitPrimitive → Option HitRegion
  | .bounds left right bottom top => some {
      left
      right
      bottom
      top
      hasLeft := true
      hasRight := true
      hasBottom := true
      hasTop := true
    }
  | .path _ hasFill strokeWidth left right bottom top =>
    if !hasFill && !(strokeWidth > 0) then none
    else some {
      left
      right
      bottom
      top
      hasLeft := !hasFill
      hasRight := true
      hasBottom := true
      hasTop := true
    }

private def combineTrees (back front : PreparedTree) : PreparedTree :=
  let region? := match back.region?, front.region? with
    | none, none => none
    | some region, none | none, some region => some region
    | some backRegion, some frontRegion => some (backRegion.union frontRegion)
  {
    tree := .compose back.guarded front.guarded
    region?
  }

private def collectCompose : HitTree → Array HitTree
  | .compose back front => collectCompose back ++ collectCompose front
  | tree => #[tree]

private partial def combineArray (items : Array PreparedTree) : PreparedTree :=
  if items.isEmpty then {}
  else if items.size == 1 then items[0]!
  else
    let middle := items.size / 2
    combineTrees
      (combineArray (items.extract 0 middle))
      (combineArray (items.extract middle items.size))

private partial def prepareTreeCore : HitTree → PreparedTree
  | .empty => {}
  | .primitive value => { tree := .primitive value, region? := primitiveRegion value }
  | .tag value child =>
    let prepared := prepareTreeCore child
    { prepared with tree := .tag value prepared.tree }
  | .transform inverse child =>
    let prepared := prepareTreeCore child
    let region? := match Matrix.inverse inverse, prepared.region? with
      | some matrix, some region => some (region.transform matrix)
      | _, _ => none
    { tree := .transform inverse prepared.tree, region? }
  | tree@(.compose _ _) => collectCompose tree |>.map prepareTreeCore |> combineArray
  | .clip boundary child =>
    let prepared := prepareTreeCore child
    { prepared with tree := .clip boundary prepared.tree }

/-- Builds a balanced spatial index over an existing prepared hit scene. -/
def ofHitScene (scene : HitScene) : SpatialHitScene :=
  { tree := prepareTreeCore scene.tree |>.guarded, labels := scene.labels }

end SpatialHitScene

namespace Diagram

variable {beta : Type}

/-- Discards rendering data and builds a balanced, conservatively guarded hit tree. -/
def prepareSpatialHitTree (diagram : Diagram beta) : SpatialHitTree :=
  SpatialHitScene.ofHitScene { tree := diagram.prepareHitTree } |>.tree

/-- Builds an immutable spatial hit scene from a diagram and optional tag labels. -/
def prepareSpatialHitScene (diagram : Diagram beta)
    (labels : Array (Nat × String) := #[]) : SpatialHitScene :=
  SpatialHitScene.ofHitScene (diagram.prepareHitScene labels)
