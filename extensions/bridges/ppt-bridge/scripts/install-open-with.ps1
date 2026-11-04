<#
.SYNOPSIS
  把 DSH PPT 启动器注册到 Windows 的 .pptx「打开方式」列表（仅 HKCU，无需管理员）。

.DESCRIPTION
  只添加 OpenWithProgids，不修改 .pptx 的默认关联；PowerPoint 仍是默认程序。
  安装目录：%LOCALAPPDATA%\DSH\pptx-open
  注册后：右键 .pptx → 打开方式 → 选择其他应用 → DSH PPT 演示文稿。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/install-open-with.ps1
  powershell -ExecutionPolicy Bypass -File scripts/install-open-with.ps1 -Unregister
#>
param([switch]$Unregister)

$ErrorActionPreference = 'Stop'
$progId = 'DSH.PPTX'
$classes = 'HKCU:\Software\Classes'

if ($Unregister) {
  Remove-Item -Path "$classes\$progId" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path "$classes\.pptx\OpenWithProgids" -Name $progId -Force -ErrorAction SilentlyContinue
  Write-Host "已移除 DSH PPT 的「打开方式」注册。"
  exit 0
}

$workbench = (Resolve-Path (Join-Path $PSScriptRoot '..\plugin\dsh-ppt-workbench')).Path
$dataDir = Join-Path $workbench 'data'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$installDir = Join-Path $env:LOCALAPPDATA 'DSH\pptx-open'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot 'pptx-open.mjs') -Destination (Join-Path $installDir 'pptx-open.mjs') -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'pptx-open.vbs') -Destination (Join-Path $installDir 'pptx-open.vbs') -Force

$config = [ordered]@{
  workbenchDir = $workbench
  dataDir      = $dataDir
  relayUrl     = 'http://127.0.0.1:39311'
}
$json = $config | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $installDir 'config.json'), $json, (New-Object System.Text.UTF8Encoding($false)))

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$launcher = Join-Path $installDir 'pptx-open.vbs'
$command = '"' + $wscript + '" "' + $launcher + '" "%1"'

New-Item -Path "$classes\$progId\shell\open\command" -Force | Out-Null
Set-Item -Path "$classes\$progId" -Value 'DSH PPT 演示文稿'
Set-Item -Path "$classes\$progId\shell\open\command" -Value $command

New-Item -Path "$classes\.pptx\OpenWithProgids" -Force | Out-Null
New-ItemProperty -Path "$classes\.pptx\OpenWithProgids" -Name $progId -PropertyType String -Value '' -Force | Out-Null

Write-Host "✓ 已注册 DSH PPT 到 .pptx「打开方式」列表（未修改默认程序）。"
Write-Host "  启动器：$launcher"
Write-Host "  Workbench：$workbench"
Write-Host "  数据目录：$dataDir"
Write-Host ""
Write-Host "使用：右键 .pptx → 打开方式 → 选择其他应用 → DSH PPT 演示文稿。"
Write-Host "首次使用会启动 39311 relay；编辑后可在 DSH 会话里说“保存回原文件”。"
