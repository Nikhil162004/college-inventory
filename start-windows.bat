@echo off
setlocal
cd /d "%~dp0"
title Inventory Register
chcp 65001 >nul

if not exist "scripts\laptop.js" goto notunpacked
where node >nul 2>nul
if errorlevel 1 goto nonode

node scripts\laptop.js
goto end

:notunpacked
echo.
echo This file was started from inside the zip file.
echo Right-click the zip, choose "Extract All", open the new folder
echo and double-click start-windows.bat there.
goto end

:nonode
echo.
echo Node.js is not installed on this computer yet.
echo.
echo  1. Open https://nodejs.org and download the LTS version.
echo  2. Run the installer and keep every default.
echo  3. Double-click this file again.
goto end

:end
echo.
pause
