@echo off
title Kwerry
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Dev port assignment. The API script (npm run dev:api) pins the API to
REM 8766 and Vite serves the UI on 8767; vite.config.mjs proxies /api to 8766.
set "API_PORT=8766"
set "UI_PORT=8767"

echo Kwerry dev — API :!API_PORT!  UI :!UI_PORT!

REM Kill anything still holding these ports plus the leftover dev windows
REM from the previous run, so a stale server cannot keep serving a dead build.
call :killPort "!API_PORT!"
call :killPort "!UI_PORT!"
for /f "tokens=5" %%a in ('tasklist /v /fo list 2^>nul ^| findstr /i "Kwerry API Kwerry UI"') do taskkill /f /pid %%a >nul 2>&1
timeout /t 1 >nul

REM If a port is still held (privileged process, slow teardown), step up.
call :bump UI_PORT
call :bump API_PORT

start "Kwerry API" cmd /k "npm run dev:api"
start "Kwerry UI" cmd /k "npx vite --port !UI_PORT! --strictPort"

timeout /t 4 >nul
start http://localhost:!UI_PORT!
endlocal
exit /b


:killPort
REM %1 = port. Frees it by PID; silent when nothing is listening.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%~1" ^| findstr LISTENING') do (
    taskkill /f /pid %%a >nul 2>&1
)
exit /b


:bump
REM %1 = var name holding a port. Increments it while in use, up to 5 tries.
set "var=%~1"
set "port=!%var%!"
for /l %%i in (1,1,5) do (
    netstat -ano | findstr ":!port!" | findstr LISTENING >nul
    if errorlevel 1 goto :bumped
    set /a port+=1
)
:bumped
set "!var!=!port!"
exit /b
