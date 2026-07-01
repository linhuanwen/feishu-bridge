"""
调度器 — 基于 APScheduler，管理所有 Agent 的定时执行。
支持 SQLite 持久化（job状态重启后保留）。
"""
from datetime import datetime
from pathlib import Path
from loguru import logger
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.memory import MemoryJobStore
from apscheduler.triggers.cron import CronTrigger

from swi.core.agent_base import BaseAgent, AgentResult
from swi.core.message_bus import MessageBus
from swi.core.event_types import Event, EventType


class AgentScheduler:
    """
    Agent 调度器。
    - 从 agents.yaml 读取配置
    - 为每个启用的 Agent 注册 cron 任务
    - 记录每次运行结果到消息总线
    """

    def __init__(
        self,
        message_bus: MessageBus,
        db_path: str = "data/swi.db",
        timezone: str = "Asia/Shanghai",
    ):
        self.message_bus = message_bus
        self._agents: dict[str, BaseAgent] = {}
        self._timezone = timezone

        # 使用内存 JobStore（无需序列化，重启后从 agents.yaml 重新注册）
        jobstores = {
            "default": MemoryJobStore()
        }
        job_defaults = {
            "coalesce": True,
            "max_instances": 1,
            "misfire_grace_time": 60,
        }

        self._scheduler = AsyncIOScheduler(
            jobstores=jobstores,
            job_defaults=job_defaults,
            timezone=timezone,
        )

    # ─── Agent 管理 ──────────────────────────────

    def register(self, agent: BaseAgent, schedule: str = None):
        """注册一个 Agent 到调度器。"""
        agent_id = agent.agent_id
        cron_expr = schedule or agent.schedule

        if agent_id in self._agents:
            logger.warning(f"Agent [{agent_id}] 已注册，将被覆盖")

        self._agents[agent_id] = agent

        # 验证 cron 表达式
        try:
            CronTrigger.from_crontab(cron_expr, timezone=self._timezone)
        except Exception as e:
            logger.error(f"Agent [{agent_id}] cron表达式无效: {cron_expr} — {e}")
            return

        logger.info(f"注册 Agent: [{agent_id}] {agent.agent_name} | 调度: {cron_expr}")

    # ─── 生命周期 ──────────────────────────────

    async def start(self):
        """启动调度器，为所有已注册 Agent 添加 job。"""
        for agent_id, agent in self._agents.items():
            if not agent.enabled:
                logger.info(f"Agent [{agent_id}] 已禁用，跳过")
                continue

            self._scheduler.add_job(
                func=self._execute_agent,
                trigger=CronTrigger.from_crontab(agent.schedule, timezone=self._timezone),
                args=[agent_id],
                id=f"agent_{agent_id}",
                name=agent.agent_name,
                replace_existing=True,
            )

        self._scheduler.start()
        logger.info(f"调度器已启动 | {len(self._scheduler.get_jobs())} 个定时任务")

        # 发布系统启动事件
        self.message_bus.publish(Event(
            type=EventType.SYSTEM_STARTUP,
            source_agent="scheduler",
            title="系统已启动",
            summary=f"调度器启动，共 {len(self._scheduler.get_jobs())} 个Agent任务",
        ))

    async def stop(self):
        """停止调度器。"""
        try:
            self._scheduler.shutdown(wait=False)
        except Exception:
            # 调度器可能未启动
            pass
        logger.info("调度器已停止")

    # ─── 手动触发 ──────────────────────────────

    async def trigger(self, agent_id: str, **execute_kwargs) -> AgentResult:
        """手动触发一个 Agent 立即执行。可传递额外参数给 execute()。"""
        agent = self._agents.get(agent_id)
        if not agent:
            raise ValueError(f"Agent [{agent_id}] 未注册")

        logger.info(f"手动触发 Agent: [{agent_id}] {agent.agent_name}"
                    + (f" (kwargs: {execute_kwargs})" if execute_kwargs else ""))
        return await self._execute_agent(agent_id, **execute_kwargs)

    async def trigger_all(self) -> dict[str, AgentResult]:
        """手动触发所有已启用 Agent。"""
        results = {}
        for agent_id, agent in self._agents.items():
            if agent.enabled:
                results[agent_id] = await self._execute_agent(agent_id)
        return results

    def list_agents(self) -> list[dict]:
        """列出所有已注册的 Agent 及其状态。"""
        jobs = {j.id: j for j in self._scheduler.get_jobs()}
        result = []
        for agent_id, agent in self._agents.items():
            job_id = f"agent_{agent_id}"
            job = jobs.get(job_id)
            result.append({
                "agent_id": agent_id,
                "agent_name": agent.agent_name,
                "schedule": agent.schedule,
                "enabled": agent.enabled,
                "next_run": str(job.next_run_time) if job and job.next_run_time else None,
            })
        return result

    def get_agent(self, agent_id: str) -> BaseAgent | None:
        return self._agents.get(agent_id)

    # ─── 内部 ────────────────────────────────────

    async def _execute_agent(self, agent_id: str, **execute_kwargs) -> AgentResult:
        """执行单个 Agent 并记录结果（由 APScheduler 调用）。"""
        agent = self._agents.get(agent_id)
        if not agent:
            return AgentResult(agent_id=agent_id, status="error", error="Agent未找到")

        # 确保 Agent 已初始化
        if not getattr(agent, "_initialized", False):
            try:
                await agent.initialize()
                agent._initialized = True
            except Exception as e:
                logger.error(f"Agent [{agent_id}] 初始化失败: {e}")

        started_at = datetime.now()
        logger.info(f"▶ Agent [{agent_id}] {agent.agent_name} 开始执行"
                    + (f" (kwargs: {execute_kwargs})" if execute_kwargs else ""))

        try:
            result = await agent.execute(**execute_kwargs)
        except Exception as e:
            logger.exception(f"✖ Agent [{agent_id}] 执行异常: {e}")
            result = agent.fail(str(e))

        result.started_at = started_at
        result.completed_at = datetime.now()
        result.agent_id = agent_id

        elapsed = (result.completed_at - result.started_at).total_seconds()
        status_icon = {"success": "✓", "warning": "⚠", "error": "✖"}.get(result.status, "?")
        logger.info(
            f"{status_icon} Agent [{agent_id}] 完成 | "
            f"状态: {result.status} | 耗时: {elapsed:.1f}s | {result.summary}"
        )

        # 发布执行完成事件
        self.message_bus.publish(Event(
            type=EventType.AGENT_RUN_COMPLETE,
            source_agent=agent_id,
            title=f"{agent.agent_name} 执行完成",
            summary=result.summary,
            data={
                "agent_id": agent_id,
                "status": result.status,
                "elapsed": elapsed,
                "error": result.error,
            },
            priority=2 if result.status == "error" else 0,
        ))

        # 发布 Agent 自己产生的事件
        for event in result.events:
            self.message_bus.publish(event)

        return result
