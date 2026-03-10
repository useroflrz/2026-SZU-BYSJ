@echo off
echo Starting Backend Server...
echo.

REM 激活 conda 环境
call conda activate gis3d-backend

REM 检查环境是否激活成功
if errorlevel 1 (
    echo Error: Failed to activate conda environment
    echo Please run: conda env create -f ../environment.yml
    pause
    exit /b 1
)

REM 启动服务
echo Backend server starting on http://localhost:8000
echo API docs available at http://localhost:8000/docs
echo.
python main.py

pause

