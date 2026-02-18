@echo off
REM Start Cloudflare Tunnel for Oggy production hosting
REM This runs cloudflared natively (not in Docker) for reliable connectivity.
REM
REM Prerequisites:
REM   1. cloudflared installed: winget install Cloudflare.cloudflared
REM   2. hosts entry: 127.0.0.1 payments-service (in C:\Windows\System32\drivers\etc\hosts)
REM   3. Docker services running: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
REM   4. CLOUDFLARE_TUNNEL_TOKEN set in .env

REM Load token from .env
for /f "tokens=1,2 delims==" %%a in (.env) do (
    if "%%a"=="CLOUDFLARE_TUNNEL_TOKEN" set TUNNEL_TOKEN=%%b
)

if "%TUNNEL_TOKEN%"=="" (
    echo ERROR: CLOUDFLARE_TUNNEL_TOKEN not found in .env
    exit /b 1
)

echo Starting Cloudflare Tunnel for oggy-v1.com...
echo Press Ctrl+C to stop.
echo.

"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run --token %TUNNEL_TOKEN%
