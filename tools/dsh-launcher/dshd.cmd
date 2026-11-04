@echo off
rem dshd — dsh + 插件全栈独立启动器（不依赖桌面前端）
rem 双击 = start --open --stack <仓库 dev 栈>；也可拖参数：dshd.cmd stop / status / doctor
rem （启动入口只有 --stack；旧的 dshd.config.json 配置路径已删除）
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "DEVSTACK=%HERE%..\..\launchpads\dev.dsh-stack.json"
if "%~1"=="" (
  node "%HERE%bin\dshd.mjs" start --open --stack "%DEVSTACK%"
) else (
  echo %* | find /i "--stack" >nul
  if errorlevel 1 (
    node "%HERE%bin\dshd.mjs" %* --stack "%DEVSTACK%"
  ) else (
    node "%HERE%bin\dshd.mjs" %*
  )
)
if errorlevel 1 pause
