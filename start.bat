@echo off
cd /d "%~dp0"
echo.
echo Hospital Bed Finder - website only (port 8765)
echo For staff login you also need the API: run start-all.bat or backend\_run-api.bat
echo.
start "HBF Web 8765" cmd /k "%~dp0_run-web.bat"
timeout /t 2 /nobreak >nul
start "" "http://localhost:8765/"
echo.
pause
