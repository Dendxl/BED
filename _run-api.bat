@echo off
cd /d "%~dp0"
title HBF API - port 8088 (keep open)
echo API: http://127.0.0.1:8088
echo.

if not exist .venv\Scripts\python.exe (
  echo Creating .venv ...
  where py >nul 2>&1 && py -3 -m venv .venv || python -m venv .venv
  if errorlevel 1 (
    echo ERROR: Could not create venv. Install Python 3 and ensure py or python is on PATH.
    pause
    exit /b 1
  )
)

echo Updating packages...
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 (
  echo ERROR: pip install failed.
  pause
  exit /b 1
)

echo.
echo Starting uvicorn on port 8088 (NOT 8000 — the website expects 8088).
echo After startup, open: http://127.0.0.1:8088/docs
echo You should see /api/me/doctors and patient/chat routes. If /docs is on :8000 only, close that old server.
echo.
.venv\Scripts\python.exe -m uvicorn main:app --reload --host 127.0.0.1 --port 8088
echo.
echo API stopped.
pause
