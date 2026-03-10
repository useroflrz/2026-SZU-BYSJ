@echo off
echo Starting Frontend Development Server...
echo.

REM 检查 node_modules 是否存在
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
    if errorlevel 1 (
        echo Error: Failed to install dependencies
        pause
        exit /b 1
    )
)

REM 启动开发服务器
echo Frontend server starting on http://localhost:3000
echo.
call npm run dev

pause

