#!/usr/bin/env python3
"""
超级工作个体 — 统一入口
用法:
    python run.py start       启动系统
    python run.py status      查看状态
    python run.py trigger <id> 手动触发Agent
    python run.py init        初始化数据库
    python run.py test-msg    测试钉钉消息
"""
import sys
from pathlib import Path

# 确保项目根目录在 Python path 中
PROJECT_DIR = Path(__file__).parent
sys.path.insert(0, str(PROJECT_DIR))

from swi.cli.main import cli

if __name__ == "__main__":
    cli()
