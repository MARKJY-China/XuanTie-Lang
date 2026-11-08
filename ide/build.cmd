@echo off
REM ============================================================
REM  XuanTie Foundry - one-click release build
REM  1) puts MSYS2 ucrt64 GCC first on PATH  (rust windows-gnu linker)
REM  2) finds the updater signing key        (empty password)
REM  3) builds with stdin redirected from NUL
REM
REM  Usage: build.cmd              (Explorer / cmd / PowerShell)
REM         build.cmd -DryRun      (only print what would be used)
REM         set MSYS2_UCRT64=...   (override the ucrt64 bin dir)
REM
REM  Why "< nul": Windows cannot store an EMPTY env variable, so
REM  TAURI_SIGNING_PRIVATE_KEY_PASSWORD can only be "absent"; in a terminal
REM  the CLI then PROMPTS for a password and blocks. With stdin on NUL it
REM  falls back to "assuming an empty password" (which is what our key has).
REM ============================================================
setlocal

REM --- 1. toolchain ---
if defined MSYS2_UCRT64 (
  set "PATH=%MSYS2_UCRT64%;%PATH%"
) else (
  if exist "D:\MSYS2\ucrt64\bin\gcc.exe" set "PATH=D:\MSYS2\ucrt64\bin;%PATH%"
)

REM --- 2. signing key (empty password) ---
if not defined TAURI_SIGNING_PRIVATE_KEY (
  if exist "%USERPROFILE%\.tauri\xuantie-foundry.key" (
    set "TAURI_SIGNING_PRIVATE_KEY=%USERPROFILE%\.tauri\xuantie-foundry.key"
  )
)

REM --- 3. report ---
echo [toolchain] gcc:
where gcc
if defined TAURI_SIGNING_PRIVATE_KEY (
  echo [signing]   key: %TAURI_SIGNING_PRIVATE_KEY%  ^(password: empty^)
) else (
  echo [signing]   WARNING: no private key found; build will fail at the signing step
)

if /I "%~1"=="-DryRun" (
  echo [dry-run]   stop here, nothing built
  exit /b 0
)

REM --- 4. build (stdin from NUL: see header) ---
cd /d "%~dp0"
call npm run build:app %* < nul
exit /b %ERRORLEVEL%
