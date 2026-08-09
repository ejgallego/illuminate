/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
module
public import Illuminate.Animation.Types
public section

namespace Illuminate
namespace AnimationPlayer

/-- An input handled by the pure animation player. -/
inductive PlayerEvent where
  /-- Advances, pauses, resumes, or requests exit from the current loop. -/
  | advance
  /-- Pauses playback at the currently displayed frame. -/
  | pause
  /-- Seeks directly to a frame. -/
  | seek (frame : Nat)
  /-- Plays directly toward a frame, optionally entering its loop afterward. -/
  | playTo (frame : Nat) (loopAfter : Bool := false)
  /-- Starts the looping step containing a frame. -/
  | loopAt (frame : Nat)
  /-- Advances playback using a browser animation-frame timestamp in milliseconds. -/
  | tick (timestamp : Float)
deriving Repr, BEq, Inhabited

/-- The externally visible playback status. -/
inductive PlaybackStatus where
  /-- Playback is stopped before the end of the animation. -/
  | paused
  /-- Playback is progressing through an ordinary step. -/
  | playing
  /-- Playback is waiting at an interaction pause. -/
  | waiting
  /-- Playback is repeating the current looping step. -/
  | looping
  /-- Playback is completing the current loop before advancing. -/
  | finishingLoop
  /-- Playback reached the final frame. -/
  | finished
deriving Repr, BEq, Inhabited

/-- Returns whether a playback status needs another animation-frame callback. -/
def PlaybackStatus.isActive : PlaybackStatus → Bool
  | .playing | .looping | .finishingLoop => true
  | .paused | .waiting | .finished => false

/-- Identifies the property changed by an SVG patch. -/
inductive PatchTarget where
  /-- Replaces an element's text content. -/
  | textContent
  /-- Sets the named SVG attribute. -/
  | attribute (name : String)
deriving Repr, BEq, Inhabited

/-- A normalized parameter binding consumed by the pure player. -/
structure PlayerParamBinding where
  /-- Index of the SVG element patched by the binding. -/
  element : Nat
  /-- Preclassified text or attribute destination. -/
  target : PatchTarget
deriving Repr, BEq, Inhabited

/-- SVG-free parameter data for one structurally stable animation segment. -/
structure PlayerSegment where
  /-- Index of the first frame in the segment. -/
  startFrame : Nat
  /-- Number of frames in the segment. -/
  frameCount : Nat
  /-- Normalized parameter bindings shared by all frames in the segment. -/
  paramMap : Array PlayerParamBinding
  /-- Per-frame serialized parameter values. -/
  params : Array (Array String)
deriving Repr, Inhabited

/-- Validated, rendering-host-independent input for the pure animation player. -/
structure PlayerAnimation where
  /-- Frames per second used to convert browser timestamps to frames. -/
  fps : Nat
  /-- Number of frames in the complete animation. -/
  totalFrames : Nat
  /-- Prepared segments without synchronization SVG documents. -/
  segments : Array PlayerSegment
  /-- Validated step boundary metadata. -/
  steps : Array StepInfo
deriving Repr, Inhabited

/-- A single SVG element update selected for a rendered frame. -/
structure AttributeUpdate where
  /-- Value of the target element's {lit}`data-e` index. -/
  element : Nat
  /-- Text or attribute destination for the update. -/
  target : PatchTarget
  /-- New serialized property value. -/
  value : String
deriving Repr, BEq, Inhabited

/-- Mutable state threaded through the pure animation player. -/
structure PlayerState where
  /-- Most recently displayed frame. -/
  frame : Nat := 0
  /-- Step containing the most recently displayed frame. -/
  step : Nat := 0
  /-- Browser timestamp used as the current playback timing anchor. -/
  startTime : Option Float := none
  /-- Frame added to elapsed time when playback resumes. -/
  pauseFrame : Nat := 0
  /-- Current playback status. -/
  playback : PlaybackStatus := .paused
  /-- Whether interaction requested exit at the next loop boundary. -/
  loopExitPending : Bool := false
  /-- Explicit frame target used by Reveal-style directed playback. -/
  targetFrame : Option Nat := none
  /-- Whether directed playback enters the target step's loop after arrival. -/
  loopAfterTarget : Bool := false
  /-- Segment installed by the preceding frame action. -/
  renderedSegment : Option Nat := none
deriving Repr, BEq, Inhabited

/-- Rendering and scheduling decisions produced by one player transition. -/
structure FrameAction where
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
  /-- Text and attribute updates for the selected local frame. -/
  updates : Array AttributeUpdate
  /-- Playback status after the transition. -/
  playback : PlaybackStatus
deriving Repr, BEq, Inhabited

/-- Result of applying a player event. -/
structure Transition where
  /-- State used for the next event. -/
  state : PlayerState
  /-- Rendering and scheduling decisions for the current event. -/
  action : FrameAction
deriving Repr, BEq, Inhabited

/-- Clamps a frame to a nonempty animation's valid range. -/
def clampFrame (totalFrames frame : Nat) : Nat :=
  if totalFrames == 0 then 0 else min frame (totalFrames - 1)

/-- Returns the segment containing a frame, falling back to the final segment. -/
def findSegment (segments : Array Segment) (frame : Nat) : Nat :=
  match segments.findIdx? fun segment =>
      frame >= segment.startFrame && frame < segment.startFrame + segment.frameCount with
  | some index => index
  | none => segments.size - 1

private def containsFrame (segment : PlayerSegment) (frame : Nat) : Bool :=
  frame >= segment.startFrame && frame < segment.startFrame + segment.frameCount

private def findPlayerSegment (segments : Array PlayerSegment) (frame : Nat) : Nat :=
  match segments.findIdx? fun segment => containsFrame segment frame with
  | some index => index
  | none => segments.size - 1

private def selectPlayerSegment
    (animation : PlayerAnimation)
    (state : PlayerState)
    (frame : Nat) : Nat :=
  match state.renderedSegment with
  | some index =>
    match animation.segments[index]? with
    | some segment => if containsFrame segment frame then index else
        findPlayerSegment animation.segments frame
    | none => findPlayerSegment animation.segments frame
  | none => findPlayerSegment animation.segments frame

/-- Returns the step active at a frame. -/
def findCurrentStep (steps : Array StepInfo) (frame : Nat) : Nat := Id.run do
  let mut low := 0
  let mut high := steps.size
  while low < high do
    let middle := low + (high - low) / 2
    if frame >= steps[middle]!.frame then
      low := middle + 1
    else
      high := middle
  return if low == 0 then 0 else low - 1

private def findCurrentStepFrom
    (steps : Array StepInfo)
    (current frame : Nat) : Nat := Id.run do
  if steps.isEmpty then return 0
  let mut index := min current (steps.size - 1)
  while index > 0 && frame < steps[index]!.frame do
    index := index - 1
  while index + 1 < steps.size && frame >= steps[index + 1]!.frame do
    index := index + 1
  return index

/-- Returns the exclusive end frame of a step. -/
def findStepEnd (steps : Array StepInfo) (step totalFrames : Nat) : Nat :=
  match steps[step + 1]? with
  | some next => next.frame
  | none => totalFrames

/-- Result of wrapping a frame through a looping step. -/
structure LoopResult where
  /-- Frame after loop wrapping. -/
  wrapped : Nat
  /-- Whether the frame crossed at least one cycle boundary. -/
  didCycle : Bool
deriving Repr, BEq, Inhabited

/-- Wraps a frame into a looping step and records whether it crossed a cycle boundary. -/
def wrapLoop (frame stepStart stepEnd : Nat) : LoopResult :=
  let stepLength := stepEnd - stepStart
  if stepLength == 0 || frame < stepEnd then
    { wrapped := frame, didCycle := false }
  else
    { wrapped := stepStart + (frame - stepStart) % stepLength, didCycle := true }

private def findCrossedPauseTo
    (steps : Array StepInfo)
    (currentStep target : Nat) : Option Nat :=
  if target <= currentStep then
    none
  else
    Id.run do
      for index in [currentStep + 1:target + 1] do
        if (steps[index]?.map (·.pause)).getD false then
          return some index
      return none

/-- Returns the first interaction pause crossed after the current step. -/
def findCrossedPause (steps : Array StepInfo) (currentStep frame : Nat) : Option Nat :=
  findCrossedPauseTo steps currentStep (findCurrentStep steps frame)

/-- Converts elapsed animation time to a frame using JavaScript-compatible positive rounding. -/
def elapsedFrame (startTime timestamp : Float) (fps pauseFrame : Nat) : Nat :=
  let elapsedFrames := ((timestamp - startTime) / 1000.0) * fps.toFloat
  if elapsedFrames <= 0 then pauseFrame
  else pauseFrame + elapsedFrames.round.toUInt64.toNat

private def normalizeTarget (name : String) : PatchTarget :=
  if name == "textContent" then .textContent else .attribute name

/-- Checks the invariants required by the prepared transition path. -/
def validatePrepared (animation : PlayerAnimation) : Except String Unit := do
  if animation.fps == 0 then
    throw "animation fps must be positive"
  if animation.totalFrames == 0 then
    throw "animation must contain at least one frame"
  if animation.segments.isEmpty then
    throw "animation must contain at least one segment"
  let mut expectedStart := 0
  for segment in animation.segments do
    if segment.startFrame != expectedStart then
      throw "animation segments must be contiguous from frame zero"
    if segment.frameCount == 0 then
      throw "animation segments must contain at least one frame"
    if segment.params.size != segment.frameCount then
      throw "animation segment parameter-frame count is inconsistent"
    for values in segment.params do
      if values.size != segment.paramMap.size then
        throw "animation segment parameter values are inconsistent"
    expectedStart := expectedStart + segment.frameCount
  if expectedStart != animation.totalFrames then
    throw "animation segments must cover every frame"
  let mut previousStep := 0
  let mut stepIndex := 0
  for step in animation.steps do
    if step.frame >= animation.totalFrames then
      throw "animation steps must start within the animation"
    if stepIndex > 0 && step.frame < previousStep then
      throw "animation steps must be ordered"
    previousStep := step.frame
    stepIndex := stepIndex + 1
  pure ()

/--
Validates and projects compiled browser animation data into the pure player's input format.

The projection drops synchronization SVG documents and classifies patch targets once. It also
checks the segment and parameter invariants used by the allocation-conscious transition path.
-/
def prepare (animation : CompiledAnimation) : Except String PlayerAnimation := do
  let prepared : PlayerAnimation := {
    fps := animation.fps
    totalFrames := animation.totalFrames
    segments := animation.segments.map fun segment => {
      startFrame := segment.startFrame
      frameCount := segment.frameCount
      paramMap := segment.paramMap.map fun binding => {
        element := binding.elemIdx
        target := normalizeTarget binding.attr
      }
      params := segment.params
    }
    steps := animation.steps
  }
  validatePrepared prepared
  pure prepared

private def parameterUpdates
    (segment : PlayerSegment)
    (localFrame : Nat) : Array AttributeUpdate := Id.run do
  let some values := segment.params[localFrame]? | return #[]
  let count := segment.paramMap.size
  let mut updates := Array.mkEmpty count
  for index in [:count] do
    let binding := segment.paramMap[index]!
    let value := values[index]!
    updates := updates.push { element := binding.element, target := binding.target, value }
  return updates

private def actionAt
    (animation : PlayerAnimation)
    (state : PlayerState)
    (frame : Nat) : Transition :=
  let frame := clampFrame animation.totalFrames frame
  let segmentIndex := selectPlayerSegment animation state frame
  let segment := animation.segments[segmentIndex]!
  let localFrame := frame - segment.startFrame
  let segmentChanged := state.renderedSegment != some segmentIndex
  let state := { state with frame, renderedSegment := some segmentIndex }
  { state
    action := {
      frame
      step := state.step
      segment := segmentIndex
      localFrame
      segmentChanged
      updates := parameterUpdates segment localFrame
      playback := state.playback
    } }

/-- Initializes a prepared animation and selects its first frame without revalidation. -/
def initialPrepared (animation : PlayerAnimation) : Transition :=
  let state : PlayerState := { step := findCurrentStep animation.steps 0 }
  actionAt animation state 0

/-- Validates a compiled animation and selects its first frame. -/
def initialTransition (animation : CompiledAnimation) : Except String Transition := do
  pure (initialPrepared (← prepare animation))

private def statusForPlaying (animation : PlayerAnimation) (state : PlayerState) : PlaybackStatus :=
  if state.loopExitPending then
    .finishingLoop
  else if (animation.steps[state.step]?.map (·.loop)).getD false then
    .looping
  else
    .playing

private def advance (animation : PlayerAnimation) (state : PlayerState) : PlayerState :=
  match state.playback with
  | .waiting =>
    let resumed := {
      state with
      startTime := none
      loopExitPending := false
      targetFrame := none
      loopAfterTarget := false
    }
    { resumed with playback := statusForPlaying animation resumed }
  | .playing | .looping | .finishingLoop =>
    let looping := (animation.steps[state.step]?.map (·.loop)).getD false
    if looping && state.step + 1 < animation.steps.size then
      { state with playback := .finishingLoop, loopExitPending := true }
    else
      {
        state with
        playback := .paused
        startTime := none
        pauseFrame := state.frame
        loopExitPending := false
        targetFrame := none
        loopAfterTarget := false
      }
  | .paused | .finished =>
    let replay := state.pauseFrame >= animation.totalFrames - 1
    let started := {
      state with
      frame := if replay then 0 else state.frame
      step := if replay then 0 else state.step
      startTime := none
      pauseFrame := if replay then 0 else state.pauseFrame
      loopExitPending := false
      targetFrame := none
      loopAfterTarget := false
    }
    { started with playback := statusForPlaying animation started }

private def pause (state : PlayerState) : PlayerState :=
  {
    state with
    startTime := none
    pauseFrame := state.frame
    playback := .paused
    loopExitPending := false
    targetFrame := none
    loopAfterTarget := false
  }

private def seek (animation : PlayerAnimation) (state : PlayerState) (requested : Nat) : PlayerState :=
  let frame := clampFrame animation.totalFrames requested
  { state with
    frame
    step := findCurrentStep animation.steps frame
    pauseFrame := frame
    playback := if frame == animation.totalFrames - 1 then .finished else .paused
    loopExitPending := false
    targetFrame := none
    loopAfterTarget := false
  }

private def loopAt (animation : PlayerAnimation) (state : PlayerState) (requested : Nat) : PlayerState :=
  let frame := clampFrame animation.totalFrames requested
  let step := findCurrentStep animation.steps frame
  match animation.steps[step]? with
  | some info =>
    if info.loop then
      {
        state with
        frame := info.frame
        step
        startTime := none
        pauseFrame := info.frame
        playback := .looping
        loopExitPending := false
        targetFrame := none
        loopAfterTarget := false
      }
    else
      seek animation state frame
  | none => seek animation state frame

private def playTo
    (animation : PlayerAnimation)
    (state : PlayerState)
    (requested : Nat)
    (loopAfter : Bool) : PlayerState :=
  let target := clampFrame animation.totalFrames requested
  if target == state.frame then
    if loopAfter then loopAt animation state target else pause state
  else
    {
      state with
      step := findCurrentStepFrom animation.steps state.step state.frame
      startTime := none
      pauseFrame := state.frame
      playback := .playing
      loopExitPending := false
      targetFrame := some target
      loopAfterTarget := loopAfter
    }

private def tickTowardTarget
    (animation : PlayerAnimation)
    (state : PlayerState)
    (target : Nat)
    (timestamp : Float) : PlayerState :=
  let startTime := state.startTime.getD timestamp
  let elapsed := elapsedFrame startTime timestamp animation.fps 0
  let frame := if target >= state.pauseFrame then
    min target (state.pauseFrame + elapsed)
  else
    state.pauseFrame - min elapsed (state.pauseFrame - target)
  let step := findCurrentStepFrom animation.steps state.step frame
  if frame == target then
    let arrived := {
      state with
      frame
      step
      startTime := none
      pauseFrame := frame
      playback := .paused
      loopExitPending := false
      targetFrame := none
      loopAfterTarget := false
    }
    if state.loopAfterTarget then loopAt animation arrived frame else arrived
  else
    {
      state with
      frame
      step
      startTime := some startTime
      playback := .playing
    }

private def tick (animation : PlayerAnimation) (state : PlayerState) (timestamp : Float) : PlayerState := Id.run do
  if !state.playback.isActive then
    return state
  if let some target := state.targetFrame then
    return tickTowardTarget animation state target timestamp
  else
    let startTime := state.startTime.getD timestamp
    let mut next := { state with startTime := some startTime }
    let mut frame := elapsedFrame startTime timestamp animation.fps state.pauseFrame
    let mut wasLooping := (animation.steps[state.step]?.map (·.loop)).getD false
    if wasLooping then
      let stepStart := (animation.steps[state.step]!).frame
      let stepEnd := findStepEnd animation.steps state.step animation.totalFrames
      let loop := wrapLoop frame stepStart stepEnd
      if loop.didCycle then
        if state.loopExitPending && state.step + 1 < animation.steps.size then
          let followingStep := state.step + 1
          let followingFrame := (animation.steps[followingStep]!).frame
          next := {
            next with
            step := followingStep
            startTime := none
            pauseFrame := followingFrame
            loopExitPending := false
          }
          frame := followingFrame
          wasLooping := false
        else
          next := { next with startTime := some timestamp, pauseFrame := stepStart }
          frame := loop.wrapped
    let mut reachedEnd := false
    if frame >= animation.totalFrames then
      let finalFrame := animation.totalFrames - 1
      frame := finalFrame
      next := { next with
        frame := finalFrame
        pauseFrame := finalFrame
        playback := .finished
        loopExitPending := false
        targetFrame := none
        loopAfterTarget := false
      }
      reachedEnd := true
    if !wasLooping then
      let targetStep := findCurrentStepFrom animation.steps next.step frame
      match findCrossedPauseTo animation.steps next.step targetStep with
      | some pauseStep =>
        let pauseFrame := (animation.steps[pauseStep]!).frame
        return { next with
          frame := pauseFrame
          step := pauseStep
          pauseFrame
          playback := .waiting
          loopExitPending := false
          targetFrame := none
          loopAfterTarget := false
        }
      | none =>
        let progressed := { next with frame, step := targetStep }
        if reachedEnd then
          return progressed
        else
          return { progressed with playback := statusForPlaying animation progressed }
    else if reachedEnd then
      return next
    else
      let progressed := { next with frame }
      return { progressed with playback := statusForPlaying animation progressed }

/-- Applies one event to prepared input without revalidation. -/
def transitionPrepared
    (animation : PlayerAnimation)
    (state : PlayerState)
    (event : PlayerEvent) : Transition :=
  let next := match event with
    | .advance => advance animation state
    | .pause => pause state
    | .seek frame => seek animation state frame
    | .playTo frame loopAfter => playTo animation state frame loopAfter
    | .loopAt frame => loopAt animation state frame
    | .tick timestamp => tick animation state timestamp
  actionAt animation next next.frame

/-- Validates compiled input, applies one event, and returns the next player transition. -/
def transition
    (animation : CompiledAnimation)
    (state : PlayerState)
    (event : PlayerEvent) : Except String Transition := do
  pure (transitionPrepared (← prepare animation) state event)

/--
Validates SVG-free player input once and replays a complete event trace.

The result contains the initial action followed by one action per event. This entry is intended for
native compilation and differential tests whose adapter can construct {name}`PlayerAnimation`
directly.
-/
def replayTrace
    (animation : PlayerAnimation)
    (events : List PlayerEvent) : Except String (Array FrameAction) := do
  validatePrepared animation
  let initial := initialPrepared animation
  let mut state := initial.state
  let mut actions := Array.mkEmpty (events.length + 1)
  actions := actions.push initial.action
  for event in events do
    let next := transitionPrepared animation state event
    state := next.state
    actions := actions.push next.action
  pure actions
