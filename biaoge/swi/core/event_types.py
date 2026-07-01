"""
事件类型枚举 - 消息总线上流通的事件定义。
Agent 可以发布事件，其他 Agent 或通知服务可以订阅。
"""
from enum import Enum
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


class EventType(str, Enum):
    """事件类型，按领域分类。"""
    # 系统事件
    SYSTEM_STARTUP = "system.startup"
    SYSTEM_SHUTDOWN = "system.shutdown"
    AGENT_ERROR = "agent.error"
    AGENT_RUN_COMPLETE = "agent.run_complete"

    # 广告
    AD_METRICS_ANOMALY = "ad.metrics_anomaly"
    AD_BUDGET_EXCEEDED = "ad.budget_exceeded"

    # 库存
    INVENTORY_LOW = "inventory.low"
    INVENTORY_CRITICAL = "inventory.critical"

    # 评价
    NEGATIVE_REVIEW = "review.negative"
    QA_UNANSWERED = "qa.unanswered"

    # 价格
    PRICE_MISMATCH = "price.mismatch"
    SELF_COMPETITION = "price.self_competition"

    # 报告
    DAILY_REPORT_READY = "report.daily_ready"
    WEEKLY_REPORT_READY = "report.weekly_ready"

    # 自定义 - 供后续 Agent 扩展
    CUSTOM = "custom"


@dataclass
class Event:
    """消息总线上流通的事件。"""
    type: EventType
    source_agent: str                          # 发布者的 agent_id
    timestamp: datetime = field(default_factory=datetime.now)
    title: str = ""                            # 简短标题，用于钉钉通知
    summary: str = ""                          # 人类可读摘要
    data: dict[str, Any] = field(default_factory=dict)  # 结构化数据
    priority: int = 0                          # 0=普通, 1=重要, 2=紧急

    @property
    def is_urgent(self) -> bool:
        return self.priority >= 2
