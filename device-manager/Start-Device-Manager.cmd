@echo off
chcp 65001 >nul
rem Ensure the npm-installed OpenClaw shim is available even in a stale PATH.
set "PATH=%APPDATA%\npm;%PATH%"
rem Team-aligned OpenClaw profile. Keep the newer profile at %USERPROFILE%\.openclaw untouched.
set "OPENCLAW_STATE_DIR=%USERPROFILE%\.openclaw-2026.7.1-2\state"
set "OPENCLAW_CONFIG_PATH=%USERPROFILE%\.openclaw-2026.7.1-2\openclaw.json"
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

rem The device-manager Agent is created by the one-time agents add command
rem documented in README.md. Its workspace contains the device-manager
rem behavior rules and skills, so use that Agent id instead of the generic
rem onboarding Agent (dev).
rem Use a fresh session key after plugin/tool configuration changes. The old
rem `main` session can retain a stale tool snapshot from before authorization.
set "DEVICE_MANAGER_SESSION=agent:device-manager:main-v2"
openclaw tui --session %DEVICE_MANAGER_SESSION% --thinking off
if errorlevel 1 (
  echo.
  echo Unable to connect to OpenClaw Gateway.
  pause
)
