@echo off
chcp 65001 >nul
cd /d "%~dp0agent-workspace"
echo Starting OpenClaw Device Manager Agent...
echo.

rem The Gateway is the local background service that the Agent connects to.
rem Start it only when port 18789 is not already available.
powershell -NoProfile -Command "if (-not (Test-NetConnection -ComputerName 127.0.0.1 -Port 18789 -InformationLevel Quiet)) { Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/c','openclaw gateway run' }"

rem Wait up to 10 seconds for the Gateway to become available.
powershell -NoProfile -Command "$deadline = (Get-Date).AddSeconds(10); while ((Get-Date) -lt $deadline) { if (Test-NetConnection -ComputerName 127.0.0.1 -Port 18789 -InformationLevel Quiet) { exit 0 }; Start-Sleep -Milliseconds 500 }; exit 1"
if errorlevel 1 (
  echo.
  echo OpenClaw Gateway did not start. Please run: openclaw gateway status
  pause
  exit /b 1
)

openclaw tui --session agent:device-manager:main --thinking off
if errorlevel 1 (
  echo.
  echo Unable to connect to OpenClaw Gateway.
  pause
)
