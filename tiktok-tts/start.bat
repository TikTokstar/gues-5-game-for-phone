@echo off
title TikTok LIVE TTS
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node -e "process.exit(parseInt(process.version.slice(1),10)<20?1:0)"
if errorlevel 1 (
  echo Your Node.js is too old. Install the LTS version from https://nodejs.org and run this again.
  start "" https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing - only needed the first time...
  call npm install --omit=dev
  if errorlevel 1 (
    echo Install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

if /i "%~1"=="demo" (
  node server.js --demo --open
) else (
  node server.js --open
)
pause
