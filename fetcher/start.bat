@echo off
setlocal EnableExtensions
cd /d "%~dp0"

REM ============================================================
REM  Zujuan paper fetcher (local egress + Cloudflare Tunnel)
REM  NOTE: This file MUST stay pure ASCII. cmd.exe reads .bat as
REM  GBK; any Chinese text becomes garbage and gets executed as
REM  commands. Keep all messages in English.
REM ============================================================

if not exist ".env" (
  echo [ERROR] .env not found. Copy .env.example to .env and fill
  echo         ZUJUAN_COOKIE and FETCH_KEY first.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install Node 18+ and retry.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Zujuan Fetcher  ^(local egress + CF Tunnel^)
echo ============================================
echo.

REM ---- locate cloudflared ----
set "CFD="
where cloudflared >nul 2>nul && set "CFD=cloudflared"
if not defined CFD if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CFD=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CFD if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CFD=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CFD if exist "%LOCALAPPDATA%\Microsoft\WindowsApps\cloudflared.exe" set "CFD=%LOCALAPPDATA%\Microsoft\WindowsApps\cloudflared.exe"
if not defined CFD (
  echo [ERROR] cloudflared not found. Install it:
  echo         winget install Cloudflare.cloudflared
  pause
  exit /b 1
)

echo [1/3] Starting fetcher on 127.0.0.1:8788 ...
start "zujuan-fetcher" /min node server.js
timeout /t 2 /nobreak >nul

set "CFG=cloudflared-config.yml"
set "CREDDIR=%USERPROFILE%\.cloudflared"

REM ---- named tunnel if any credentials json exists (named by UUID) ----
set "HASCRED="
if exist "%CREDDIR%" for %%F in ("%CREDDIR%\*.json") do set "HASCRED=1"

if defined HASCRED if exist "%CFG%" (
  echo [2/3] Named tunnel credentials found, starting named tunnel...
  start "zujuan-tunnel" /min "%CFD%" --config "%CFG%" tunnel run zujuan-fetch
  echo.
  echo [3/3] READY - permanent URL:
  echo         https://fetch.laoqian303.top
  echo         Set Pages variable: FETCHER_URL=https://fetch.laoqian303.top
  echo.
  echo Keep this window open. To stop: close window and end
  echo node.exe / cloudflared.exe in Task Manager.
) else (
  echo [2/3] No named tunnel credentials, using QUICK tunnel ^(zero config^).
  echo        The URL is random each start - copy it from the log below
  echo        and set Pages variable FETCHER_URL after every restart.
  echo.
  echo [3/3] Establishing tunnel, look for the line:
  echo        https://xxxx-xxxx-xxxx.trycloudflare.com
  echo.
  "%CFD%" tunnel --url http://127.0.0.1:8788 --no-autoupdate
)

pause
