"""
Agent 模板 — 新建 Agent 时复制此文件。

步骤:
  1. 复制本文件到 swi/agents/xxx_agent.py
  2. 修改 agent_id, agent_name, schedule
  3. 实现 execute() 方法
  4. 在 config/agents.yaml 中注册
"""
from swi.core.agent_base import BaseAgent, AgentResult


class TemplateAgent(BaseAgent):
    """模板 Agent，演示标准接口。"""

    agent_id = "template"
    agent_name = "模板Agent"
    schedule = "0 */6 * * *"        # 每6小时执行一次
    description = "这是一个模板，新建Agent时从这里复制"

    async def initialize(self) -> None:
        """启动时初始化（可选）。"""
        # 示例：初始化 API 客户端
        # self._client = SomeAPIClient(self._config.get("api_key"))
        await super().initialize()

    async def execute(self) -> AgentResult:
        """
        核心逻辑 — 必须实现。
        返回 AgentResult(status, summary, events, data)
        """
        # ─── 你的业务逻辑在这里 ───

        # 示例：获取数据、分析、判断
        data_value = self._config.get("some_param", "default_value")
        self.logger.info(f"执行检查, 参数: {data_value}")

        # ─── 条件判断 → 发事件/通知 ───
        # 示例：检测到异常时
        # from swi.core.event_types import Event, EventType
        # event = Event(
        #     type=EventType.CUSTOM,
        #     title="发现异常",
        #     summary="具体描述",
        #     priority=1,
        # )
        # self.emit(event)
        # await self.notify("⚠️ 告警", "具体内容")

        # ─── 返回结果 ───
        return self.ok(summary=f"检查完成, 参数={data_value}")

    async def on_event(self, event) -> None:
        """响应其他Agent的事件（可选）。"""
        # 示例：收到库存预警时做点什么
        # if event.type == EventType.INVENTORY_LOW:
        #     ...
        pass

    async def shutdown(self) -> None:
        """清理资源（可选）。"""
        await super().shutdown()
