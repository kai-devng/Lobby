@echo off
rem One-click start: makes sure the local Lobby server is running, then opens the Lobby app.
cd /d "%~dp0"

if not exist "server\node_modules" (
  echo First run: installing server files...
  pushd server & call npm install --no-audit --no-fund & popd
)
if not exist "client\node_modules\electron\dist\electron.exe" (
  echo First run: installing app files...
  pushd client & call npm install --no-audit --no-fund & popd
)

rem Start the server minimized unless it's already running on port 47420.
powershell -NoProfile -Command "if (Get-NetTCPConnection -State Listen -LocalPort 47420 -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }"
if %errorlevel%==0 start "Lobby Server" /min cmd /c "cd /d "%~dp0server" && node src\index.js"

start "" "%~dp0client\node_modules\electron\dist\electron.exe" "%~dp0client" %*
