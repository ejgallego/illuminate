/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: David Thrane Christiansen
-/
module
public import Illuminate.Animation.Animate
public import Illuminate.Animation.Compile -- shake: keep
public meta import Illuminate.Animation.Render
public import Illuminate.Widget
import Lean.DocString.Syntax
public import Lean.Server.Rpc.Basic
public section


namespace Illuminate

/--
Wraps an animation render function for preview in the Lean InfoView via `#diagram`.

The returned function takes a time slider value and produces the diagram at that time,
allowing interactive scrubbing through the animation.
-/
def previewAnimation (steps : List Step)
    (render : Vector Float steps.length → Diagram SVG) :
    Slider "time" 0 (totalDuration steps) 0 → Diagram SVG :=
  fun time =>
    let progress := progressAt steps time
    let vec := progressVector progress steps.length
    render vec

/-!
# Animation widget
-/

open Lean Widget in
/-- VIR InfoView shell used to mount owned animation players. -/
@[widget_module]
meta def animateWidget : Lean.Widget.Module where
  javascript := include_str "../../../player_js/generated/animate_vir_widget.js"

/-!
# VIR asset RPC
-/

/-- Request for one staged VIR animation asset. -/
meta structure AnimationVirAssetRequest where
  /-- Repository-relative asset path. -/
  path : String
deriving Lean.Server.RpcEncodable

/-- Metadata for a staged VIR animation asset. -/
meta structure AnimationVirAssetInfo where
  /-- Repository-relative asset path. -/
  path : String
  /-- Revision token derived from file metadata. -/
  revision : String
  /-- Asset size in bytes. -/
  byteSize : String
deriving Lean.Server.RpcEncodable

/-- Staged VIR animation asset encoded for transport through the InfoView RPC channel. -/
meta structure AnimationVirAssetResponse extends AnimationVirAssetInfo where
  /-- Base64-encoded asset bytes. -/
  dataBase64 : String
deriving Lean.Server.RpcEncodable

private meta def animationVirWasmPath : String :=
  ".lake/build/vir/sdk/wasm/vir-upstream.wasm"

private meta def animationVirPackageSetDir : String :=
  ".lake/build/vir/module-sets/Illuminate/Animation"

private meta def animationVirPackageSetPath : String :=
  animationVirPackageSetDir ++ "/Vir.irpkg-set.json"

private meta def validAnimationVirPackagePath (path : String) : Bool :=
  path == animationVirPackageSetDir ++ "/Vir.irpkg" ||
    (path.startsWith (animationVirPackageSetDir ++ "/Vir.parts/") &&
      path.endsWith ".irpkg" &&
      (path.splitOn "/").all fun component =>
        component != "" && component != "." && component != "..")

private meta def validAnimationVirAsset (path : String) : Bool :=
  path == animationVirWasmPath ||
    path == animationVirPackageSetPath ||
    validAnimationVirPackagePath path

private meta def base64Char (value : Nat) : Char :=
  if value < 26 then Char.ofNat ('A'.toNat + value)
  else if value < 52 then Char.ofNat ('a'.toNat + value - 26)
  else if value < 62 then Char.ofNat ('0'.toNat + value - 52)
  else if value == 62 then '+'
  else '/'

private meta def base64Encode (bytes : ByteArray) : String := Id.run do
  let mut result := ""
  let mut index := 0
  while index + 2 < bytes.size do
    let first := bytes[index]!.toNat
    let second := bytes[index + 1]!.toNat
    let third := bytes[index + 2]!.toNat
    result := result.push (base64Char (first / 4))
    result := result.push (base64Char ((first % 4) * 16 + second / 16))
    result := result.push (base64Char ((second % 16) * 4 + third / 64))
    result := result.push (base64Char (third % 64))
    index := index + 3
  if index < bytes.size then
    let first := bytes[index]!.toNat
    result := result.push (base64Char (first / 4))
    if index + 1 < bytes.size then
      let second := bytes[index + 1]!.toNat
      result := result.push (base64Char ((first % 4) * 16 + second / 16))
      result := result.push (base64Char ((second % 16) * 4))
      result := result.push '='
    else
      result := result.push (base64Char ((first % 4) * 16))
      result := result.push '='
      result := result.push '='
  result

private meta def animationVirAssetInfo
    (path : String) : IO AnimationVirAssetInfo := do
  let metadata ← System.FilePath.metadata path
  pure {
    path
    revision := s!"{metadata.modified.sec}.{metadata.modified.nsec}:{metadata.byteSize}"
    byteSize := toString metadata.byteSize
  }

open Lean Server in
/-- Returns metadata for a staged VIR animation asset. -/
@[server_rpc_method]
meta def statAnimationVirAsset
    (request : AnimationVirAssetRequest) : RequestM (RequestTask AnimationVirAssetInfo) := do
  RequestM.asTask do
    unless validAnimationVirAsset request.path do
      throw (.mk .invalidParams "unknown VIR animation asset" : RequestError)
    animationVirAssetInfo request.path

open Lean Server in
/-- Reads a staged VIR animation asset for the InfoView player. -/
@[server_rpc_method]
meta def readAnimationVirAsset
    (request : AnimationVirAssetRequest) : RequestM (RequestTask AnimationVirAssetResponse) := do
  RequestM.asTask do
    unless validAnimationVirAsset request.path do
      throw (.mk .invalidParams "unknown VIR animation asset" : RequestError)
    let info ← animationVirAssetInfo request.path
    let bytes ← IO.FS.readBinFile request.path
    pure { info with dataBase64 := base64Encode bytes }

/-!
# #animate command
-/

/-- Syntax for the {lit}`#animate` command that plays an animation in the InfoView. -/
syntax (name := animateCmd) "#animate " ("(" &"fps" " := " num ") ")? term:max term : command

open Lean Widget Elab Command Term Meta in
/-- Elaborates the {kw}`#animate` command, compiling the animation and rendering it in the InfoView. -/
@[command_elab animateCmd]
meta unsafe def elabAnimateCmd : CommandElab := fun stx => do
  let fpsOpt := stx[1]
  let stepsStx : TSyntax `term := ⟨stx[2]⟩
  let renderStx : TSyntax `term := ⟨stx[3]⟩
  liftTermElabM do
    let compiledAnimTy := Lean.mkConst ``CompiledAnimation
    let fps : Nat := if fpsOpt.isNone then 60
      else fpsOpt[0][2].isNatLit?.getD 60
    let fpsLit := Syntax.mkNumLit (toString fps)
    let callStx ← ``(compileAnimation $stepsStx $renderStx (fps := $fpsLit))
    let e ← Term.elabTerm callStx (some compiledAnimTy)
    Term.synthesizeSyntheticMVarsNoPostponing
    let e ← instantiateMVars e
    let ca ← evalExpr CompiledAnimation compiledAnimTy e (safety := .unsafe)
    let animJson := compiledAnimationToLeanJson ca
    let props : Json := .mkObj [
      ("animData", animJson),
      ("wasmPath", .str animationVirWasmPath),
      ("packageSetPath", .str animationVirPackageSetPath),
      ("autoReloadMs", .num 1000)]
    savePanelWidgetInfo animateWidget.javascriptHash.val (pure props) stx
