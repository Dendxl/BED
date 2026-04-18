@echo off
cd /d "%~dp0"
echo.
echo Starting Hospital Bed Finder (API + website).
echo Two windows will open - leave BOTH open while you use the browser.
echo.

start "HBF API 8088" cmd /k "%~dp0backend\_run-api.bat"

echo Waiting for API to finish installing / starting (about 5-15 sec first time)...
timeout /t 6 /nobreak >nul

start "HBF Web 8765" cmd /k "%~dp0_run-web.bat"

timeout /t 2 /nobreak >nul
start "" "http://localhost:8765/"

echo.
echo If the browser shows "connection refused", wait 10 seconds and press F5.
echo.
pause
