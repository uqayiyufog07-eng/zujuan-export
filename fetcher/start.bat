@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env" (
  echo [错误] 缺少 .env，请先复制 .env.example 为 .env 并填写 ZUJUAN_COOKIE 与 FETCH_KEY
  pause
  exit /b 1
)

echo [1/2] 启动本地抓取器 ...
start "zujuan-fetcher" /min node server.js

echo [2/2] 启动 Cloudflare Tunnel ...
cloudflared --config cloudflared-config.yml tunnel run zujuan-fetch

pause
