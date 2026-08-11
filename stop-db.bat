@echo off
setlocal
cd /d "%~dp0"

echo Stopping SocialVoice database container...
docker compose down
if errorlevel 1 (
  echo Failed to stop database container.
  pause
  exit /b 1
)

echo Database container stopped.
