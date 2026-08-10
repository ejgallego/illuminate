/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
import Illuminate.Diagram.HitScene.Vir

namespace Illuminate.HitScene.VirMemoryProbe

open Lean.Vir

/-- Lean-owned immutable hit scene retained behind an opaque JavaScript resource. -/
abbrev Handle := JSL HitScene

/-- Lean-owned path data retained behind an opaque JavaScript resource. -/
abbrev PathHandle := JSL PathData

private def treeNodeCount : HitTree → Nat
  | .empty | .primitive _ => 1
  | .tag _ child | .transform _ child | .clip _ child => treeNodeCount child + 1
  | .compose back front => treeNodeCount back + treeNodeCount front + 1

/-- Retains one scene for the lifetime of a memory-probe run. -/
@[vir_export]
def mount (scene : HitScene) : RuntimeM Handle :=
  LeanRef.toJSL scene

/-- Retains one path for the lifetime of a memory-probe run. -/
@[vir_export]
def mountPath (path : PathData) : RuntimeM PathHandle :=
  LeanRef.toJSL path

/-- Borrows and immediately drops a retained scene without inspecting it. -/
@[vir_export]
def borrowOnly (handle : Handle) : RuntimeM HitSceneResult := do
  let _scene ← LeanRef.fromJSL handle
  pure .nothing

/-- Reads a scalar field after borrowing a retained scene. -/
@[vir_export]
def labelCount (handle : Handle) : RuntimeM Nat := do
  let scene ← LeanRef.fromJSL handle
  pure scene.labels.size

/-- Traverses only the retained tree structure and counts its nodes. -/
@[vir_export]
def nodeCount (handle : Handle) : RuntimeM Nat := do
  let scene ← LeanRef.fromJSL handle
  pure (treeNodeCount scene.tree)

/-- Runs the hit-tree traversal without looking up or returning labels. -/
@[vir_export]
def hitOnly (handle : Handle) (x y : Float) : RuntimeM HitSceneResult := do
  let scene ← LeanRef.fromJSL handle
  pure <| match scene.hitTest (Point.mk x y) with
    | .nothing => .nothing
    | .something => .something
    | .tag value => .tag value ""

/-- Looks up one label without traversing the hit tree. -/
@[vir_export]
def labelOnly (handle : Handle) (value : Nat) : RuntimeM HitSceneResult := do
  let scene ← LeanRef.fromJSL handle
  pure (.tag value (scene.label? value |>.getD ""))

/-- Runs the production query through the probe package for direct comparison. -/
@[vir_export]
def fullQuery (handle : Handle) (x y : Float) : RuntimeM HitSceneResult := do
  let scene ← LeanRef.fromJSL handle
  pure (scene.query x y)

/-- Hit-tests a fixed bounds primitive without a retained scene. -/
@[vir_export]
def fixedBounds (x y : Float) : RuntimeM HitSceneResult :=
  pure <| match (HitPrimitive.bounds x x y y).hitTest (Point.mk x y) with
    | .nothing => .nothing
    | .something => .something
    | .tag value => .tag value ""

/-- Maps a one-element Float array and consumes only its size. -/
@[vir_export]
def mapFloatArray (x y : Float) : RuntimeM Nat :=
  pure (#[x].map (fun value => value + y) |>.size)

/-- Maps a one-element {name}`StrokeHit` array and consumes only its size. -/
@[vir_export]
def mapStrokeHitArray (x y : Float) : RuntimeM Nat := do
  let hits : Array StrokeHit := #[{ edge := x, width := y }]
  pure (hits.map (fun hit =>
    ({ edge := hit.edge + y, width := hit.width + x } : StrokeHit)) |>.size)

/-- Tests only point-in-path fill geometry on one retained path. -/
@[vir_export]
def pathFill (handle : PathHandle) (x y : Float) : RuntimeM HitSceneResult := do
  let path ← LeanRef.fromJSL handle
  pure <| match (HitPrimitive.path path true 0).hitTest (Point.mk x y) with
    | .nothing => .nothing
    | .something => .something
    | .tag value => .tag value ""

/-- Runs one eastward fill-trace query and returns its hit count. -/
@[vir_export]
def pathFillEast (handle : PathHandle) (x y : Float) : RuntimeM Nat := do
  let path ← LeanRef.fromJSL handle
  pure ((Trace.ofPathData path.commands).query (Point.mk x y) Vec2.east).size

/-- Returns one eastward fill-trace result array across the VIR boundary. -/
@[vir_export]
def pathFillEastResults (handle : PathHandle) (x y : Float) : RuntimeM (Array Float) := do
  let path ← LeanRef.fromJSL handle
  pure ((Trace.ofPathData path.commands).query (Point.mk x y) Vec2.east)

/-- Tests only stroke geometry on one retained path. -/
@[vir_export]
def pathStroke (handle : PathHandle) (x y : Float) : RuntimeM HitSceneResult := do
  let path ← LeanRef.fromJSL handle
  pure <| match (HitPrimitive.path path false 1).hitTest (Point.mk x y) with
    | .nothing => .nothing
    | .something => .something
    | .tag value => .tag value ""

/-- Runs one eastward stroke-trace query and returns its hit count. -/
@[vir_export]
def pathStrokeEast (handle : PathHandle) (x y : Float) : RuntimeM Nat := do
  let path ← LeanRef.fromJSL handle
  pure ((StrokeTrace.ofPathData path.commands 1).query (Point.mk x y) Vec2.east).size

/-- Returns one eastward stroke-trace result array across the VIR boundary. -/
@[vir_export]
def pathStrokeEastResults (handle : PathHandle) (x y : Float) : RuntimeM (Array StrokeHit) := do
  let path ← LeanRef.fromJSL handle
  pure ((StrokeTrace.ofPathData path.commands 1).query (Point.mk x y) Vec2.east)

/-- Releases the retained path used by a memory-probe run. -/
@[vir_export]
def disposePath (handle : PathHandle) : RuntimeM Unit :=
  LeanRef.releaseJSL handle

/-- Releases the retained scene used by a memory-probe run. -/
@[vir_export]
def dispose (handle : Handle) : RuntimeM Unit :=
  LeanRef.releaseJSL handle
