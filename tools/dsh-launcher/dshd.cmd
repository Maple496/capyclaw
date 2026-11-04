@echo off
rem dshd — dsh + 插件全栈独立启动器（不依赖桌面前端）
rem 双击 = start --open；也可拖参数：dshd.cmd stop / status / doctor
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
if "%~1"=="" (
  node "%HERE%bin\dshd.mjs" start --open
) else (
  node "%HERE%bin\dshd.mjs" %*
)
if errorlevel 1 pause
