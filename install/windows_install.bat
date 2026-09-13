@echo off
setlocal
REM Setup only by default. --start explicitly starts the stored-wallet bot.
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..") do set "PROJECT_DIR=%%~fI"
cd /d "%PROJECT_DIR%" || exit /b 1
where node >nul 2>&1 || (echo Install Node.js 22.22.0 or newer first. & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<22))process.exit(1)"
if errorlevel 1 exit /b 1
call npm ci
if errorlevel 1 exit /b 1
echo Dependencies installed. Configure .env from .env.example and see README.
if not "%~1"=="--start" exit /b 0
if not exist ".env" (echo Create .env first. & exit /b 1)
where pm2 >nul 2>&1 || (echo Install PM2 explicitly or use npm start. & exit /b 1)
call npm run bootstrap
if errorlevel 1 exit /b 1
call pm2 describe hip-4-telegram-bot >nul 2>&1
if not errorlevel 1 (echo Existing PM2 process found; inspect and restart explicitly. & exit /b 1)
call pm2 start ecosystem.config.cjs
