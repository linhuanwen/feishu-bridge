"""
数据库模型 — SQLAlchemy ORM 定义。
框架自带表：agent_run_log, notifications_log, events_log。
业务表随 Agent 逐步添加。
"""
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, Float, JSON, Boolean
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass


# ─── 框架自带表 ─────────────────────────────────────

class AgentRunLog(Base):
    """Agent 运行记录。"""
    __tablename__ = "agent_run_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    agent_id = Column(String(64), nullable=False, index=True)
    agent_name = Column(String(128))
    started_at = Column(DateTime, default=datetime.now)
    completed_at = Column(DateTime)
    status = Column(String(16))           # success / warning / error
    summary = Column(Text)
    error_detail = Column(Text)
    elapsed_seconds = Column(Float)
    data = Column(JSON)                   # 结构化数据


class NotificationLog(Base):
    """钉钉通知发送记录。"""
    __tablename__ = "notification_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    sent_at = Column(DateTime, default=datetime.now)
    msg_type = Column(String(32))         # text / markdown / actionCard
    title = Column(String(256))
    content_preview = Column(String(512)) # 内容前512字符
    priority = Column(Integer, default=0)
    delivery_status = Column(String(32))  # success / failed
    error_msg = Column(String(256))


class EventLog(Base):
    """消息总线事件记录。"""
    __tablename__ = "event_log"

    id = Column(Integer, primary_key=True, autoincrement=True)
    timestamp = Column(DateTime, default=datetime.now)
    event_type = Column(String(64), nullable=False, index=True)
    source_agent = Column(String(64), index=True)
    title = Column(String(256))
    summary = Column(Text)
    priority = Column(Integer, default=0)
    data = Column(JSON)


# ─── 事项管理 ─────────────────────────────────────

class Task(Base):
    """待办事项。通过钉钉或网页添加。"""
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, autoincrement=True)
    content = Column(Text, nullable=False)
    deadline_type = Column(String(16), default="today")  # today / week
    status = Column(String(16), default="pending")        # pending / done / cancelled
    source = Column(String(32), default="dingtalk")       # dingtalk / web / system
    created_at = Column(DateTime, default=datetime.now)
    completed_at = Column(DateTime)
    note = Column(Text)                                   # 额外备注
