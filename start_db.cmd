@echo off
REM ============================================================
REM  BME - start the local development database
REM
REM  Double-click this, or run  pnpm start:db
REM
REM  Starts a Postgres container on port 5433, waits for it to be
REM  ready, and writes DATABASE_URL into .env for you. You do not
REM  need to edit .env by hand.
REM
REM  Nothing here deletes data. Stopping the container keeps the
REM  volume, so your database survives a restart.
REM ============================================================

cd /d "%~dp0"

echo.
echo   BME - starting local development database
echo.

where docker >nul 2>nul
if errorlevel 1 (
  echo   [X] Docker is not installed, or not on PATH.
  echo       Install Docker Desktop, then run this again.
  echo.
  pause
  exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
  echo   [X] Docker Desktop is installed but not running.
  echo       Start Docker Desktop, wait for the whale icon to stop
  echo       animating, then run this again.
  echo.
  pause
  exit /b 1
)

node scripts/dev-db.js up
if errorlevel 1 (
  echo.
  echo   [X] Could not start the database - see the messages above.
  echo.
  pause
  exit /b 1
)

echo.
echo   Done. If this is your first run, now do:
echo       pnpm migrate:deploy
echo       pnpm db:seed
echo   Or just run  pnpm setup  to do all of it in one go.
echo.
pause
