@echo off
:: DSH + Capyclaw 插件一键部署（Windows 批处理版本）
:: 双击运行，自动完成所有配置

setlocal enabledelayedexpansion

echo.
echo ========================================
echo   DSH + Capyclaw 插件一键部署
echo ========================================
echo.

:: 检查 Node.js
echo [1/5] 检查 Node.js...
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js
    echo 请先安装: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%i in ('node --version') do set NODE_VERSION=%%i
echo       Node.js: %NODE_VERSION%

:: 检查/安装 pnpm
echo [2/5] 检查 pnpm...
pnpm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo       pnpm 未安装，正在安装...
    call npm install -g pnpm
    if %errorlevel% neq 0 (
        echo [错误] pnpm 安装失败
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%i in ('pnpm --version') do set PNPM_VERSION=%%i
echo       pnpm: %PNPM_VERSION%

:: 检查/安装 dsh
echo [3/5] 检查 dsh...
dsh --version >nul 2>&1
if %errorlevel% neq 0 (
    echo       dsh 未安装，正在从 npm 安装（需要几分钟）...
    call npm install -g @deepseek-ai/dsh
    if %errorlevel% neq 0 (
        echo [错误] dsh 安装失败
        pause
        exit /b 1
    )
)
for /f "tokens=*" %%i in ('dsh --version') do set DSH_VERSION=%%i
echo       dsh: %DSH_VERSION%

:: 下载部署脚本
echo [4/5] 准备部署脚本...
set SCRIPT_URL=https://raw.githubusercontent.com/YOUR_ORG/capyclaw-plugins/main/tools/bootstrap.mjs
set SCRIPT_PATH=%TEMP%\capyclaw-bootstrap.mjs

:: 如果本地有就用本地的，没有就尝试下载
if exist "%~dp0bootstrap.mjs" (
    echo       使用本地脚本: %~dp0bootstrap.mjs
    set SCRIPT_PATH=%~dp0bootstrap.mjs
) else (
    echo       下载部署脚本...
    powershell -Command "Invoke-WebRequest -Uri '%SCRIPT_URL%' -OutFile '%SCRIPT_PATH%'" >nul 2>&1
    if %errorlevel% neq 0 (
        echo [警告] 无法下载远程脚本，使用内联安装
        goto INLINE_INSTALL
    )
)

:: 运行部署脚本
echo [5/5] 安装 Capyclaw 插件...
node "%SCRIPT_PATH%" --plugins @capyclaw/launchpad,@capyclaw/plugin-sync,@capyclaw/port-sidebar --no-start
if %errorlevel% neq 0 (
    echo [错误] 插件安装失败
    pause
    exit /b 1
)

goto COMPLETE

:INLINE_INSTALL
:: 内联安装逻辑（不依赖外部脚本）
echo       直接安装到 profile...
set PROFILE_DIR=%USERPROFILE%\.dsh\profiles\web

if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"

:: 创建 package.json
if not exist "%PROFILE_DIR%\package.json" (
    echo {"name":"dsh-profile-web","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}} > "%PROFILE_DIR%\package.json"
)

:: 安装插件
cd /d "%PROFILE_DIR%"
call pnpm add @capyclaw/launchpad @capyclaw/plugin-sync @capyclaw/port-sidebar
if %errorlevel% neq 0 (
    echo [错误] 插件安装失败
    pause
    exit /b 1
)

:: 更新 bundles 列表（通过 Node.js）
node -e "const fs=require('fs');const p='package.json';const d=JSON.parse(fs.readFileSync(p,'utf8'));d.dsh.profile.bundles.push('@capyclaw/launchpad','@capyclaw/plugin-sync','@capyclaw/port-sidebar');fs.writeFileSync(p,JSON.stringify(d,null,2))"

:COMPLETE
echo.
echo ========================================
echo   部署完成！
echo ========================================
echo.
echo 已安装插件:
echo   - @capyclaw/launchpad (启动面板)
echo   - @capyclaw/plugin-sync (插件管理)
echo   - @capyclaw/port-sidebar (端口管理)
echo.
echo 启动命令: dsh --profile web
echo.

:: 询问是否立即启动
set /p START_NOW="是否立即启动 dsh? (Y/n): "
if /i "%START_NOW%"=="n" goto END
if /i "%START_NOW%"=="no" goto END

echo.
echo 正在启动 dsh...
echo 提示: 按 Ctrl+C 可停止
echo ========================================
echo.

dsh --profile web

:END
pause
