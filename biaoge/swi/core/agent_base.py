"""
Agent 抽象基类 — 所有智能体必须实现此接口。
接入新 Agent 三步：复制 _template.py → 实现 execute() → 注册到 agents.yaml
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional
from loguru import logger

from swi.core.event_types import Event


@dataclass
class AgentResult:
    """Agent 执行结果。"""
    agent_id: str
    status: str = "success"       # success / warning / error
    summary: str = ""             # 人类可读摘要
    events: list[Event] = field(default_factory=list)
    data: dict[str, Any] = field(default_factory=dict)
    started_at: datetime = field(default_factory=datetime.now)
    completed_at: Optional[datetime] = None
    error: Optional[str] = None   # 仅 status=error 时填充


class BaseAgent(ABC):
    """
    所有智能体的基类。

    子类必须提供：
      - agent_id: str      唯一标识符
      - agent_name: str    中文显示名称
      - schedule: str      cron 表达式
      - execute()          核心逻辑

    子类可选覆盖：
      - initialize()       启动时一次性初始化
      - on_event()         响应消息总线事件
      - shutdown()         清理资源
    """

    agent_id: str = "__undefined__"
    agent_name: str = "未命名Agent"
    schedule: str = "0 */6 * * *"   # 默认每6小时
    enabled: bool = True
    description: str = ""

    # 注入的外部依赖（由框架在注册时设置）
    _config: dict = {}
    _message_bus = None          # MessageBus 实例
    _notifier = None             # DingTalkNotifier 实例
    _db_session_factory = None   # SQLAlchemy async session factory

    def __init__(self, config: dict = None):
        self._config = config or {}
        self.logger = logger.bind(agent=self.agent_id)

    # ─── 生命周期 ─────────────────────────────────

    async def initialize(self) -> None:
        """启动时调用一次。可在此做 API 客户端初始化、数据预热等。"""
        self.logger.info(f"[{self.agent_name}] 初始化完成")

    @abstractmethod
    async def execute(self) -> AgentResult:
        """
        核心方法。调度器按 cron 触发。
        返回 AgentResult，包含执行状态、摘要、事件等。
        """
        ...

    async def on_event(self, event: Event) -> None:
        """
        收到消息总线事件时的回调。
        默认不做任何事。子类可按需覆盖。
        """
        pass

    async def shutdown(self) -> None:
        """关闭时清理资源。"""
        self.logger.info(f"[{self.agent_name}] 已关闭")

    # ─── 便捷方法 ─────────────────────────────────

    def emit(self, event: Event) -> None:
        """发布事件到消息总线。"""
        event.source_agent = self.agent_id
        if self._message_bus:
            self._message_bus.publish(event)
        else:
            self.logger.warning(f"消息总线未注入，事件未发送: {event.type}")

    async def notify(self, title: str, content: str, priority: int = 0) -> bool:
        """通过钉钉发送通知。如果 notifier 未注入则记录日志。"""
        if self._notifier:
            return await self._notifier.send_text(title, content, priority)
        else:
            self.logger.info(f"[通知] {title}: {content}")
            return False

    def ok(self, summary: str = "", **data) -> AgentResult:
        """快捷创建成功结果。"""
        return AgentResult(
            agent_id=self.agent_id,
            status="success",
            summary=summary,
            data=data,
            completed_at=datetime.now(),
        )

    def warn(self, summary: str, events: list[Event] = None, **data) -> AgentResult:
        """快捷创建警告结果。"""
        return AgentResult(
            agent_id=self.agent_id,
            status="warning",
            summary=summary,
            events=events or [],
            data=data,
            completed_at=datetime.now(),
        )

    def fail(self, error: str) -> AgentResult:
        """快捷创建失败结果。"""
        return AgentResult(
            agent_id=self.agent_id,
            status="error",
            error=error,
            summary=f"执行异常: {error}",
            completed_at=datetime.now(),
        )
