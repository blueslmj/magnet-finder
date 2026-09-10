@echo off
rem ---------------------------------------------------------------
rem  ASCII ONLY.
rem  cmd.exe parses .bat files as system ANSI (GBK here), NOT UTF-8,
rem  so any non-ASCII byte here corrupts line parsing. All Chinese
rem  messages are printed by node (UTF-8) after chcp 65001 below.
rem ---------------------------------------------------------------
chcp 65001 >nul
title Magnet Search

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found / Node.js not installed.
  echo   Install it first: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"
node cli\launch.js

echo.
pause
