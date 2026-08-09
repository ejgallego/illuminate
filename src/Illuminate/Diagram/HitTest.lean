/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: David Thrane Christiansen
-/
module
import Lean.DocString.Syntax
public import Illuminate.Diagram.Types
import Illuminate.Diagram.Placement
import Illuminate.Style.Text
public section


namespace Illuminate



namespace Click

/-- Returns {lean}`true` if the click hit something (either tagged or untagged). -/
def isHit : Click → Bool
  | .nothing => false
  | .something => true
  | .tag _ => true

instance : ToString Click where
  toString
    | .nothing => "nothing"
    | .something => "something"
    | .tag n => s!"tag {n}"

end Click

/-!
# Point-in-path (ray casting)
-/

namespace PathData

/--
Tests whether a point lies inside a closed path using the ray-casting algorithm.
Casts a horizontal ray to the right from {name}`p` and counts boundary crossings;
an odd count means the point is inside.
-/
def contains (pd : PathData) (p : Point) : Bool :=
  let hits := (Trace.ofPathData pd.commands).query p Vec2.east
  hits.size % 2 == 1

end PathData

/-!
# Point-on-stroke check
-/

/--
Tests whether a point lies within the stroke band of a path.
Casts rays in several directions from the point; if any ray's closest
stroke hit has $`edge ≤ 0`, the point is inside the stroke band.
-/
private def pointOnStroke (pd : PathData) (strokeWidth : Float) (p : Point) : Bool :=
  if strokeWidth <= 0 then false
  else
    let st := StrokeTrace.ofPathData pd.commands strokeWidth
    let dirs : List Vec2 := [Vec2.east, Vec2.north, Vec2.west, Vec2.south,
      (Vec2.mk 1 1).normalize, (Vec2.mk 1 (-1)).normalize,
      (Vec2.mk (-1) 1).normalize, (Vec2.mk (-1) (-1)).normalize]
    dirs.any fun dir =>
      match st.closest p dir with
      | some hit => hit.edge <= 0
      | none => false

/-!
# Prepared primitives
-/

/-- Geometry retained from one primitive for browser-resident hit testing. -/
inductive HitPrimitive where
  /-- Tests a path's fill and visible stroke. -/
  | path (data : PathData) (hasFill : Bool) (strokeWidth : Float)
  /-- Tests an axis-aligned primitive bound. -/
  | bounds (left right bottom top : Float)
deriving Repr, BEq, Inhabited

namespace HitPrimitive

/-- Tests prepared primitive geometry at a point in the primitive's local coordinates. -/
def hitTest (primitive : HitPrimitive) (p : Point) : Click :=
  match primitive with
  | .path data hasFill strokeWidth =>
    let fillHit := hasFill && data.contains p
    let strokeHit := pointOnStroke data strokeWidth p
    if fillHit || strokeHit then .something else .nothing
  | .bounds left right bottom top =>
    if p.x >= left && p.x <= right && p.y >= bottom && p.y <= top then .something
    else .nothing

end HitPrimitive

namespace CorePrimitive

/-- Discards rendering-only data and prepares a primitive for repeated hit tests. -/
def prepareHit : CorePrimitive → HitPrimitive
  | .path data fill stroke =>
    let hasFill := match fill with
      | .none => false
      | _ => true
    let strokeWidth :=
      if stroke.width > 0 && stroke.color.a > 0 then stroke.width else 0
    .path data hasFill strokeWidth
  | .text contents style =>
    let fontSize := style.fontSize
    let lines := contents.splitOn "\n"
    let lineCount := Max.max 1 lines.length
    let width := lines.foldl (fun acc line => Max.max acc (estimateTextWidth fontSize line)) 0
    let halfHeight :=
      if lineCount == 1 then fontSize / 2
      else fontSize * 1.2 * lineCount.toFloat / 2
    let (left, right) : Float × Float := match style.anchor with
      | .start => (0, width)
      | .«end» => (-width, 0)
      | .middle => (-width / 2, width / 2)
    .bounds left right (-halfHeight) halfHeight
  | .styledText lines anchor =>
    let (halfWidth, halfHeight) := styledTextTraceDims lines
    let (left, right) : Float × Float := match anchor with
      | .start => (0, halfWidth * 2)
      | .«end» => (-(halfWidth * 2), 0)
      | .middle => (-halfWidth, halfWidth)
    .bounds left right (-halfHeight) halfHeight
  | .image ref =>
    let halfWidth := ref.width / 2
    let halfHeight := ref.height / 2
    .bounds (-halfWidth) halfWidth (-halfHeight) halfHeight

end CorePrimitive

namespace Diagram

variable {β : Type} [Backend β]

/--
Hit-tests a diagram at the given point, returning the topmost hit.

{given -show}`β`

Respects front-to-back ordering: given diagrams {given}`a, b : Diagram β`, in
{lean}`Diagram.compose a b`, {name}`b` (drawn on top) is
tested first. A {name}`ResolvedFill.solid` interior is hittable even if transparent. A
{name}`ResolvedFill.none` interior is not hittable — only its stroke boundary is.
Clicking within the border stroke of a shape counts as clicking the shape.
-/
def hitTest (d : Diagram β) (p : Point) : Click :=
  match d with
  | .empty => .nothing
  | .prim primitive => primitive.prepareHit.hitTest p
  | .foreign _ d => hitTest d p
  | .tag n d =>
    if (hitTest d p).isHit then .tag n else .nothing
  | .named _ d => hitTest d p
  | .transform m d =>
    match Matrix.inverse m with
    | none => .nothing
    | some mInv => hitTest d (Matrix.applyPoint mInv p)
  | .compose a b =>
    let bHit := hitTest b p
    if bHit.isHit then bHit else hitTest a p
  | .withEnv _ d => hitTest d p
  | .warning _ d => hitTest d p
  | .cellophane _ d => hitTest d p
  | .clip pd d =>
    if pd.contains p then hitTest d p else .nothing
  | .arrow _ _ _ _ d => hitTest d p
  | .scope d => hitTest d p
  | .showEnv _ _ _ d => hitTest d p
