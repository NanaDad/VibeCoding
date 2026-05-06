@echo off
setlocal enableextensions

set "ROOT_DIR=%~dp0"
set "APP_DIR=%ROOT_DIR%app"
set "LOG_FILE=%ROOT_DIR%launcher.log"

if exist "%LOG_FILE%" del /f /q "%LOG_FILE%" >nul 2>nul
call :log ==================================================
call :log JP-KO Translator launcher started
call :log Root: %ROOT_DIR%
call :log App: %APP_DIR%
call :log ==================================================

echo JP-KO Translator launcher
echo Logs: launcher.log
echo.

if not exist "%APP_DIR%\package.json" (
  call :fail "app\package.json is missing. Please extract the entire zip before launching."
)

if not exist "%APP_DIR%\dist\index.html" (
  call :fail "Renderer build is missing: app\dist\index.html"
)

if not exist "%APP_DIR%\dist-electron\main\main.js" (
  call :fail "Electron main build is missing: app\dist-electron\main\main.js"
)

where node >nul 2>nul
if errorlevel 1 (
  call :fail "Node.js was not found in PATH. Install Node.js LTS first, then run JP-KO Translator.cmd again."
)

where npm >nul 2>nul
if errorlevel 1 (
  call :fail "npm was not found in PATH. Install Node.js LTS first, then run JP-KO Translator.cmd again."
)

pushd "%APP_DIR%" >nul
if errorlevel 1 (
  call :fail "Could not enter the app directory."
)

call :log Working directory changed to %CD%

if not exist node_modules (
  echo Installing runtime dependencies...
  call :log Running npm install
  call npm.cmd install >> "%LOG_FILE%" 2>&1
  if errorlevel 1 (
    popd >nul
    call :fail "npm install failed. See launcher.log for details."
  )
) else (
  call :log node_modules already exists, skipping npm install
)

echo Translation provider is chosen inside the app settings UI.
echo Starting Electron app...
echo.
call :log Running npm start
call npm.cmd start >> "%LOG_FILE%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
popd >nul

if not "%EXIT_CODE%"=="0" (
  call :fail "The app exited with code %EXIT_CODE%. See launcher.log for details."
)

call :log npm start exited successfully
endlocal
exit /b 0

:log
echo [%date% %time%] %*>> "%LOG_FILE%"
exit /b 0

:fail
call :log ERROR: %~1
echo.
echo ERROR: %~1
echo Check launcher.log next to this file.
echo.
pause
endlocal
exit /b 1
