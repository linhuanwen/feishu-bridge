"""
日志配置 - 基于 loguru，零样板代码。
"""
import sys
from pathlib import Path
from loguru import logger


def setup_logging(log_level: str = "INFO", log_dir: str = "logs"):
    """初始化日志系统，同时输出到控制台和文件。"""
    logger.remove()  # 清除默认 handler

    log_path = Path(log_dir)
    log_path.mkdir(parents=True, exist_ok=True)

    # 控制台输出 - 彩色
    logger.add(
        sys.stderr,
        level=log_level,
        format=(
            "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
            "<level>{level: <8}</level> | "
            "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - "
            "<level>{message}</level>"
        ),
        colorize=True,
    )

    # 文件输出 - 按日轮转，保留30天
    logger.add(
        log_path / "swi_{time:YYYY-MM-DD}.log",
        level="DEBUG",
        format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {name}:{function}:{line} - {message}",
        rotation="00:00",
        retention="30 days",
        encoding="utf-8",
        enqueue=True,  # 多线程安全
    )

    # 错误日志单独文件
    logger.add(
        log_path / "error_{time:YYYY-MM-DD}.log",
        level="ERROR",
        format="{time:YYYY-MM-DD HH:mm:ss.SSS} | {level: <8} | {name}:{function}:{line} - {message}",
        rotation="00:00",
        retention="90 days",
        encoding="utf-8",
        enqueue=True,
    )

    logger.info(f"日志系统初始化完成 | 级别: {log_level} | 目录: {log_path.absolute()}")
    return logger
