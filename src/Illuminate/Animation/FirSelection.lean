/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
module
public import Illuminate.Animation.Player
public section

namespace Illuminate.AnimationPlayer

/-- A player input whose segment patch tables remain owned by the browser host. -/
structure SelectionAnimation where
  /-- Prepared player data containing only timing, segment bounds, and steps. -/
  timeline : PlayerAnimation
deriving Repr, Inhabited

/-- Rendering-independent decisions selected by one player transition. -/
structure FrameSelection where
  /-- Frame selected for display. -/
  frame : Nat
  /-- Step containing the selected frame. -/
  step : Nat
  /-- Segment containing the selected frame. -/
  segment : Nat
  /-- Frame offset within the selected segment. -/
  localFrame : Nat
  /-- Whether the host must install the segment's synchronization SVG. -/
  segmentChanged : Bool
  /-- Playback status after the transition. -/
  playback : PlaybackStatus
deriving Repr, BEq, Inhabited

/-- A persistent browser transition that leaves SVG patch values in host memory. -/
structure LiveSelectionTransition where
  /-- State retained by the native player for the next event. -/
  state : PlayerState
  /-- Frame and playback decisions copied to the browser host. -/
  selection : FrameSelection
  /-- Whether the browser host should request another animation frame. -/
  scheduleNextFrame : Bool
deriving Repr, BEq, Inhabited

/-- Drops parameter bindings and values from a validated player animation. -/
def SelectionAnimation.ofPlayerAnimation (animation : PlayerAnimation) : SelectionAnimation :=
  { timeline := {
      animation with
      segments := animation.segments.map fun (segment : PlayerSegment) => {
        segment with
        paramMap := #[]
        params := #[]
      }
    } }

/-- Projects a full frame action to the decisions needed to select a host-owned patch row. -/
def FrameAction.toSelection (action : FrameAction) : FrameSelection :=
  { frame := action.frame
    step := action.step
    segment := action.segment
    localFrame := action.localFrame
    segmentChanged := action.segmentChanged
    playback := action.playback }

private def validationView (animation : PlayerAnimation) : PlayerAnimation :=
  { animation with
    segments := animation.segments.map fun (segment : PlayerSegment) => {
      segment with
      params := Array.replicate segment.frameCount #[]
    } }

/-- Checks timeline invariants and verifies that no SVG patch table crossed the native boundary. -/
def validateSelectionAnimation (animation : SelectionAnimation) : Except String Unit := do
  for segment in animation.timeline.segments do
    if !segment.paramMap.isEmpty || !segment.params.isEmpty then
      throw "selection animation segments must not contain SVG patch tables"
  validatePrepared (validationView animation.timeline)

private def toLiveSelectionTransition (transition : Transition) : LiveSelectionTransition :=
  { state := transition.state
    selection := transition.action.toSelection
    scheduleNextFrame := transition.action.playback.isActive }

/-- Validates compact input and initializes a persistent native selection player. -/
def initialSelectionLive
    (animation : SelectionAnimation) : Except String LiveSelectionTransition := do
  validateSelectionAnimation animation
  pure (toLiveSelectionTransition (initialPrepared animation.timeline))

/-- Applies one event without revalidating or transferring the host-owned SVG patch table. -/
def transitionSelectionLive
    (animation : SelectionAnimation)
    (state : PlayerState)
    (event : PlayerEvent) : LiveSelectionTransition :=
  toLiveSelectionTransition (transitionPrepared animation.timeline state event)
