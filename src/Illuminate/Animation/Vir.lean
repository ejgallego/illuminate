/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
import Illuminate.Animation.FirSelection
import Illuminate.Animation.Render
import Vir.Attributes
import Vir.Browser

namespace Illuminate.Animation.Vir

open Illuminate.AnimationPlayer
open Lean
open Lean.Vir
open Lean.Vir.Browser

private def jsonField {α : Type} [FromJson α]
    (json : Json) (name : String) : Except String α := do
  FromJson.fromJson? (← json.getObjVal? name)

private instance : FromJson ParamBinding where
  fromJson? json := do
    pure {
      elemIdx := ← jsonField json "e"
      attr := ← jsonField json "a"
    }

private instance : FromJson Segment where
  fromJson? json := do
    pure {
      startFrame := ← jsonField json "sf"
      frameCount := ← jsonField json "fc"
      syncFrame := ← jsonField json "sync"
      paramMap := ← jsonField json "pmap"
      params := ← jsonField json "params"
    }

private instance : FromJson StepInfo where
  fromJson? json := do
    pure {
      frame := ← jsonField json "frame"
      pause := ← jsonField json "pause"
      loop := ← jsonField json "loop"
    }

private instance : FromJson CompiledAnimation where
  fromJson? json := do
    pure {
      fps := ← jsonField json "fps"
      totalFrames := ← jsonField json "totalFrames"
      segments := ← jsonField json "segments"
      steps := ← jsonField json "steps"
    }

private def parseAnimation (source : String) : Except String CompiledAnimation := do
  FromJson.fromJson? (← Json.parse source)

private def parsePlayerEvent (json : Json) : Except String PlayerEvent := do
  let kind : String ← jsonField json "kind"
  match kind with
  | "advance" => pure .advance
  | "pause" => pure .pause
  | "seek" => pure (.seek (← jsonField json "frame"))
  | "playTo" => pure (.playTo (← jsonField json "frame") (← jsonField json "loopAfter"))
  | "loopAt" => pure (.loopAt (← jsonField json "frame"))
  | "tick" => pure (.tick (← jsonField json "timestamp"))
  | other => throw s!"unknown player event: {other}"

private def parsePlayerEvents (source : String) : Except String (Array PlayerEvent) := do
  let values : Array Json ← FromJson.fromJson? (← Json.parse source)
  values.mapM parsePlayerEvent

private def playbackName : PlaybackStatus → String
  | .paused => "paused"
  | .playing => "playing"
  | .waiting => "waiting"
  | .looping => "looping"
  | .finishingLoop => "finishingLoop"
  | .finished => "finished"

private def updateToJson (update : AttributeUpdate) : Json :=
  let target := match update.target with
    | .textContent => "textContent"
    | .attribute name => name
  .mkObj [
    ("e", .num update.element),
    ("a", .str target),
    ("v", .str update.value)]

private def actionToJson (action : FrameAction) : Json :=
  .mkObj [
    ("frame", .num action.frame),
    ("step", .num action.step),
    ("segment", .num action.segment),
    ("localFrame", .num action.localFrame),
    ("segmentChanged", .bool action.segmentChanged),
    ("updates", .arr (action.updates.map updateToJson)),
    ("playback", .str (playbackName action.playback))]

private def traceError (message : String) : String :=
  toString <| Json.mkObj [("ok", .bool false), ("error", .str message)]

/--
Replays deterministic player events for differential testing from JavaScript.

The result is a JSON object containing the initial frame action followed by one
action for each supplied event, or an error object when either input is invalid.
-/
@[vir_export]
def replayTrace (animationJson eventsJson : String) : String :=
  match (do
      let animation ← parseAnimation animationJson
      let events ← parsePlayerEvents eventsJson
      let prepared ← prepare animation
      let initial := initialPrepared prepared
      let mut state := initial.state
      let mut actions := #[initial.action]
      for event in events do
        let next := transitionPrepared prepared state event
        state := next.state
        actions := actions.push next.action
      pure actions : Except String (Array FrameAction)) with
  | .error message => traceError message
  | .ok actions =>
    toString <| Json.mkObj [
      ("ok", .bool true),
      ("actions", .arr (actions.map actionToJson))]

/--
Replays prepared player events through VIR's structured-value boundary.

Unlike {name}`replayTrace`, this entry does not parse or print JSON and does not
transfer synchronization SVG documents. It is the direct VIR counterpart of
the FIR-native trace entry.
-/
@[vir_export]
def replayTraceTyped
    (animation : PlayerAnimation)
    (events : List PlayerEvent) : Except String (Array FrameAction) :=
  AnimationPlayer.replayTrace animation events

private structure PlayerControls where
  playButton : Option (Js Element) := none
  scrubberElement : Option (Js Element) := none
  scrubber : Option (Js HTMLInputElement) := none
  timeLabel : Option (Js Element) := none

private structure RuntimeState where
  player : PlayerState
  pendingFrame : Option (Js AnimationFrame) := none
  -- Reuses one closure across frame registrations; disposal clears it to break
  -- the closure's reference back to this runtime state.
  frameCallback : Option (Float → DomM Unit) := none
  targets : Array (Option (Js Element)) := #[]
  listeners : Array (Js EventListener) := #[]
  disposed : Bool := false

private structure Mount where
  animation : PlayerAnimation
  syncFrames : Array String
  container : Js Element
  controls : PlayerControls
  state : RuntimeRef RuntimeState

/-- Lean-owned animation instance retained as an opaque JavaScript resource. -/
abbrev PlayerHandle := JSL Mount

/-- Selection and scheduling decisions returned by the compact VIR player. -/
structure SelectionPlayerOutput where
  /-- Frame and playback decision selected by Lean. -/
  action : FrameSelection
  /-- Whether the browser host should request another animation frame. -/
  scheduleNextFrame : Bool
deriving Repr, BEq, Inhabited

private structure SelectionRuntimeState where
  player : PlayerState
  action : FrameSelection

private structure SelectionMount where
  animation : SelectionAnimation
  state : RuntimeRef SelectionRuntimeState

/-- Lean-owned compact selection player retained as an opaque JavaScript resource. -/
abbrev SelectionPlayerHandle := JSL SelectionMount

private def selectionOutput
    (action : FrameSelection)
    (scheduleNextFrame : Bool) : SelectionPlayerOutput :=
  { action, scheduleNextFrame }

/-- Initializes a compact selection player without retaining a VIR runtime handle. -/
@[vir_export]
def initialSelectionDirect
    (animation : SelectionAnimation) : Except String LiveSelectionTransition :=
  initialSelectionLive animation

/-- Applies one compact transition without VIR handle or runtime-reference indirection. -/
@[vir_export]
def transitionSelectionDirect
    (animation : SelectionAnimation)
    (state : PlayerState)
    (event : PlayerEvent) : LiveSelectionTransition :=
  transitionSelectionLive animation state event

/-- Validates and mounts a compact VIR player without transferring SVG patch tables. -/
@[vir_export]
def mountSelectionPlayer
    (animation : SelectionAnimation) : RuntimeM (Except String SelectionPlayerHandle) := do
  match initialSelectionLive animation with
  | .error message => pure (.error message)
  | .ok initial => do
      let state ← RuntimeRef.new { player := initial.state, action := initial.selection }
      .ok <$> LeanRef.toJSL { animation, state }

/-- Returns the most recent decisions from a compact VIR player. -/
@[vir_export]
def selectionPlayerSnapshot
    (handle : SelectionPlayerHandle) : RuntimeM SelectionPlayerOutput := do
  let mount ← LeanRef.fromJSL handle
  let current ← RuntimeRef.get mount.state
  pure (selectionOutput current.action current.action.playback.isActive)

/-- Applies one event to a compact VIR player and returns its next decisions. -/
@[vir_export]
def dispatchSelectionPlayer
    (handle : SelectionPlayerHandle)
    (event : PlayerEvent) : RuntimeM SelectionPlayerOutput := do
  let mount ← LeanRef.fromJSL handle
  let current ← RuntimeRef.get mount.state
  let next := transitionSelectionLive mount.animation current.player event
  RuntimeRef.set mount.state { player := next.state, action := next.selection }
  pure (selectionOutput next.selection next.scheduleNextFrame)

/-- Applies a timestamp tick without constructing a generic player event at the VIR boundary. -/
@[vir_export]
def dispatchSelectionTick
    (handle : SelectionPlayerHandle)
    (timestamp : Float) : RuntimeM SelectionPlayerOutput :=
  dispatchSelectionPlayer handle (.tick timestamp)

/-- Releases an owned compact VIR player handle. -/
@[vir_export]
def disposeSelectionPlayer (handle : SelectionPlayerHandle) : RuntimeM Unit :=
  LeanRef.releaseJSL handle

private def indexElements (container : Js Element) : DomM (Array (Option (Js Element))) := do
  let nodes ← Element.querySelectorAll container "[data-e]"
  let elements ← Js.NodeList.toLeanArray nodes
  let mut indexed := #[]
  for element in elements do
    let some rawIndex ← Element.getAttribute element "data-e" | continue
    let some index := rawIndex.toNat? | continue
    while indexed.size <= index do
      indexed := indexed.push none
    indexed := indexed.set! index (some element)
  pure indexed

private def setPlaybackVisuals (mount : Mount) (status : PlaybackStatus) : DomM Unit := do
  if let some playButton := mount.controls.playButton then
    if status.isActive then
      Element.setTextContent playButton "⏸"
      Element.setAttribute playButton "aria-label" "Pause"
    else
      Element.setTextContent playButton "▶"
      Element.setAttribute playButton "aria-label" "Play"

private def setFrameVisuals (mount : Mount) (action : FrameAction) : DomM Unit := do
  if let some scrubber := mount.controls.scrubber then
    HTMLInputElement.setValue scrubber (toString action.frame)
  if let some timeLabel := mount.controls.timeLabel then
    Element.setTextContent timeLabel s!"{action.frame} / {mount.animation.totalFrames - 1}"

private def renderTransition (mount : Mount) (result : Transition) : DomM Unit := do
  let targets ← if result.action.segmentChanged then
    RuntimeRef.modify mount.state fun current => { current with targets := #[] }
    let syncFrame := mount.syncFrames[result.action.segment]!
    Element.setInnerHTML mount.container syncFrame
    indexElements mount.container
  else
    pure (← RuntimeRef.get mount.state).targets
  for update in result.action.updates do
    let some target := targets[update.element]?.join | continue
    match update.target with
    | .textContent => Element.setTextContent target update.value
    | .attribute name => Element.setAttribute target name update.value
  setFrameVisuals mount result.action
  setPlaybackVisuals mount result.action.playback
  RuntimeRef.modify mount.state fun current => {
    current with player := result.state, targets
  }

private def cancelPendingFrame (mount : Mount) : DomM Unit := do
  let pending ← RuntimeRef.modifyGet mount.state fun current =>
    (current.pendingFrame, { current with pendingFrame := none })
  if let some frame := pending then
    Animation.cancelAnimationFrame frame

private def retainListener (mount : Mount) (listener : Js EventListener) : DomM Unit :=
  RuntimeRef.modify mount.state fun current => {
    current with listeners := current.listeners.push listener
  }

private def addListener
    (mount : Mount)
    (element : Js Element)
    (event : String)
    (callback : Js Event → DomM Unit) : DomM Unit := do
  retainListener mount (← Element.addEventListener element event callback)

mutual
  private partial def scheduleFrame (mount : Mount) : DomM Unit := do
    let current ← RuntimeRef.get mount.state
    if current.disposed || current.pendingFrame.isSome || !current.player.playback.isActive then
      pure ()
    else
      let callback ← match current.frameCallback with
        | some callback => pure callback
        | none =>
          let callback := handleTick mount
          RuntimeRef.modify mount.state fun latest => {
            latest with frameCallback := some callback
          }
          pure callback
      let frame ← Animation.requestAnimationFrame callback
      RuntimeRef.modify mount.state fun latest =>
        if !latest.disposed && latest.player.playback.isActive then
          { latest with pendingFrame := some frame }
        else
          latest

  private partial def dispatch (mount : Mount) (event : PlayerEvent) : DomM Unit := do
    let current ← RuntimeRef.get mount.state
    if current.disposed then
      pure ()
    else
      let result := transitionPrepared mount.animation current.player event
      if !result.action.playback.isActive then
        cancelPendingFrame mount
      renderTransition mount result
      if result.action.playback.isActive then
        scheduleFrame mount

  private partial def handleTick (mount : Mount) (timestamp : Float) : DomM Unit := do
    RuntimeRef.modify mount.state fun current => { current with pendingFrame := none }
    dispatch mount (.tick timestamp)

end

private def disposeMount (mount : Mount) : DomM Unit := do
  let cleanup ← RuntimeRef.modifyGet mount.state fun current =>
    ((current.pendingFrame, current.listeners), {
      current with
      pendingFrame := none
      frameCallback := none
      targets := #[]
      listeners := #[]
      disposed := true
    })
  if let some frame := cleanup.1 then
    Animation.cancelAnimationFrame frame
  for listener in cleanup.2 do
    Element.removeEventListener listener

private def mountValidated
    (animation : PlayerAnimation)
    (syncFrames : Array String)
    (initial : Transition)
    (container : Js Element)
    (controls : PlayerControls)
    (keyboard : Bool) : DomM PlayerHandle := do
  let state ← RuntimeRef.new { player := initial.state }
  let mount := { animation, syncFrames, container, controls, state }
  if let some scrubberElement := controls.scrubberElement then
    Element.setAttribute scrubberElement "max" (toString (animation.totalFrames - 1))
  renderTransition mount initial
  if let some playButton := controls.playButton then
    addListener mount playButton "click" fun _ => dispatch mount .advance
  addListener mount container "click" fun _ => do
    let current ← RuntimeRef.get state
    if current.player.playback == .waiting then
      dispatch mount .advance
  if let some scrubberElement := controls.scrubberElement then
    if let some scrubber := controls.scrubber then
      addListener mount scrubberElement "input" fun _ => do
        if let some frame := (← HTMLInputElement.getValue scrubber).toNat? then
          dispatch mount (.seek frame)
  if keyboard then
    if let some body ← Document.querySelector "body" then
      addListener mount body "keydown" fun event => do
        let key ← Event.key event
        if key == " " || key == "Enter" then
          Event.preventDefault event
          dispatch mount .advance
  LeanRef.toJSL mount

private def prepareMount
    (animationJson containerSelector : String) :
    DomM (Except String (PlayerAnimation × Array String × Transition × Js Element)) := do
  match parseAnimation animationJson with
  | .error message => pure (.error s!"invalid animation data: {message}")
  | .ok animation =>
    match prepare animation with
    | .error message => pure (.error message)
    | .ok prepared => do
      let some container ← Document.querySelector containerSelector
        | return .error s!"missing animation container: {containerSelector}"
      let syncFrames := animation.segments.map (·.syncFrame)
      pure (.ok (prepared, syncFrames, initialPrepared prepared, container))

/--
Mounts the VIR-backed standalone player.

The result contains an owned player handle on success and a user-facing error
when animation data or required DOM targets are invalid. The host must pass a
successful handle to {lit}`disposePlayer` when its mount is removed.
-/
@[vir_export]
def mountStandalone
    (animationJson containerSelector playButtonSelector scrubberSelector : String)
    (keyboard : Bool) : DomM (Except String PlayerHandle) := do
  match ← prepareMount animationJson containerSelector with
  | .error message => pure (.error message)
  | .ok (animation, syncFrames, initial, container) => do
      let some playButton ← Document.querySelector playButtonSelector
        | return .error s!"missing play button: {playButtonSelector}"
      let some scrubberElement ← Document.querySelector scrubberSelector
        | return .error s!"missing scrubber: {scrubberSelector}"
      let some scrubber ← HTMLInputElement.fromElement scrubberElement
        | return .error s!"scrubber is not an input element: {scrubberSelector}"
      let controls := {
        playButton := some playButton
        scrubberElement := some scrubberElement
        scrubber := some scrubber
      }
      .ok <$> mountValidated animation syncFrames initial container controls keyboard

/-- Mounts an animation without standalone controls for an adapter such as Reveal. -/
@[vir_export]
def mountAnimation
    (animationJson containerSelector : String) : DomM (Except String PlayerHandle) := do
  match ← prepareMount animationJson containerSelector with
  | .error message => pure (.error message)
  | .ok (animation, syncFrames, initial, container) =>
    .ok <$> mountValidated animation syncFrames initial container {} false

/-- Pauses an owned animation player at its current frame. -/
@[vir_export]
def pausePlayer (handle : PlayerHandle) : DomM Unit := do
  dispatch (← LeanRef.fromJSL handle) .pause

/-- Seeks an owned animation player directly to a frame. -/
@[vir_export]
def seekPlayer (handle : PlayerHandle) (frame : Nat) : DomM Unit := do
  dispatch (← LeanRef.fromJSL handle) (.seek frame)

/-- Advances, pauses, or resumes an owned animation player. -/
@[vir_export]
def advancePlayer (handle : PlayerHandle) : DomM Unit := do
  dispatch (← LeanRef.fromJSL handle) .advance

/-- Plays an owned animation player toward a frame and optionally enters its loop. -/
@[vir_export]
def playToPlayer (handle : PlayerHandle) (frame : Nat) (loopAfter : Bool) : DomM Unit := do
  dispatch (← LeanRef.fromJSL handle) (.playTo frame loopAfter)

/-- Returns the number of Reveal fragments represented by an owned player. -/
@[vir_export]
def revealFragmentCount (handle : PlayerHandle) : RuntimeM Nat := do
  let mount ← LeanRef.fromJSL handle
  pure (mount.animation.steps.filter (·.pause)).size

/-- Handles a Reveal fragment becoming visible. -/
@[vir_export]
def fragmentShown (handle : PlayerHandle) (index : Nat) : DomM Unit := do
  let mount ← LeanRef.fromJSL handle
  let pauses := mount.animation.steps.filter (·.pause)
  if let some step := pauses[index]? then
    dispatch mount (.playTo step.frame step.loop)

/-- Handles a Reveal fragment becoming hidden during reverse navigation. -/
@[vir_export]
def fragmentHidden (handle : PlayerHandle) (index : Nat) : DomM Unit := do
  let mount ← LeanRef.fromJSL handle
  let pauses := mount.animation.steps.filter (·.pause)
  if index == 0 then
    dispatch mount (.playTo 0 false)
  else if let some previous := pauses[index - 1]? then
    if previous.loop then
      dispatch mount (.loopAt previous.frame)
    else
      dispatch mount (.playTo previous.frame false)

/-- Disposes a player, unregisters callbacks, and releases its Lean-owned handle. -/
@[vir_export]
def disposePlayer (handle : PlayerHandle) : DomM Unit := do
  disposeMount (← LeanRef.fromJSL handle)
  LeanRef.releaseJSL handle

private def infoViewMarkup : String :=
  "<div style=\"padding:4px;background:white\">\
  <div data-illuminate-role=\"container\" style=\"width:100%;cursor:pointer\"></div>\
  <div style=\"display:flex;align-items:center;gap:6px;margin-top:6px\">\
  <button data-illuminate-role=\"play\" aria-label=\"Play\" style=\"font-size:14px;width:28px;height:28px;border:1px solid #ccc;border-radius:4px;background:white;cursor:pointer\">▶</button>\
  <input data-illuminate-role=\"scrubber\" type=\"range\" min=\"0\" value=\"0\" aria-label=\"Animation progress\" style=\"flex:1\">\
  <span data-illuminate-role=\"time\" style=\"font-size:11px;color:#666;min-width:5.5em;text-align:right\"></span>\
  </div></div>"

private def throwDom {α : Type} (message : String) : DomM α := by
  unfold DomM RuntimeM
  exact throw (IO.userError message)

/-- Mounts an owned animation player into a VIR InfoView widget shell. -/
@[vir_export]
def mountInfoView
    (selector : String)
    (animationJson : String) : DomM PlayerHandle := do
  let some root ← Document.querySelector selector
    | throwDom s!"missing InfoView animation root: {selector}"
  Element.setInnerHTML root infoViewMarkup
  let some container ← Element.querySelector root "[data-illuminate-role=container]"
    | throwDom "missing InfoView animation container"
  let some playButton ← Element.querySelector root "[data-illuminate-role=play]"
    | throwDom "missing InfoView animation play button"
  let some scrubberElement ← Element.querySelector root "[data-illuminate-role=scrubber]"
    | throwDom "missing InfoView animation scrubber"
  let some scrubber ← HTMLInputElement.fromElement scrubberElement
    | throwDom "InfoView animation scrubber is not an input element"
  let timeLabel ← Element.querySelector root "[data-illuminate-role=time]"
  match parseAnimation animationJson with
  | .error message => throwDom s!"invalid animation data: {message}"
  | .ok animation =>
    match prepare animation with
    | .error message => throwDom message
    | .ok prepared =>
      mountValidated prepared (animation.segments.map (·.syncFrame))
        (initialPrepared prepared) container {
        playButton := some playButton
        scrubberElement := some scrubberElement
        scrubber := some scrubber
        timeLabel
      } false
