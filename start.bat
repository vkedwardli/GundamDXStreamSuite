@echo off
echo Starting OBS MultiStream Fusion server...

REM Set Node.js environment variables by calling nodevars.bat
call "C:\Program Files\nodejs\nodevars.bat"

REM Change to your project directory
cd /d "%~dp0"

REM Start your Node.js application
node index.js

cmd /k