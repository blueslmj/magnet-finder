@echo off
rem ---------------------------------------------------------------
rem  ASCII ONLY.
rem  cmd.exe parses .bat files as system ANSI (GBK on zh-CN), NOT
rem  UTF-8, so a single non-ASCII byte here corrupts line parsing.
rem  All Chinese output is printed by node after chcp 65001 below.
rem ---------------------------------------------------------------
chcp 65001 >nul
title Magnet Search (LAN)

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
node cli\launch.js --lan

echo.
pause
