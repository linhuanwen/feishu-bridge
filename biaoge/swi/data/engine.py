"""
数据库引擎 — SQLAlchemy async + SQLite。
"""
from pathlib import Path
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from loguru import logger


# 全局引擎和会话工厂
_engine = None
_session_factory = None


def get_db_path(data_dir: str = "data") -> str:
    """获取数据库文件路径。"""
    db_dir = Path(data_dir)
    db_dir.mkdir(parents=True, exist_ok=True)
    return str(db_dir / "swi.db")


async def init_database(data_dir: str = "data", echo: bool = False) -> async_sessionmaker:
    """
    初始化数据库连接。
    返回 async_sessionmaker，用于创建会话。
    """
    global _engine, _session_factory

    db_path = get_db_path(data_dir)
    db_url = f"sqlite+aiosqlite:///{db_path}"

    _engine = create_async_engine(
        db_url,
        echo=echo,
        # SQLite 优化
        connect_args={
            "check_same_thread": False,  # 允许跨线程使用
        },
    )

    _session_factory = async_sessionmaker(
        _engine,
        class_=AsyncSession,
        expire_on_commit=False,
    )

    # 创建所有表
    from swi.data.models import Base
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    logger.info(f"数据库初始化完成: {db_path}")
    return _session_factory


async def get_session() -> AsyncSession:
    """获取一个新的数据库会话（上下文管理器）。"""
    if _session_factory is None:
        raise RuntimeError("数据库未初始化，请先调用 init_database()")
    return _session_factory()


async def close_database():
    """关闭数据库连接。"""
    global _engine
    if _engine:
        await _engine.dispose()
        _engine = None
        logger.info("数据库连接已关闭")
