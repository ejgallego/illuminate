/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: David Thrane Christiansen
-/
module
import Illuminate
import IlluminateTests.Helpers
import IlluminateTests.AnimationExamples
public section

open Illuminate
open Illuminate.AnimationPlayer

private def step (d : Float) : Step := { duration := d }

private def playerSegment
    (start count element : Nat)
    (attrName value : String) : Segment :=
  { startFrame := start
    frameCount := count
    syncFrame := s!"<svg data-segment=\"{start}\"></svg>"
    paramMap := #[{ elemIdx := element, attr := attrName }]
    params := Array.replicate count #[value] }

private def playerAnimation
    (totalFrames : Nat)
    (steps : Array StepInfo)
    (segments : Array Segment := #[playerSegment 0 totalFrames 2 "opacity" "1"]) :
    CompiledAnimation :=
  { fps := 10, totalFrames, segments, steps }

private def expectTransition (result : Except String Transition) : IO Transition :=
  match result with
  | .ok transition => pure transition
  | .error message => throw <| IO.userError message

private def expectPrepared (result : Except String PlayerAnimation) : IO PlayerAnimation :=
  match result with
  | .ok animation => pure animation
  | .error message => throw <| IO.userError message

private def expectActions
    (result : Except String (Array FrameAction)) : IO (Array FrameAction) :=
  match result with
  | .ok actions => pure actions
  | .error message => throw <| IO.userError message

private def expectLive (result : Except String LiveTransition) : IO LiveTransition :=
  match result with
  | .ok transition => pure transition
  | .error message => throw <| IO.userError message

private def expectSelectionLive
    (result : Except String LiveSelectionTransition) : IO LiveSelectionTransition :=
  match result with
  | .ok transition => pure transition
  | .error message => throw <| IO.userError message

/-!
# Pure player tests
-/

def playerTests : List (String × IO Unit) :=
  [ ("player: frame helpers", do
      assertTrue (clampFrame 10 15 == 9) "frame clamps to last"
      assertTrue (elapsedFrame 0 250 10 3 == 6) "half frame rounds like JavaScript"
      assertTrue ((wrapLoop 27 10 20) == { wrapped := 17, didCycle := true })
        "loop preserves overshoot")
  , ("player: preparation drops SVG and normalizes patch targets", do
      let animation := playerAnimation 4 #[{ frame := 0, pause := false, loop := false }] #[
        playerSegment 0 2 1 "fill" "red",
        playerSegment 2 2 3 "textContent" "done"
      ]
      let prepared ← expectPrepared (prepare animation)
      assertTrue (prepared.segments.size == animation.segments.size)
        "prepared animation preserves segment count"
      assertTrue (prepared.segments[0]!.paramMap[0]!.target == .attribute "fill")
        "attribute target is normalized"
      assertTrue (prepared.segments[1]!.paramMap[0]!.target == .textContent)
        "text target is normalized")
  , ("player: prepared and compatibility transitions agree", do
      let animation := playerAnimation 10 #[
        { frame := 0, pause := false, loop := false },
        { frame := 5, pause := true, loop := false }
      ]
      let prepared ← expectPrepared (prepare animation)
      let fastInitial := initialPrepared prepared
      let wrappedInitial ← expectTransition (initialTransition animation)
      assertTrue (fastInitial == wrappedInitial) "initial paths agree"
      let event := PlayerEvent.seek 7
      let fast := transitionPrepared prepared fastInitial.state event
      let wrapped ← expectTransition (transition animation wrappedInitial.state event)
      assertTrue (fast == wrapped) "transition paths agree")
  , ("player: prepared trace entry returns one action per boundary", do
      let animation := playerAnimation 10 #[{ frame := 0, pause := false, loop := false }]
      let prepared ← expectPrepared (prepare animation)
      let events := [PlayerEvent.advance, .tick 0, .pause]
      let actions ← expectActions (replayTrace prepared events)
      assertTrue (actions.size == events.length + 1) "trace includes its initial action"
      assertTrue (actions[0]!.playback == .paused) "trace begins paused"
      assertTrue (actions[1]!.playback == .playing) "advance starts trace playback"
      assertTrue (actions[3]!.playback == .paused) "pause ends trace playback")
  , ("player: live FIR boundary exposes scheduling decisions", do
      let animation := playerAnimation 10 #[{ frame := 0, pause := false, loop := false }]
      let prepared ← expectPrepared (prepare animation)
      let initial ← expectLive (initialLive prepared)
      assertTrue (!initial.scheduleNextFrame) "initial paused player does not schedule"
      let playing := transitionLive prepared initial.state .advance
      assertTrue playing.scheduleNextFrame "active player schedules a callback"
      assertTrue (playing.action.playback == .playing) "advance starts playback"
      let paused := transitionLive prepared playing.state .pause
      assertTrue (!paused.scheduleNextFrame) "paused player cancels callbacks"
      assertTrue (paused.action.playback == .paused) "pause stops playback")
  , ("player: compact FIR selection agrees without patch tables", do
      let animation := playerAnimation 20 #[
        { frame := 0, pause := false, loop := false },
        { frame := 5, pause := true, loop := false },
        { frame := 10, pause := false, loop := true }
      ]
      let prepared ← expectPrepared (prepare animation)
      let compact := SelectionAnimation.ofPlayerAnimation prepared
      assertTrue (compact.timeline.segments.all fun segment =>
        segment.paramMap.isEmpty && segment.params.isEmpty)
        "compact input drops every browser-owned patch table"
      let fullInitial ← expectLive (initialLive prepared)
      let compactInitial ← expectSelectionLive (initialSelectionLive compact)
      assertTrue (compactInitial.state == fullInitial.state) "initial states agree"
      assertTrue (compactInitial.selection == fullInitial.action.toSelection)
        "initial selections agree"
      let events : List PlayerEvent := [
        .advance,
        .tick 49.99999999999999,
        .pause,
        .seek 3,
        .playTo 7 false,
        .loopAt 10
      ]
      let mut fullState := fullInitial.state
      let mut compactState := compactInitial.state
      for event in events do
        let full := transitionLive prepared fullState event
        let selected := transitionSelectionLive compact compactState event
        assertTrue (selected.state == full.state) s!"states agree after {reprStr event}"
        assertTrue (selected.selection == full.action.toSelection)
          s!"selections agree after {reprStr event}"
        assertTrue (selected.scheduleNextFrame == full.scheduleNextFrame)
          s!"scheduling agrees after {reprStr event}"
        fullState := full.state
        compactState := selected.state
      match initialSelectionLive { timeline := prepared } with
      | .error _ => pure ()
      | .ok _ => throw <| IO.userError "compact boundary accepted a transferred patch table")
  , ("player: preparation rejects segment gaps accepted by the legacy host", do
      let malformed := playerAnimation 4 #[{ frame := 0, pause := false, loop := false }] #[
        playerSegment 0 2 1 "fill" "red",
        playerSegment 3 1 1 "fill" "blue"
      ]
      match prepare malformed with
      | .error _ => pure ()
      | .ok _ => throw <| IO.userError "segment coverage was not validated")
  , ("player: preparation rejects misaligned parameter rows", do
      let segment := playerSegment 0 2 1 "fill" "red"
      let malformed := playerAnimation 2 #[{ frame := 0, pause := false, loop := false }] #[
        { segment with params := #[#[], #["red"]] }
      ]
      match prepare malformed with
      | .error _ => pure ()
      | .ok _ => throw <| IO.userError "parameter alignment was not validated")
  , ("player: initialization selects patches", do
      let animation := playerAnimation 10 #[{ frame := 0, pause := false, loop := false }]
      let initial ← expectTransition (initialTransition animation)
      assertTrue initial.action.segmentChanged "initial segment is installed"
      assertTrue (initial.action.updates == #[{
        element := 2, target := .attribute "opacity", value := "1"
      }]) "initial parameters are selected")
  , ("player: pause crossed by timestamp jump", do
      let animation := playerAnimation 12 #[
        { frame := 0, pause := false, loop := false },
        { frame := 5, pause := true, loop := false }
      ]
      let initial ← expectTransition (initialTransition animation)
      let started ← expectTransition (transition animation initial.state .advance)
      let anchored ← expectTransition (transition animation started.state (.tick 100))
      let paused ← expectTransition (transition animation anchored.state (.tick 700))
      assertTrue (paused.action.frame == 5) "jump stops at pause frame"
      assertTrue (paused.action.playback == .waiting) "jump waits for interaction")
  , ("player: large jump finishes", do
      let animation := playerAnimation 10 #[
        { frame := 0, pause := false, loop := false },
        { frame := 6, pause := false, loop := false }
      ]
      let initial ← expectTransition (initialTransition animation)
      let started ← expectTransition (transition animation initial.state .advance)
      let anchored ← expectTransition (transition animation started.state (.tick 0))
      let finished ← expectTransition (transition animation anchored.state (.tick 5000))
      assertTrue (finished.action.frame == 9) "large jump clamps to last frame"
      assertTrue (finished.action.step == 1) "large jump updates the final step"
      assertTrue (finished.action.playback == .finished) "large jump finishes playback")
  , ("player: end overshoot still stops at crossed pause", do
      let animation := playerAnimation 10 #[
        { frame := 0, pause := false, loop := false },
        { frame := 5, pause := true, loop := false }
      ]
      let initial ← expectTransition (initialTransition animation)
      let started ← expectTransition (transition animation initial.state .advance)
      let anchored ← expectTransition (transition animation started.state (.tick 0))
      let paused ← expectTransition (transition animation anchored.state (.tick 5000))
      assertTrue (paused.action.frame == 5) "end overshoot stops at pause frame"
      assertTrue (paused.action.playback == .waiting) "end overshoot waits at crossed pause")
  , ("player: final loop wraps with overshoot", do
      let animation := playerAnimation 10 #[{ frame := 0, pause := false, loop := true }]
      let initial ← expectTransition (initialTransition animation)
      let started ← expectTransition (transition animation initial.state .advance)
      let anchored ← expectTransition (transition animation started.state (.tick 0))
      let wrapped ← expectTransition (transition animation anchored.state (.tick 1250))
      assertTrue (wrapped.action.frame == 3) "loop wraps rounded overshoot"
      assertTrue (wrapped.action.playback == .looping) "final loop remains active")
  , ("player: loop exit waits for boundary", do
      let animation := playerAnimation 20 #[
        { frame := 0, pause := false, loop := true },
        { frame := 10, pause := false, loop := false }
      ]
      let initial ← expectTransition (initialTransition animation)
      let started ← expectTransition (transition animation initial.state .advance)
      let anchored ← expectTransition (transition animation started.state (.tick 0))
      let pending ← expectTransition (transition animation anchored.state .advance)
      assertTrue (pending.action.playback == .finishingLoop) "advance requests loop exit"
      let exited ← expectTransition (transition animation pending.state (.tick 1100))
      assertTrue (exited.action.frame == 10) "loop exits at following step"
      assertTrue (exited.action.playback == .playing) "following step plays")
  , ("player: seek and replay", do
      let animation := playerAnimation 10 #[{ frame := 0, pause := false, loop := false }]
      let initial ← expectTransition (initialTransition animation)
      let sought ← expectTransition (transition animation initial.state (.seek 99))
      assertTrue (sought.action.frame == 9) "seek clamps"
      assertTrue (sought.action.playback == .finished) "seek to end marks finished"
      let replayed ← expectTransition (transition animation sought.state .advance)
      assertTrue (replayed.action.frame == 0) "advance from end replays"
      assertTrue replayed.action.playback.isActive "replay schedules playback")
  , ("player: directed playback moves forward and backward", do
      let animation := playerAnimation 12 #[{ frame := 0, pause := false, loop := false }]
      let initial ← expectTransition (initialTransition animation)
      let forward ← expectTransition (transition animation initial.state (.playTo 6))
      let anchored ← expectTransition (transition animation forward.state (.tick 100))
      let midway ← expectTransition (transition animation anchored.state (.tick 400))
      assertTrue (midway.action.frame == 3) "directed playback advances toward target"
      let arrived ← expectTransition (transition animation midway.state (.tick 700))
      assertTrue (arrived.action.frame == 6) "directed playback reaches target"
      assertTrue (arrived.action.playback == .paused) "directed playback pauses at target"
      let reverse ← expectTransition (transition animation arrived.state (.playTo 2))
      let reverseAnchor ← expectTransition (transition animation reverse.state (.tick 800))
      let reversed ← expectTransition (transition animation reverseAnchor.state (.tick 1200))
      assertTrue (reversed.action.frame == 2) "directed playback reaches reverse target"
      assertTrue (reversed.action.playback == .paused) "reverse target pauses")
  , ("player: directed playback enters target loop", do
      let animation := playerAnimation 12 #[
        { frame := 0, pause := false, loop := false },
        { frame := 5, pause := true, loop := true }
      ]
      let initial ← expectTransition (initialTransition animation)
      let directed ← expectTransition (transition animation initial.state (.playTo 5 true))
      let anchored ← expectTransition (transition animation directed.state (.tick 0))
      let arrived ← expectTransition (transition animation anchored.state (.tick 500))
      assertTrue (arrived.action.frame == 5) "directed playback reaches loop start"
      assertTrue (arrived.action.playback == .looping) "directed playback enters target loop"
      let paused ← expectTransition (transition animation arrived.state .pause)
      assertTrue (paused.action.playback == .paused) "explicit pause stops target loop")
  , ("player: structural segment change", do
      let animation := playerAnimation 4 #[{ frame := 0, pause := false, loop := false }] #[
        playerSegment 0 2 1 "fill" "red",
        playerSegment 2 2 3 "textContent" "done"
      ]
      let initial ← expectTransition (initialTransition animation)
      let changed ← expectTransition (transition animation initial.state (.seek 2))
      assertTrue changed.action.segmentChanged "seek installs second segment"
      assertTrue (changed.action.updates == #[{
        element := 3, target := .textContent, value := "done"
      }]) "text patch is selected")
  ]

/-!
# Easing tests
-/

def easingTests : List (String × IO Unit) :=
  [ ("easing: linear 0→0, 1→1", do
      assertApproxEq (Easing.linear 0) 0 "linear(0)"
      assertApproxEq (Easing.linear 1) 1 "linear(1)"
      assertApproxEq (Easing.linear 0.5) 0.5 "linear(0.5)")
  , ("easing: easeIn 0→0, 1→1", do
      assertApproxEq (Easing.easeIn 0) 0 "easeIn(0)"
      assertApproxEq (Easing.easeIn 1) 1 "easeIn(1)"
      assertApproxEq (Easing.easeIn 0.5) 0.25 "easeIn(0.5)")
  , ("easing: easeOut 0→0, 1→1", do
      assertApproxEq (Easing.easeOut 0) 0 "easeOut(0)"
      assertApproxEq (Easing.easeOut 1) 1 "easeOut(1)"
      assertApproxEq (Easing.easeOut 0.5) 0.75 "easeOut(0.5)")
  , ("easing: easeInOut 0→0, 1→1", do
      assertApproxEq (Easing.easeInOut 0) 0 "easeInOut(0)"
      assertApproxEq (Easing.easeInOut 1) 1 "easeInOut(1)"
      assertApproxEq (Easing.easeInOut 0.5) 0.5 "easeInOut(0.5)")
  , ("easing: sineInOut 0→0, 1→1", do
      assertApproxEq (Easing.sineInOut 0) 0 "sineInOut(0)" (tol := 1e-6)
      assertApproxEq (Easing.sineInOut 1) 1 "sineInOut(1)" (tol := 1e-6)
      assertApproxEq (Easing.sineInOut 0.25) 0.14645 "sineInOut(0.25)" (tol := 1e-4)
      assertApproxEq (Easing.sineInOut 0.5) 0.5 "sineInOut(0.5)" (tol := 1e-6)
      assertApproxEq (Easing.sineInOut 0.75) 0.85355 "sineInOut(0.75)" (tol := 1e-4))
  , ("easing: backOut 0→0, 1→1", do
      assertApproxEq (Easing.backOut 0) 0 "backOut(0)" (tol := 1e-6)
      assertApproxEq (Easing.backOut 1) 1 "backOut(1)" (tol := 1e-6))
  ]

/-!
# Interpolation tests
-/

def interpolationTests : List (String × IO Unit) :=
  [ ("interpolate: Float", do
      assertApproxEq (Interpolate.interpolate 0 10 0) 0 "float t=0"
      assertApproxEq (Interpolate.interpolate 0 10 1) 10 "float t=1"
      assertApproxEq (Interpolate.interpolate 0 10 0.5) 5 "float t=0.5"
      assertApproxEq (Interpolate.interpolate 20 40 0.25) 25 "float 20-40 t=0.25")
  , ("interpolate: Vec2", do
      let a : Vec2 := ⟨0, 0⟩
      let b : Vec2 := ⟨10, 20⟩
      let mid := Interpolate.interpolate a b 0.5
      assertVec2Eq mid ⟨5, 10⟩ "vec2 midpoint"
      let start := Interpolate.interpolate a b 0
      assertVec2Eq start a "vec2 t=0"
      let finish := Interpolate.interpolate a b 1
      assertVec2Eq finish b "vec2 t=1")
  , ("interpolate: Color", do
      let a := Color.black
      let b := Color.white
      let mid := Interpolate.interpolate a b 0.5
      -- black→white midpoint: each channel should be ~127 or 128
      assertTrue (mid.r >= 127 && mid.r <= 128) s!"color mid r: expected 127-128, got {mid.r}"
      assertTrue (mid.g >= 127 && mid.g <= 128) s!"color mid g: expected 127-128, got {mid.g}"
      assertTrue (mid.b >= 127 && mid.b <= 128) s!"color mid b: expected 127-128, got {mid.b}"
      let start := Interpolate.interpolate a b 0
      assertTrue (start.r == 0) "color t=0 r"
      let finish := Interpolate.interpolate a b 1
      assertTrue (finish.r == 255) "color t=1 r")
  , ("interpolate: Matrix", do
      let a := Matrix.identity
      let b := Matrix.translate 10 20
      let mid := Interpolate.interpolate a b 0.5
      assertApproxEq mid.tx 5 "matrix mid tx"
      assertApproxEq mid.ty 10 "matrix mid ty"
      assertApproxEq mid.a 1 "matrix mid a"
      assertApproxEq mid.d 1 "matrix mid d")
  ]

/-!
# Timeline tests
-/

def timelineTests : List (String × IO Unit) :=
  [ ("totalDuration: basic", do
      assertApproxEq (totalDuration [step 1.0, step 2.0, step 0.5]) 3.5 "3 steps")
  , ("totalDuration: zero and negative", do
      assertApproxEq (totalDuration [step 1.0, step 0, step (-1.0), step 2.0]) 3.0
        "zero and negative skipped")
  , ("totalDuration: empty", do
      assertApproxEq (totalDuration []) 0 "empty")
  , ("progressAt: before start", do
      let p := progressAt [step 1.0, step 1.0] 0
      assertApproxEq (p[0]?.getD 0) 0 "step 0 at t=0"
      assertApproxEq (p[1]?.getD 0) 0 "step 1 at t=0")
  , ("progressAt: midway through step 1", do
      let p := progressAt [step 2.0, step 1.0] 1.0
      assertApproxEq (p[0]?.getD 0) 0.5 "step 0 at t=1"
      assertApproxEq (p[1]?.getD 0) 0 "step 1 at t=1")
  , ("progressAt: at step boundary", do
      let p := progressAt [step 1.0, step 1.0] 1.0
      assertApproxEq (p[0]?.getD 0) 1.0 "step 0 at t=1"
      assertApproxEq (p[1]?.getD 0) 0 "step 1 at t=1")
  , ("progressAt: all done", do
      let p := progressAt [step 1.0, step 1.0] 2.0
      assertApproxEq (p[0]?.getD 0) 1.0 "step 0 at t=2"
      assertApproxEq (p[1]?.getD 0) 1.0 "step 1 at t=2")
  , ("progressAt: past end", do
      let p := progressAt [step 1.0] 5.0
      assertApproxEq (p[0]?.getD 0) 1.0 "step 0 clamped at 1")
  , ("progressAt: zero-duration step skipped", do
      let p := progressAt [step 0, step 1.0] 0.5
      assertApproxEq (p[0]?.getD 0) 1.0 "zero-dur step is 1.0"
      assertApproxEq (p[1]?.getD 0) 0.5 "next step progresses")
  , ("progressAt: looping step wraps", do
      let p := progressAt [{ duration := 1.0, loop := true }] 1.5
      assertApproxEq (p[0]?.getD 0) 0.5 "loop wraps at 1.5s")
  , ("progressAt: looping step wraps multiple times", do
      let p := progressAt [{ duration := 1.0, loop := true }] 3.25
      assertApproxEq (p[0]?.getD 0) 0.25 "loop wraps at 3.25s")
  , ("progressAt: looping step at exact boundary", do
      let p := progressAt [{ duration := 1.0, loop := true }] 2.0
      -- At exactly 2.0, raw = 2.0, 2.0 - floor(2.0) = 0.0
      assertApproxEq (p[0]?.getD 0) 0.0 "loop at exact boundary")
  , ("progressAt: loop then non-loop step", do
      let p := progressAt [{ duration := 1.0, loop := true }, step 1.0] 1.5
      assertApproxEq (p[0]?.getD 0) 0.5 "loop step wraps"
      assertApproxEq (p[1]?.getD 0) 0.5 "next step progresses")
  , ("progressVector: correct size", do
      let v := progressVector [0.5, 1.0] 4
      assertTrue (v.size == 4) "vector size is 4"
      assertApproxEq (v[0]) 0.5 "v[0]"
      assertApproxEq (v[1]) 1.0 "v[1]"
      assertApproxEq (v[2]) 0.0 "v[2] padded"
      assertApproxEq (v[3]) 0.0 "v[3] padded")
  ]

/-!
# Effects tests
-/

private def disc : Diagram Empty := Diagram.circle 10 (fill := .solid { color := Color.red })
private def blueDisc : Diagram Empty := Diagram.circle 10 (fill := .solid { color := Color.blue })

def effectsTests : List (String × IO Unit) :=
  [ ("fadeIn: t=0 is transparent",
      assertCellophane (fadeIn disc 0) 0 "fadeIn t=0")
  , ("fadeIn: t=1 is opaque",
      assertCellophane (fadeIn disc 1) 1 "fadeIn t=1")
  , ("fadeOut: t=0 is opaque",
      assertCellophane (fadeOut disc 0) 1 "fadeOut t=0")
  , ("fadeOut: t=1 is transparent",
      assertCellophane (fadeOut disc 1) 0 "fadeOut t=1")
  , ("crossFade: midpoint",
      assertCrossFade (crossFade disc blueDisc 0.5) 0.5 0.5 "crossFade t=0.5")
  , ("crossFade: t=0 only a visible",
      assertCrossFade (crossFade disc blueDisc 0) 1.0 0.0 "crossFade t=0")
  , ("crossFade: t=1 only b visible",
      assertCrossFade (crossFade disc blueDisc 1) 0.0 1.0 "crossFade t=1")
  , ("slide: t=0 at start position",
      assertTransform (slide disc ⟨100, 0⟩ ⟨200, 0⟩ 0) (fun m => do
        assertApproxEq m.tx 100 "tx"; assertApproxEq m.ty 0 "ty") "slide t=0")
  , ("slide: t=1 at end position",
      assertTransform (slide disc ⟨100, 0⟩ ⟨200, 0⟩ 1) (fun m => do
        assertApproxEq m.tx 200 "tx"; assertApproxEq m.ty 0 "ty") "slide t=1")
  , ("slide: start equals finish",
      assertTransform (slide disc ⟨50, 50⟩ ⟨50, 50⟩ 0.5) (fun m => do
        assertApproxEq m.tx 50 "tx"; assertApproxEq m.ty 50 "ty") "slide same")
  , ("animScale: t=0.5 midpoint",
      assertTransform (animScale disc 1.0 3.0 0.5) (fun m => do
        assertApproxEq m.a 2.0 "sx"; assertApproxEq m.d 2.0 "sy") "scale t=0.5")
  , ("animScale: s0 equals s1",
      assertTransform (animScale disc 2.0 2.0 0.5) (fun m => do
        assertApproxEq m.a 2.0 "sx"; assertApproxEq m.d 2.0 "sy") "scale same")
  , ("animRotate: t=0 no rotation",
      assertTransform (animRotate disc 0 pi 0) (fun m => do
        assertApproxEq m.a 1.0 "cos" (tol := 1e-6)
        assertApproxEq m.c 0.0 "sin" (tol := 1e-6)) "rotate t=0")
  , ("animRotate: t=0.5 half rotation",
      assertTransform (animRotate disc 0 pi 0.5) (fun m => do
        assertApproxEq m.a 0.0 "cos" (tol := 1e-6)
        assertApproxEq m.c 1.0 "sin" (tol := 1e-6)) "rotate t=0.5")
  , ("animRotate: t=1 full rotation",
      assertTransform (animRotate disc 0 pi 1) (fun m => do
        assertApproxEq m.a (-1.0) "cos" (tol := 1e-6)
        assertApproxEq m.c 0.0 "sin" (tol := 1e-6)) "rotate t=1")
  ]

/-!
# Compilation tests
-/

def compilationTests : List (String × IO Unit) :=
  [ ("compile: basic animation has correct frame count", do
      let steps : List Step := [step 1.0]
      let compiled := compileAnimation steps
        (fun progress => Diagram.circle (Interpolate.interpolate 10 50 progress[0])
          (fill := .solid { color := Color.red }))
        (fps := 10)
      assertTrue (compiled.totalFrames == 10) s!"expected 10 frames, got {compiled.totalFrames}"
      assertTrue (compiled.fps == 10) "fps preserved")
  , ("compile: segments are present", do
      let steps : List Step := [step 0.5, step 0.5]
      let compiled := compileAnimation steps
        (fun progress => Diagram.circle (Interpolate.interpolate 10 50 progress[0])
          (fill := .solid { color := Color.red }))
        (fps := 10)
      assertTrue (compiled.segments.size > 0) "has segments"
      let totalCovered := compiled.segments.foldl (fun acc s => acc + s.frameCount) 0
      assertTrue (totalCovered == compiled.totalFrames)
        s!"segments cover all frames: {totalCovered} vs {compiled.totalFrames}")
  , ("compile: step boundaries present", do
      let steps : List Step := [step 1.0, step 1.0]
      let compiled := compileAnimation steps
        (fun _ => Diagram.circle 20 (fill := .solid { color := Color.red }))
        (fps := 10)
      assertTrue (compiled.steps.size == 2) s!"expected 2 steps, got {compiled.steps.size}")
  , ("compile: sync frames are valid SVG", do
      let steps : List Step := [step 0.5]
      let compiled := compileAnimation steps
        (fun _ => Diagram.circle 20 (fill := .solid { color := Color.red }))
        (fps := 10)
      for seg in compiled.segments do
        assertContains seg.syncFrame "<svg" "sync frame is SVG")
  , ("compile: single frame at fps=1", do
      let steps : List Step := [step 1.0]
      let compiled := compileAnimation steps
        (fun _ => Diagram.circle 20 (fill := .solid { color := Color.red }))
        (fps := 1)
      assertTrue (compiled.totalFrames == 1) s!"expected 1 frame, got {compiled.totalFrames}"
      assertTrue (compiled.segments.size > 0) "has segments at fps=1")
  , ("compile: pause-only animation", do
      let steps : List Step := [{ duration := 0, pause := true }]
      let compiled := compileAnimation steps
        (fun _ => Diagram.circle 20 (fill := .solid { color := Color.red }))
        (fps := 10)
      let pauseSteps := compiled.steps.filter (·.pause)
      assertTrue (pauseSteps.size == 1) s!"expected 1 pause step, got {pauseSteps.size}")
  , ("compile: pause steps tracked", do
      let steps : List Step := [step 0.5, { duration := 0, pause := true }, step 0.5]
      let compiled := compileAnimation steps
        (fun _ => Diagram.circle 20 (fill := .solid { color := Color.red }))
        (fps := 10)
      let pauseSteps := compiled.steps.filter (·.pause)
      assertTrue (pauseSteps.size == 1) s!"expected 1 pause step, got {pauseSteps.size}")
  , ("compile: static clip-path indexing is correct", do
      -- Static clip + animated content: indices align because the JS walker
      -- skips <clipPath> children and treats <defs> as transparent.
      IO.FS.createDirAll "test_output"
      let steps : List Step := [step 2.0]
      let compiled := compileAnimation steps
        (fun progress =>
          let t := progress[0]
          let clipped := Diagram.clipRect 40 40
            (Diagram.circle (Interpolate.interpolate 5.0 30.0 t)
              (fill := .solid { color := Color.red }))
          let unclipped := fadeIn
            (Diagram.circle 20 (fill := .solid { color := Color.blue }))
            t
          Diagram.hsep 20 [clipped, unclipped])
        (fps := 30)
      let totalParams := compiled.segments.foldl (fun acc s => acc + s.paramMap.size) 0
      assertTrue (totalParams > 0)
        s!"expected paramMap bindings, got {totalParams}"
      let html := compiled.renderHTML
      IO.FS.writeFile "test_output/anim-clippath-test.html" html
      IO.println s!"  → wrote test_output/anim-clippath-test.html ({html.length} bytes)")
  , ("compile: animated clip shape", do
      -- The clip boundary grows over time; the data-e attribute on the
      -- inner <path> inside <clipPath> lets the animation player patch
      -- the correct element.
      IO.FS.createDirAll "test_output"
      let steps : List Step := [step 2.0]
      let compiled := compileAnimation steps
        (fun progress =>
          let t := progress[0]
          let clipW := Interpolate.interpolate 20.0 60.0 t
          let clipH := Interpolate.interpolate 20.0 60.0 t
          Diagram.clipRect clipW clipH
            (Diagram.circle 30 (fill := .solid { color := Color.red })))
        (fps := 30)
      let clipDBindings := compiled.segments.foldl (fun acc s =>
        acc ++ (s.paramMap.filter fun b => b.attr == "d").toList) []
      assertTrue (clipDBindings.length > 0)
        "clip shape d attr should be in paramMap"
      let html := compiled.renderHTML
      IO.FS.writeFile "test_output/anim-clipshape-test.html" html
      IO.println s!"  → wrote test_output/anim-clipshape-test.html ({html.length} bytes)")
  , ("compile: animated gradient stop colors tracked", do
      -- A gradient-filled circle whose middle stop color varies over time.
      -- The animation system should detect stop-color changes in the paramMap.
      IO.FS.createDirAll "test_output"
      let steps : List Step := [step 2.0]
      let compiled := compileAnimation steps
        (fun progress =>
          let t := progress[0]
          let midRed := (t * 255).toUInt8
          let midColor : Color := { r := midRed, g := (255 - midRed), b := 0 }
          Diagram.circle 40
            (fill := .linearGradient Vec2.north
              (stops := #[
                { offset := 0, color := Color.blue },
                { offset := 0.5, color := midColor },
                { offset := 1, color := Color.white }
              ])))
        (fps := 10)
      -- The gradient stop colors change every frame, so at least one
      -- stop-color binding should appear in the paramMap.
      let stopColorBindings := compiled.segments.foldl (fun acc s =>
        acc ++ (s.paramMap.filter fun b => b.attr == "stop-color").toList) []
      let allAttrs := compiled.segments.foldl (fun acc s =>
        acc ++ (s.paramMap.map (·.attr)).toList) []
      assertTrue (stopColorBindings.length > 0)
        s!"gradient stop-color should be in paramMap but got 0 bindings; \
          all tracked attrs: {allAttrs}"
      let html := compiled.renderHTML
      IO.FS.writeFile "test_output/anim-gradient-color-test.html" html
      IO.println s!"  → wrote test_output/anim-gradient-color-test.html ({html.length} bytes)")
  , ("compile: animated gradient stop offsets tracked", do
      -- A gradient whose middle stop offset slides from 0.2 to 0.8.
      let steps : List Step := [step 1.0]
      let compiled := compileAnimation steps
        (fun progress =>
          let t := progress[0]
          let midOff := 0.2 + 0.6 * t
          Diagram.circle 30
            (fill := .linearGradient Vec2.east
              (stops := #[
                { offset := 0, color := Color.red },
                { offset := midOff, color := Color.white },
                { offset := 1, color := Color.blue }
              ])))
        (fps := 10)
      let offsetBindings := compiled.segments.foldl (fun acc s =>
        acc ++ (s.paramMap.filter fun b => b.attr == "offset").toList) []
      assertTrue (offsetBindings.length > 0)
        s!"gradient offset should be in paramMap but got 0 bindings")
  , ("compile: gradient stop count change forces segment split", do
      -- First half: 3 stops. Second half: 2 stops.
      -- Different stop counts produce different SVG child structure,
      -- so the animation system should create a segment boundary.
      let steps : List Step := [step 2.0]
      let compiled := compileAnimation steps
        (fun progress =>
          let t := progress[0]
          if t < 0.5 then
            Diagram.circle 30
              (fill := .linearGradient Vec2.north
                (stops := #[
                  { offset := 0, color := Color.red },
                  { offset := 0.5, color := Color.white },
                  { offset := 1, color := Color.blue }
                ]))
          else
            Diagram.circle 30
              (fill := .linearGradient Vec2.north
                (stops := #[
                  { offset := 0, color := Color.red },
                  { offset := 1, color := Color.blue }
                ])))
        (fps := 10)
      assertTrue (compiled.segments.size >= 2)
        s!"expected ≥2 segments for stop count change, got {compiled.segments.size}"
      IO.FS.createDirAll "test_output"
      let html := compiled.renderHTML
      let virHtml := compiled.renderVirHTML
      IO.FS.writeFile "test_output/anim-segment-test.html" html
      IO.FS.writeFile "test_output/anim-vir-segment-test.html" virHtml)
  , ("compile: styled text span color tracked", do
      -- A styled text with two spans; the second span's color varies.
      -- The per-tspan fill attribute should appear in paramMap.
      let steps : List Step := [step 1.0]
      let compiled := compileAnimation steps
        (fun progress =>
          let t := progress[0]
          let color := Interpolate.interpolate Color.blue Color.red t
          Diagram.styledLines [
            [({ color := Color.black }, "Hello "),
             ({ color }, "World")]
          ])
        (fps := 10)
      -- At minimum, the varying tspan's fill should be tracked.
      -- Count fill bindings that are NOT "none" (path strokes use fill="none").
      let fillBindings := compiled.segments.foldl (fun acc s =>
        acc ++ (s.paramMap.filter fun b => b.attr == "fill").toList) []
      assertTrue (fillBindings.length > 0)
        s!"styled text tspan fill should be in paramMap but got 0 bindings")
  , ("compile: multiline text per-tspan content tracked", do
      -- A drawTextRun with newlines; BOTH lines change across frames.
      -- Each tspan should have its own textContent binding (not one on the outer <text>,
      -- which would destroy the tspan structure when patched).
      let steps : List Step := [step 1.0]
      let compiled := compileAnimation steps
        (fun progress =>
          let t := progress[0]
          let n := (t * 100).round.toUInt64.toNat
          Diagram.text s!"Line 1: {n}\nLine 2: {100 - n}" { fontSize := 14 })
        (fps := 10)
      -- Both lines vary, so we need 2 textContent bindings (one per tspan).
      -- Currently there's only 1 (on the outer <text>), which is wrong.
      let textBindings := compiled.segments.foldl (fun acc s =>
        acc ++ (s.paramMap.filter fun b => b.attr == "textContent").toList) []
      assertTrue (textBindings.length >= 2)
        s!"multiline text needs per-tspan textContent bindings, got {textBindings.length}")
  , ("compile: write standalone HTML for seek test", do
      IO.FS.createDirAll "test_output"
      let steps : List Step := [step 3.0]
      let compiled := compileAnimation steps
        (fun progress =>
          let t := Easing.easeInOut progress[0]
          let r := Interpolate.interpolate 10.0 50.0 t
          Diagram.circle r (fill := .solid { color := Color.red }))
        (fps := 60)
      let html := compiled.renderHTML
      IO.FS.writeFile "test_output/anim-seek-test.html" html
      let virHtml := compiled.renderVirHTML
      IO.FS.writeFile "test_output/anim-vir-seek-test.html" virHtml
      IO.println s!"  → wrote test_output/anim-seek-test.html ({html.length} bytes)"
      IO.println s!"  → wrote test_output/anim-vir-seek-test.html ({virHtml.length} bytes)")
  , ("compile: write standalone HTML for loop test", do
      let steps : List Step := [{ duration := 2.0, loop := true }]
      let compiled := compileAnimation steps
        (fun progress =>
          let t := progress[0]
          let angle := t * 2 * pi
          Diagram.move (.dir angle) 40
            (Diagram.circle 10 (fill := .solid { color := Color.blue })))
        (fps := 60)
      let html := compiled.renderHTML
      IO.FS.writeFile "test_output/anim-loop-test.html" html
      let virHtml := compiled.renderVirHTML
      IO.FS.writeFile "test_output/anim-vir-loop-test.html" virHtml
      IO.println s!"  → wrote test_output/anim-loop-test.html ({html.length} bytes)"
      IO.println s!"  → wrote test_output/anim-vir-loop-test.html ({virHtml.length} bytes)")
  , ("compile: write dual-animation HTML for global clobbering test", do
      -- Animation A: red circle grows, pulses color in a loop, then grows again
      let compiledA := compileAnimation
        [{ duration := 0, pause := true }, step 0.2,
         { duration := 0.2, loop := true, pause := true },
         { duration := 0, pause := true }, step 0.2]
        (fun progress =>
          let r1 := Interpolate.interpolate 10.0 25.0 progress[1]
          let r := Interpolate.interpolate r1 40.0 progress[4]
          let pulse := progress[2]
          let t := 0.5 + 0.5 * Float.sin (pulse * 2 * pi)
          let color := Interpolate.interpolate Color.red Color.blue t
          Diagram.circle r (fill := .solid { color }))
        (fps := 60)
      -- Animation B: blue square shrinks in 2 pause-driven stages
      let compiledB := compileAnimation
        [{ duration := 0, pause := true }, step 0.2,
         { duration := 0, pause := true }, step 0.2]
        (fun progress =>
          let s1 := Interpolate.interpolate 60.0 40.0 progress[1]
          let sz := Interpolate.interpolate s1 20.0 progress[3]
          Diagram.rect sz sz (fill := .solid { color := Color.blue }))
        (fps := 60)
      let snippetA := compiledA.renderRevealHTML "#anim-a"
      let snippetB := compiledB.renderRevealHTML "#anim-b"
      let virSnippetA := compiledA.renderVirRevealHTML "#anim-a"
      let virSnippetB := compiledB.renderVirRevealHTML "#anim-b"
      -- Minimal Reveal mock: click advances, right-click/backspace goes back.
      -- Must appear BEFORE animation snippets so window.Reveal exists when they
      -- call addEventListener. Fragments are queried lazily since they are
      -- created by the animation snippets that run after this script.
      let revealMock := "
<script>
(function() {
  window.Reveal = {
    listeners: { shown: [], hidden: [], slide: [] },
    addEventListener: function(type, fn) {
      if (type === 'fragmentshown') this.listeners.shown.push(fn);
      if (type === 'fragmenthidden') this.listeners.hidden.push(fn);
      if (type === 'slidechanged') this.listeners.slide.push(fn);
    }
  };
})();
</script>"
      let harness := "
<script>
(function() {
  var shown = 0;
  function getFragments() { return document.querySelectorAll('.fragment'); }
  function advance() {
    var fragments = getFragments();
    if (shown < fragments.length) {
      var e = new CustomEvent('fragmentshown', { detail: {} });
      e.fragment = fragments[shown];
      Reveal.listeners.shown.forEach(function(fn) { fn(e); });
      shown++;
    }
  }
  function back() {
    if (shown > 0) {
      shown--;
      var fragments = getFragments();
      var e = new CustomEvent('fragmenthidden', { detail: {} });
      e.fragment = fragments[shown];
      Reveal.listeners.hidden.forEach(function(fn) { fn(e); });
    }
  }
  document.addEventListener('click', function(e) {
    if (e.button === 0) advance();
  });
  document.addEventListener('contextmenu', function(e) {
    e.preventDefault(); back();
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'ArrowRight' || e.key === ' ') advance();
    if (e.key === 'ArrowLeft' || e.key === 'Backspace') back();
  });
})();
</script>"
      let html := s!"<!DOCTYPE html>
<html><head><meta charset=\"utf-8\">
<style>
body \{ margin: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; min-height: 100vh; gap: 20px;
  background: #f5f5f5; font-family: sans-serif; cursor: pointer; }
#anim-a, #anim-b \{ background: white; border: 1px solid #ddd; border-radius: 4px;
  padding: 10px; width: min(400px, 90vw); }
#anim-a svg, #anim-b svg \{ display: block; width: 100%; height: auto; }
p \{ color: #888; font-size: 14px; }
</style>
</head>
<body>
<p>Click / → to advance, right-click / ← to go back</p>
<div id=\"anim-a\"></div>
<div id=\"anim-b\"></div>
{revealMock}
{snippetA}
{snippetB}
{harness}
</body></html>"
      IO.FS.writeFile "test_output/anim-dual-test.html" html
      let virHtml := html
        |>.replace snippetA virSnippetA
        |>.replace snippetB virSnippetB
      IO.FS.writeFile "test_output/anim-vir-dual-test.html" virHtml
      IO.println s!"  → wrote test_output/anim-dual-test.html ({html.length} bytes)")
  , ("compile: write complete JS/VIR comparison dashboard", do
      let html := renderAnimationComparisonHTML animationExampleCatalogue
      IO.FS.writeFile "test_output/anim-comparison.html" html
      assertTrue (animationExampleCatalogue.size == 16)
        "comparison dashboard includes every #animate example"
      assertContains html "JavaScript and Lean, frame for frame"
        "comparison dashboard has its heading"
      IO.println s!"  → wrote test_output/anim-comparison.html ({html.length} bytes)")
  ]

/-!
# All animation tests
-/

def animationTests : List (String × IO Unit) :=
  playerTests ++ easingTests ++ interpolationTests ++ timelineTests ++ effectsTests ++ compilationTests
