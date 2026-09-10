@echo off
title Install OpenClaw
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-OpenClaw-Host.ps1"
exit /b %ERRORLEVEL%
