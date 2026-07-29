@echo off
setlocal
cd /d "%~dp0.."

call npm.cmd run train -- daily start
if errorlevel 1 goto failure

call npm.cmd run train -- workshop start
if errorlevel 1 goto failure

start "" "http://127.0.0.1:4500"
exit /b 0

:failure
echo.
echo Operator Engine did not start. Review the error above.
pause
exit /b 1
