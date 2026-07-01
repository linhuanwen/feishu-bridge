"""
任务管理器 — 事项的增删改查 + 钉钉消息解析。
"""
import re
from datetime import datetime, timedelta
from typing import Optional
from loguru import logger
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from swi.data.models import Task


class TaskManager:
    """待办事项管理器。"""

    def __init__(self, session_factory):
        self._session_factory = session_factory

    # ─── 钉钉消息解析 ─────────────────────────

    def parse_dingtalk_msg(self, text: str) -> dict:
        """
        解析钉钉消息，识别用户意图。
        返回: {"action": "add"|"done"|"list"|"help", "content": ..., "deadline": "today"|"week"}
        """
        text = text.strip()

        # 帮助
        if text in ("帮助", "help", "?", "？"):
            return {"action": "help"}

        # 查看列表
        if text in ("列表", "待办", "还有啥", "list", "todo"):
            return {"action": "list"}

        # 广告相关
        if text in ("同步广告", "广告分析", "检查广告", "ad"):
            return {"action": "ad_sync"}

        # 查看报告
        if text in ("广告报告", "报告", "report"):
            return {"action": "ad_report"}

        # 完成某条: "完成 3" / "done 3" / "ok 3"
        m = re.match(r"(完成|done|ok|搞定|好了)\s*(\d+)", text, re.IGNORECASE)
        if m:
            return {"action": "done", "task_id": int(m.group(2))}

        # 删除: "删除 3" / "del 3"
        m = re.match(r"(删除|del|取消)\s*(\d+)", text, re.IGNORECASE)
        if m:
            return {"action": "delete", "task_id": int(m.group(2))}

        # 添加事项
        deadline = "today"
        content = text

        # 识别"本周"关键词
        week_keywords = ("本周", "这周", "星期", "周一", "周二", "周三", "周四", "周五", "周六", "周日", "下周")
        for kw in week_keywords:
            if kw in content:
                deadline = "week"
                content = content.replace(kw, "").strip()
                break

        # 识别"今天"关键词
        today_keywords = ("今天", "今日", "马上", "赶紧")
        for kw in today_keywords:
            if kw in content:
                deadline = "today"
                content = content.replace(kw, "").strip()
                break

        return {"action": "add", "content": content, "deadline": deadline}

    # ─── 数据库操作 ──────────────────────────

    async def add(self, content: str, deadline_type: str = "today",
                  source: str = "dingtalk") -> Task:
        """添加新任务。"""
        async with self._session_factory() as session:
            task = Task(
                content=content,
                deadline_type=deadline_type,
                source=source,
            )
            session.add(task)
            await session.commit()
            await session.refresh(task)
            logger.info(f"新增任务 #{task.id}: {content} [{deadline_type}]")
            return task

    async def mark_done(self, task_id: int) -> Optional[Task]:
        """标记任务为完成。"""
        async with self._session_factory() as session:
            task = await session.get(Task, task_id)
            if task:
                task.status = "done"
                task.completed_at = datetime.now()
                await session.commit()
                logger.info(f"任务 #{task_id} 已完成")
            return task

    async def delete(self, task_id: int) -> bool:
        """删除任务。"""
        async with self._session_factory() as session:
            task = await session.get(Task, task_id)
            if task:
                await session.delete(task)
                await session.commit()
                logger.info(f"任务 #{task_id} 已删除")
                return True
            return False

    async def list_pending(self) -> list[Task]:
        """获取所有未完成任务（今日优先，再本周）。"""
        async with self._session_factory() as session:
            result = await session.execute(
                select(Task)
                .where(Task.status == "pending")
                .order_by(
                    # 今日的排前面
                    Task.deadline_type == "today" and func._or(Task.deadline_type == "today")
                )
                .order_by(Task.created_at.desc())
            )
            return list(result.scalars().all())

    async def get_today_pending(self) -> list[Task]:
        """获取今日待办。"""
        return [t for t in await self.list_pending() if t.deadline_type == "today"]

    async def get_week_pending(self) -> list[Task]:
        """获取本周待办。"""
        return [t for t in await self.list_pending() if t.deadline_type == "week"]

    async def get_summary(self) -> str:
        """生成待办摘要，用于定时提醒。"""
        pending = await self.list_pending()
        if not pending:
            return "今天没有待办事项，去做更重要的事吧！"

        today_tasks = [t for t in pending if t.deadline_type == "today"]
        week_tasks = [t for t in pending if t.deadline_type == "week"]

        lines = []
        if today_tasks:
            lines.append(f"**今日 ({len(today_tasks)}件)**")
            for t in today_tasks:
                lines.append(f"  • [{t.id}] {t.content}")
        if week_tasks:
            lines.append(f"**本周 ({len(week_tasks)}件)**")
            for t in week_tasks:
                lines.append(f"  • [{t.id}] {t.content}")

        return "\n".join(lines)

    # ─── 处理钉钉消息 ─────────────────────────

    async def handle_dingtalk_msg(self, text: str) -> str:
        """
        处理一条钉钉消息，返回回复内容。
        """
        parsed = self.parse_dingtalk_msg(text)

        if parsed["action"] == "help":
            return (
                "**工作管家 - 使用说明**\n\n"
                "**事项记录**\n"
                "  发消息自动记录，加「本周」表示本周完成\n"
                "  例：`检查投影仪广告CTR`\n"
                "  例：`本周整理好评产品表`\n\n"
                "**完成任务**：`完成 编号`\n"
                "**查看列表**：`列表` 或 `待办`\n\n"
                "**广告监控**\n"
                "  发送 `同步广告` 立即分析\n"
                "  （需先将WB报表CSV放入 data/imports/）"
            )

        elif parsed["action"] == "list":
            summary = await self.get_summary()
            if not summary.strip():
                return "现在没有待办事项"
            return f"**待办事项**\n\n{summary}\n\n完成某条：发送 `完成 编号`"

        elif parsed["action"] == "add":
            task = await self.add(
                content=parsed["content"],
                deadline_type=parsed.get("deadline", "today"),
            )
            deadline_label = "今日" if task.deadline_type == "today" else "本周"
            return f"已记录 [{deadline_label}] #{task.id}: {parsed['content']}"

        elif parsed["action"] == "done":
            task = await self.mark_done(parsed["task_id"])
            if task:
                return f"已完成 #{task.id}: {task.content}"
            else:
                return f"没找到 #{parsed['task_id']}，发 `列表` 看看有哪些"

        elif parsed["action"] == "delete":
            ok = await self.delete(parsed["task_id"])
            if ok:
                return f"已删除 #{parsed['task_id']}"
            else:
                return f"没找到 #{parsed['task_id']}"

        return "没看懂你的意思，发 `帮助` 看用法"
