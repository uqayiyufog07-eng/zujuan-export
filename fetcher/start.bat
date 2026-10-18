@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".env" (
  echo [错误] 缺少 .env，请先复制 .env.example 为 .env 并填写 ZUJUAN_COOKIE 与 FETCH_KEY
  pause
  exit /b 1
)

echo.
echo ============================================
echo   组卷网抓取器（本地出口 + Cloudflare Tunnel）
echo ============================================
echo.

echo [1/3] 启动本地抓取器（127.0.0.1:8788）...
start "zujuan-fetcher" /min node server.js
timeout /t 2 /nobreak >nul

set CFG=cloudflared-config.yml
set CRED=C:\Users\lenovo\.cloudflared\zujuan-fetch.json

if exist "%CFG%" if exist "%CRED%" (
  echo [2/3] 检测到命名隧道凭证，启动命名隧道...
  start "zujuan-tunnel" /min cloudflared --config "%CFG%" tunnel run zujuan-fetch
  echo.
  echo [3/3] 就绪！永久地址：https://fetch.laoqian303.top
  echo         Pages 变量配置：FETCHER_URL=https://fetch.laoqian303.top
  echo.
  echo 提示：保持本窗口所在的两个后台进程运行即可关闭本窗口；
  echo       结束抓取时在任务管理器结束 node.exe 与 cloudflared.exe。
) else (
  echo [2/3] 未检测到命名隧道凭证，使用临时隧道 Quick Tunnel。
  echo        URL 每次重启都会变，重启后需重新配置 Pages 变量 FETCHER_URL。
  echo.
  echo [3/3] 正在建立隧道，下面的日志里找到 https://xxxx.trycloudflare.com 即为地址...
  echo.
  cloudflared tunnel --url http://127.0.0.1:8788 --no-autoupdate
)

pause
