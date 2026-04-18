@echo off
cd /d "%~dp0"
title HBF Website - port 8765 (keep open)
echo Serving folder: %CD%
echo Open: http://localhost:8765/
echo.

where py >nul 2>&1 && py -3 -m http.server 8765 && goto :done
python -m http.server 8765 && goto :done

echo ERROR: Could not run Python. Install Python and enable "Add to PATH", or install the "py" launcher.
pause
exit /b 1

:done
echo.
echo Web server stopped.
pause
