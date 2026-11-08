@echo off
REM ============================================================
REM  XuanTie Foundry - one-click release build
REM  - puts MSYS2 ucrt64 GCC first on PATH (rust windows-gnu linker)
REM  - finds the updater signing key so the .sig gets produced
REM  Usage:  build.cmd            (from Explorer / cmd / PowerShell)
REM          set MSYS2_UCRT64=D:\other\ucrt64\bin  to override
REM ============================================================
setlocal

REM --- 1. toolchain: prefer env, else the default MSYS2 location ---
if defined MSYS2_UCRT64 (
  set "PATH=%MSYS2_UCRT64%;%PATH%"
) else (
  if exist "D:\MSYS2\ucrt64\bin\gcc.exe" set "PATH=D:\MSYS2\ucrt64\bin;%PATH%"
)

REM --- 2. updater signing key (empty password) ---
if not defined TAURI_SIGNING_PRIVATE_KEY (
  if exist "%USERPROFILE%\.tauri\xuantie-foundry.key" (
    set "TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\xuantie-foundry.key"
  )
)
if defined TAURI_SIGNING_PRIVATE_KEY (
  set "TAURI_SIGNING_PRIVATE_KEY_PASSWORD="
)

REM --- 3. report what will be used ---
echo [toolchain] gcc:
where gcc
if defined TAURI_SIGNING_PRIVATE_KEY (
  echo [signing]   key: %TAURI_SIGNING_PRIVATE_KEY%
) else (
  echo [signing]   NO KEY - build will fail at the sign step ^(set TAURI_SIGNING_PRIVATE_KEY^)
)

cd /d "%~dp0"
call npm run build:app %*
exit /b %ERRORLEVEL%
