@echo off
setlocal
cd /d "%~dp0"

echo Starting SocialVoice Backend...

where docker >nul 2>nul
if errorlevel 1 (
  echo.
  echo Docker CLI not found. Install Docker Desktop, then retry.
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo.
  echo Docker Desktop is not running. Please start Docker Desktop and retry.
  pause
  exit /b 1
)

echo Checking local database container...
docker compose up -d
if errorlevel 1 (
  echo.
  echo Failed to start database container. Review docker output above.
  pause
  exit /b 1
)

set DB_READY=0
for /L %%i in (1,1,20) do (
  docker exec socialvoice-postgres pg_isready -U postgres -d socialvoice >nul 2>nul
  if not errorlevel 1 (
    set DB_READY=1
    goto :db_ready
  )
  echo Waiting for PostgreSQL to become ready... attempt %%i/20
  timeout /t 2 >nul
)

:db_ready
if "%DB_READY%"=="0" (
  echo.
  echo PostgreSQL container did not become ready in time.
  pause
  exit /b 1
)

echo Database is ready. Launching backend server...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-dev.ps1"

if errorlevel 1 (
  echo.
  echo Backend exited with error. Check output above for details.
  pause
)
