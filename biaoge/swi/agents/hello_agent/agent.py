"""
HelloAgent — 框架验证Agent，每分钟输出心跳，验证全链路跑通。
"""
from datetime import datetime
from swi.core.agent_base import BaseAgent, AgentResult
from swi.core.event_types import Event, EventType


class HelloAgent(BaseAgent):
    """系统心跳Agent，验证框架全链路是否正常。"""

    agent_id = "hello"
    agent_name = "心跳检测"
    schedule = "*/5 * * * *"          # 每5分钟一次
    description = "框架验证Agent：定时发送心跳，确认调度→消息总线→钉钉通知全链路正常"

    _count = 0

    async def execute(self) -> AgentResult:
        self._count += 1
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        self.logger.info(f"心跳 #{self._count} @ {now}")

        # 发送通知（每24次心跳=每2小时发一次，避免太频繁）
        if self._count % 24 == 0:
            await self.notify(
                title="🦾 超级工作个体",
                content=f"系统运行正常 | 心跳 #{self._count} | {now}",
                priority=0,
            )

        # 发布心跳事件到消息总线
        event = Event(
            type=EventType.AGENT_RUN_COMPLETE,
            source_agent=self.agent_id,
            title=f"系统心跳 #{self._count}",
            summary=f"时间: {now} | 框架运行正常",
            data={"count": self._count, "timestamp": now},
            priority=0,
        )
        self.emit(event)

        return self.ok(
            summary=f"心跳 #{self._count} @ {now}",
            count=self._count,
            timestamp=now,
        )
