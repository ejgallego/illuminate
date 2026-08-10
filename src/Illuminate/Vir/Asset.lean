/-
Copyright (c) 2026 Lean FRO LLC. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Author: Emilio J. Gallego Arias
-/
module
public meta import Lean.Server.Rpc.RequestHandling
import Lean.DocString.Syntax
public import Lean.Server.Rpc.Basic
public section

namespace Illuminate

/-- Request for one staged VIR asset. -/
meta structure VirAssetRequest where
  /-- Repository-relative asset path. -/
  path : String
deriving Lean.Server.RpcEncodable

/-- Metadata for a staged VIR asset. -/
meta structure VirAssetInfo where
  /-- Repository-relative asset path. -/
  path : String
  /-- Revision token derived from file metadata. -/
  revision : String
  /-- Asset size in bytes. -/
  byteSize : String
deriving Lean.Server.RpcEncodable

/-- Staged VIR asset encoded for transport through the InfoView RPC channel. -/
meta structure VirAssetResponse extends VirAssetInfo where
  /-- Base64-encoded asset bytes. -/
  dataBase64 : String
deriving Lean.Server.RpcEncodable

/-- Repository-relative path of the staged VIR runtime Wasm module. -/
meta def virWasmAssetPath : String :=
  ".lake/build/vir/sdk/wasm/vir-upstream.wasm"

/-- Repository-relative path of the staged VIR animation package set. -/
meta def virAnimationPackageSetAssetPath : String :=
  ".lake/build/vir/module-sets/Illuminate/Animation/Vir.irpkg-set.json"

/-- Repository-relative path of the staged VIR HitScene package set. -/
meta def virHitScenePackageSetAssetPath : String :=
  ".lake/build/vir/module-sets/Illuminate/Diagram/HitScene/Vir.irpkg-set.json"

private meta def virPackageSetDirs : Array String := #[
  ".lake/build/vir/module-sets/Illuminate/Animation",
  ".lake/build/vir/module-sets/Illuminate/Diagram/HitScene"
]

private meta def validVirPackagePathIn (directory path : String) : Bool :=
  path == directory ++ "/Vir.irpkg" ||
    (path.startsWith (directory ++ "/Vir.parts/") &&
      path.endsWith ".irpkg" &&
      (path.splitOn "/").all fun component =>
        component != "" && component != "." && component != "..")

private meta def validVirAsset (path : String) : Bool :=
  path == virWasmAssetPath ||
    path == virAnimationPackageSetAssetPath ||
    path == virHitScenePackageSetAssetPath ||
    virPackageSetDirs.any fun directory => validVirPackagePathIn directory path

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

private meta def virAssetInfo (path : String) : IO VirAssetInfo := do
  let metadata ← System.FilePath.metadata path
  pure {
    path
    revision := s!"{metadata.modified.sec}.{metadata.modified.nsec}:{metadata.byteSize}"
    byteSize := toString metadata.byteSize
  }

open Lean Server in
/-- Returns metadata for an allowlisted staged VIR asset. -/
@[server_rpc_method]
meta def statVirAsset (request : VirAssetRequest) : RequestM (RequestTask VirAssetInfo) := do
  RequestM.asTask do
    unless validVirAsset request.path do
      throw (.mk .invalidParams "unknown VIR asset" : RequestError)
    virAssetInfo request.path

open Lean Server in
/-- Reads an allowlisted staged VIR asset for an InfoView runtime. -/
@[server_rpc_method]
meta def readVirAsset (request : VirAssetRequest) : RequestM (RequestTask VirAssetResponse) := do
  RequestM.asTask do
    unless validVirAsset request.path do
      throw (.mk .invalidParams "unknown VIR asset" : RequestError)
    let info ← virAssetInfo request.path
    let bytes ← IO.FS.readBinFile request.path
    pure { info with dataBase64 := base64Encode bytes }
