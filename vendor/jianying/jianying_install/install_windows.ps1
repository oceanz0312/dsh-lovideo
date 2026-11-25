# lovideo -> 剪映专业版 (Windows) 一键导入。用法：双击 install_windows.bat，或
#   powershell -ExecutionPolicy Bypass -File install_windows.ps1 [-Name 草稿名]
param([string]$Name = ("lovideo_" + (Get-Date -Format "MMdd_HHmmss")))
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Src = Join-Path $Here "lovideo_timeline"
$PH = "##_draftpath_placeholder_0E685133-18CE-45ED-8CB8-2904A212EC80_##"
$RPH = "##_lovideo_draft_root_##"
if (-not (Test-Path $Src)) { throw "找不到 $Src（请先解压 zip）" }
$Root = $env:JIANYING_DRAFT_ROOT
if (-not $Root) {
  $setting = Join-Path $env:LOCALAPPDATA "JianyingPro\User Data\Config\globalSetting"
  if (Test-Path $setting) {
    $m = Select-String -Path $setting -Pattern '^currentCustomDraftPath=(.+)$' | Select-Object -First 1
    if ($m) { $Root = $m.Matches[0].Groups[1].Value.Trim() }
  }
}
if (-not $Root) { $Root = Join-Path $env:LOCALAPPDATA "JianyingPro\User Data\Projects\com.lveditor.draft" }
if (-not (Test-Path $Root)) { throw "找不到剪映草稿目录：$Root（请先安装并打开一次剪映专业版）" }
if ($Name -match '[\\/:*?"<>|]') { throw "草稿名不合法：$Name" }
$Dest = Join-Path $Root $Name
if (Test-Path $Dest) { throw "已存在同名草稿：$Dest，请换个名字" }
if (Get-Process -Name JianyingPro -ErrorAction SilentlyContinue) {
  Write-Host "提示：剪映正在运行，建议先退出再导入，导入后重新打开剪映。"
}
Copy-Item -Recurse $Src $Dest
$DestJ = ($Dest -replace '\\', '/'); $RootJ = ($Root -replace '\\', '/')
$utf8 = New-Object System.Text.UTF8Encoding $false
foreach ($f in @("draft_info.json", "draft_content.json", "template-2.tmp", "draft_meta_info.json")) {
  $p = Join-Path $Dest $f
  if (-not (Test-Path $p)) { continue }
  $s = [IO.File]::ReadAllText($p, $utf8).Replace($PH, $DestJ).Replace($RPH, $RootJ)
  if ($f -eq "draft_meta_info.json") {
    $nameJson = ($Name | ConvertTo-Json)
    $s = [regex]::Replace($s, '"draft_name":\s*"[^"]*"', ('"draft_name": ' + $nameJson))
  }
  [IO.File]::WriteAllText($p, $s, $utf8)
}
Write-Host "已导入：$Dest"
Write-Host "请重新打开剪映专业版，在草稿列表中找到「$Name」。"
