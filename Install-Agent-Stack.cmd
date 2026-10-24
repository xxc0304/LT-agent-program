@echo off
setlocal
set "INSTALLER=%~dp0deployment\Install-Agent-Stack.ps1"
if not exist "%INSTALLER%" (
  echo Could not find deployment\Install-Agent-Stack.ps1.
  echo Run this file from the extracted LT-agent-program package.
  pause
  exit /b 1
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%INSTALLER%" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo Deployment stopped with exit code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
