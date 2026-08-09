/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: David Thrane Christiansen
-/
module
public import Illuminate.Animation.Player
public section

namespace Illuminate.AnimationPlayer

/-- A transition result tailored to a persistent browser player. -/
structure LiveTransition where
  /-- State retained by the native player for the next event. -/
  state : PlayerState
  /-- Rendering decisions copied to the browser host. -/
  action : FrameAction
  /-- Whether the browser host should request another animation frame. -/
  scheduleNextFrame : Bool
deriving Repr, BEq, Inhabited

private def toLiveTransition (transition : Transition) : LiveTransition :=
  { state := transition.state
    action := transition.action
    scheduleNextFrame := transition.action.playback.isActive }

/-- Validates prepared input and initializes a persistent native player. -/
def initialLive (animation : PlayerAnimation) : Except String LiveTransition := do
  validatePrepared animation
  pure (toLiveTransition (initialPrepared animation))

/-- Applies one event to a persistent native player without revalidating its animation. -/
def transitionLive
    (animation : PlayerAnimation)
    (state : PlayerState)
    (event : PlayerEvent) : LiveTransition :=
  toLiveTransition (transitionPrepared animation state event)
