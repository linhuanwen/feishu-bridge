@echo off
chcp 65001 >nul
echo =========================================
echo   超级工作个体 - 一键安装
echo =========================================
echo.

:: 检查 Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未找到 Python，请先安装 Python 3.12+
    echo 下载地址：https://www.python.org/downloads/
    pause
    exit /b 1
)
echo [OK] Python 已安装

:: 安装依赖
echo.
echo 安装依赖包...
pip install -r requirements.txt
if %errorlevel% neq 0 (
    echo [错误] 安装失败，请检查网络
    pause
    exit /b 1
)
echo [OK] 依赖安装完成

:: 初始化数据库
echo.
echo 初始化数据库...
python run.py init
echo.

echo =========================================
echo  安装完成！
echo =========================================
echo.
echo 下一步：
echo 1. 配置飞书：编辑 config/feishu.yaml
echo 2. 启动系统：python run.py start
echo 3. 查看状态：python run.py status
echo.
pause
