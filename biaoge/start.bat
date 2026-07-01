@echo off
chcp 65001 >nul
title Biaoge SWI 服务
cd /d "%~dp0"

echo ============================================
echo   超级工作个体 (SWI) 服务
echo ============================================
echo.

:: 检查 Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Python，请先安装 Python 3.12+
    pause
    exit /b 1
)
echo [OK] Python 已就绪
echo.

:: 拼接当天日志路径
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value 2^>nul') do set "dt=%%I"
if "%dt%"=="" set "dt=2026-07-01"
set "today=%dt:~0,4%-%dt:~4,2%-%dt:~6,2%"
set "logdir=%~dp0logs"
set "logfile=%logdir%\swi_%today%.log"

if not exist "%logdir%" mkdir "%logdir%"

echo ============================================
echo   服务运行中 -- 请勿关闭此窗口
echo   按 Ctrl+C 停止所有服务
echo   日志文件: %logfile%
echo ============================================
echo.

:: ──── 直接前台运行（单窗口，简单可靠）────
python run.py start --dashboard 2>&1

echo.
echo ============================================
echo   SWI 服务已停止
echo ============================================
echo.
echo 按任意键关闭此窗口...
pause >nul
