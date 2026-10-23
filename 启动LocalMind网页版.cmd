@echo off
setlocal
cd /d "%~dp0"
if not exist "dist\server\index.mjs" (
  echo LocalMind web build not found. Run: pnpm install ^&^& pnpm build
  pause
  exit /b 1
)
set "LOCALMIND_PORT=8787"
start "LocalMind Server" cmd /k "cd /d %~dp0 && node dist\server\index.mjs"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8787"
endlocal