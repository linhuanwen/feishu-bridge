"""
Runner — 系统生命周期管理器。
负责初始化所有组件、注入依赖、启动/停止。
"""
import importlib
import pkgutil
from pathlib import Path
from loguru import logger

from swi.core.config_loader import ConfigManager
from swi.core.message_bus import MessageBus
from swi.core.scheduler import AgentScheduler
from swi.core.agent_base import BaseAgent, AgentResult
from swi.integrations.dingtalk.bot import DingTalkNotifier, DingTalkConfig
from swi.integrations.desktop.notifier import DesktopNotifier, DesktopNotifyConfig
from swi.integrations.multi_notifier import MultiNotifier
from swi.utils.logging_setup import setup_logging
from swi.services.task_manager import TaskManager


class Runner:
    """系统主控。初始化所有组件并管理生命周期。"""

    def __init__(self, project_dir: Path):
        self.project_dir = Path(project_dir).resolve()
        self.config = None
        self.message_bus = None
        self.scheduler = None
        self.notifier = None
        self.task_manager = None
        self.feishu_client = None
        self._session_factory = None
        self._initialized = False
        self._cloudflared_process = None

    async def initialize(self, init_db: bool = True):
        """初始化所有组件。"""
        if self._initialized:
            return

        # 1. 加载配置
        self.config = ConfigManager(self.project_dir)

        # 2. 日志系统
        setup_logging(
            log_level=self.config.settings.log_level,
            log_dir=str(self.config.log_dir),
        )
        logger.info(f"项目目录: {self.project_dir}")
        logger.info(f"配置目录: {self.config.config_dir}")

        # 3. 消息总线
        self.message_bus = MessageBus()
        await self.message_bus.start()

        # 4. 多通道通知器
        self.notifier = MultiNotifier()

        # 4a. 桌面通知（总是可用）
        desktop_cfg = DesktopNotifyConfig(enabled=True)
        self.desktop_notifier = DesktopNotifier(desktop_cfg)
        self.notifier.add("desktop", self.desktop_notifier)

        # 4b. 钉钉通知（需配置 webhook_url，支持加签）
        dingtalk_cfg = DingTalkConfig(
            webhook_url=self.config.dingtalk.webhook_url,
            secret=self.config.dingtalk.secret,
            enabled=self.config.dingtalk.enabled,
            rate_limit_per_minute=self.config.dingtalk.rate_limit_per_minute,
            retry_times=self.config.dingtalk.retry_times,
            retry_seconds=self.config.dingtalk.retry_seconds,
        )
        self.dingtalk_notifier = DingTalkNotifier(dingtalk_cfg)
        self.notifier.add("dingtalk", self.dingtalk_notifier)

        # 4c. 飞书客户端（从 feishu.yaml 读取凭证）
        from swi.integrations.feishu.bot import FeishuClient, FeishuConfig
        feishu_cfg = FeishuConfig(
            app_id=self.config.feishu.app_id,
            app_secret=self.config.feishu.app_secret,
            webhook_url=self.config.feishu.webhook_url,
        )
        self.feishu_client = FeishuClient(feishu_cfg)

        # 4d. 飞书通知器（接入 MultiNotifier）
        from swi.integrations.feishu.notifier import FeishuNotifier
        self.feishu_notifier = FeishuNotifier(
            self.feishu_client,
            target_chat_name=self.config.feishu.target_chat_name,
            target_chat_id=self.config.feishu.target_chat_id,
            chat_app_id=self.config.feishu.chat_app_id,
            chat_app_secret=self.config.feishu.chat_app_secret,
        )
        self.notifier.add("feishu", self.feishu_notifier)

        # 飞书 WebSocket 消息接收 — 默认关闭。
        # 原因: lark-oapi WS client + nest_asyncio + uvicorn 在 Windows 上存在
        # 底层事件循环冲突（exit code 139 / access violation）。
        # feishu-bridge 已通过 HTTP API 转发所有命令，WS 非必需。
        # 如需启用，在 agents.yaml 或 feishu.yaml 中设置 ws_enabled: true
        self.feishu_ws = None
        logger.info("飞书 WebSocket 已禁用（消息由 feishu-bridge HTTP API 转发）")

        target_info = ""
        if self.config.feishu.target_chat_name:
            target_info = f"，目标群「{self.config.feishu.target_chat_name}」"
        logger.info(
            f"通知通道: 桌面={desktop_cfg.enabled}, "
            f"钉钉={'已配置' if dingtalk_cfg.webhook_url else '未配置'}, "
            f"飞书={'已配置' if self.config.feishu.webhook_url else '未配置'}{target_info}"
        )

        # 5. 数据库（可选）
        if init_db:
            from swi.data.engine import init_database
            self._session_factory = await init_database(
                data_dir=str(self.config.data_dir)
            )

        # 5b. 任务管理器
        if self._session_factory:
            self.task_manager = TaskManager(self._session_factory)

        # 6. 调度器
        self.scheduler = AgentScheduler(
            message_bus=self.message_bus,
            db_path=str(self.config.data_dir / "swi.db"),
            timezone=self.config.settings.scheduler_timezone,
        )

        # 7. 自动发现并注册 Agent
        self._discover_agents()

        # 8. 注册事件处理器：agent 错误 → 通知
        self.message_bus.subscribe("agent.run_complete", self._on_agent_run_complete)

        self._initialized = True
        logger.info("Runner 初始化完成")

    def _discover_agents(self):
        """自动发现 swi/agents/ 目录下所有 Agent（每个Agent一个子文件夹）。"""
        import swi.agents as agents_pkg

        agent_count = 0
        # 遍历 agents/ 下的子文件夹（每个文件夹是一个 Agent）
        for _, agent_name, is_pkg in pkgutil.iter_modules(agents_pkg.__path__):
            # 跳过非包（非文件夹）、下划线开头的（_template等）
            if not is_pkg or agent_name.startswith("_"):
                continue
            try:
                # 每个 Agent 包的入口是 agent.py
                module = importlib.import_module(f"swi.agents.{agent_name}.agent")
                for attr_name in dir(module):
                    attr = getattr(module, attr_name)
                    if (
                        isinstance(attr, type)
                        and issubclass(attr, BaseAgent)
                        and attr is not BaseAgent
                    ):
                        # 尝试从 agents.yaml 读取配置
                        agent_cfg = self.config.agents.get(
                            attr.agent_id, None
                        )

                        agent_instance = attr(
                            config=agent_cfg.config if agent_cfg else {}
                        )

                        # 用 agents.yaml 中的值覆盖（直接属性访问，不用 hasattr 避免静默失败）
                        if agent_cfg:
                            agent_instance.enabled = agent_cfg.enabled
                            if agent_cfg.schedule:
                                agent_instance.schedule = agent_cfg.schedule

                        # 注入依赖
                        agent_instance._message_bus = self.message_bus
                        agent_instance._notifier = self.notifier
                        agent_instance._db_session_factory = self._session_factory
                        agent_instance._feishu_client = self.feishu_client

                        # 注入 LLM 配置（供 table_reporter 等 Agent 使用）
                        from swi.integrations.llm_client import LLMConfig
                        agent_instance._llm_config = LLMConfig(
                            api_key=self.config.llm.api_key,
                            model=self.config.llm.model,
                            max_tokens=self.config.llm.max_tokens,
                            temperature=self.config.llm.temperature,
                            api_base=self.config.llm.api_base,
                        )

                        self.scheduler.register(agent_instance)
                        agent_count += 1
            except Exception as e:
                logger.error(f"加载 Agent [{agent_name}] 失败: {e}")

        logger.info(f"发现并注册了 {agent_count} 个 Agent")

    async def start_scheduler(self):
        """启动调度器（先初始化所有 Agent，再开始调度）。"""
        if not self.scheduler:
            raise RuntimeError("请先调用 initialize()")

        # 初始化所有 Agent
        for agent_id, agent in self.scheduler._agents.items():
            try:
                await agent.initialize()
                agent._initialized = True
            except Exception as e:
                logger.error(f"Agent [{agent_id}] 初始化失败: {e}")

        # 启动飞书 WebSocket 接收消息（非关键路径：失败不影响服务运行）
        if self.feishu_ws:
            try:
                await self.feishu_ws.start()
            except Exception as e:
                logger.warning(f"飞书 WebSocket 启动失败（API/调度器/仪表盘不受影响）: {e}")

        await self.scheduler.start()

    async def start_dashboard(self):
        """启动 Web 仪表盘 + Cloudflare Tunnel（可选）。"""
        import uvicorn
        import asyncio
        import subprocess
        from swi.dashboard.app import create_app

        app = create_app(self)
        config = uvicorn.Config(
            app,
            host="0.0.0.0",  # 允许外部访问（cloudflared需要）
            port=self.config.settings.dashboard_port,
            log_level="info",
        )
        server = uvicorn.Server(config)
        asyncio.create_task(server.serve())

        local_url = f"http://127.0.0.1:{self.config.settings.dashboard_port}"
        logger.info(f"仪表盘: {local_url}")

        # 尝试启动 Cloudflare Tunnel（如果装了 cloudflared）
        try:
            import shutil
            cloudflared = shutil.which("cloudflared")
            if not cloudflared:
                # 在项目同级目录找
                cf_path = self.project_dir.parent / "cloudflared.exe"
                if cf_path.exists():
                    cloudflared = str(cf_path)

            if cloudflared:
                self._cloudflared_process = subprocess.Popen(
                    [cloudflared, "tunnel", "--url",
                     f"http://localhost:{self.config.settings.dashboard_port}",
                     "--no-autoupdate"],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                # 等待 tunnel 就绪，读取公网 URL
                import time
                deadline = time.time() + 30
                public_url = ""
                while time.time() < deadline:
                    line = self._cloudflared_process.stderr.readline()
                    if "trycloudflare.com" in line:
                        # 提取 URL: https://xxx.trycloudflare.com
                        import re
                        m = re.search(r'https://[a-z0-9\-]+\.trycloudflare\.com', line)
                        if m:
                            public_url = m.group(0)
                            break
                    if self._cloudflared_process.poll() is not None:
                        break

                if public_url:
                    logger.info(f"公网地址: {public_url}")
                    logger.info(f"钉钉回调地址: {public_url}/dingtalk/callback")
                else:
                    logger.warning("Cloudflare Tunnel 启动失败或无输出，仅本地可用")
        except Exception as e:
            logger.warning(f"Cloudflare Tunnel 启动失败: {e}，仅本地可用")

    async def trigger_agent(self, agent_id: str, **execute_kwargs) -> AgentResult:
        if not self.scheduler:
            raise RuntimeError("请先调用 initialize()")
        return await self.scheduler.trigger(agent_id, **execute_kwargs)

    async def trigger_all(self) -> dict[str, AgentResult]:
        if not self.scheduler:
            raise RuntimeError("请先调用 initialize()")
        return await self.scheduler.trigger_all()

    def list_agents(self) -> list[dict]:
        if not self.scheduler:
            return []
        return self.scheduler.list_agents()

    async def _on_agent_run_complete(self, event):
        """Agent 执行完成事件 → 错误时通知。"""
        if event.priority >= 2 and self.notifier:
            await self.notifier.send_text(
                title=f"Agent 异常: {event.source_agent}",
                content=event.summary,
                priority=2,
            )

    async def _on_feishu_message(self, text: str, chat_id: str, msg_id: str):
        """飞书消息回调：路由到事项管理、广告分析或报告生成。"""
        import re
        import asyncio
        from swi.agents.ad_monitor.data_parser import is_ad_data, parse_ad_data, ad_data_to_alert

        reply = ""
        if is_ad_data(text):
            parsed = parse_ad_data(text)
            if parsed:
                reply = ad_data_to_alert(parsed)
                reply = f"**广告分析** ({len(parsed)}条)\n\n{reply}"
            else:
                reply = "无法解析广告数据。格式：`产品名 CTR0.5 花费87 订单3`"
        elif text in ("帮助", "help"):
            reply = (
                "**工作管家**\n\n"
                "记录事项：直接发消息\n"
                "完成：`完成 编号`\n"
                "列表：`待办`\n"
                "广告分析：粘贴广告数据\n"
                "单表分析：`分析 库存` / `分析 采购` / `分析 头程` / `分析 订单`\n"
                "日报：`生成报告`"
            )
        elif text in ("待办", "列表"):
            if self.task_manager:
                reply = await self.task_manager.get_summary()
        elif re.match(r"(完成|done)\s*\d+", text, re.IGNORECASE):
            if self.task_manager:
                parsed = self.task_manager.parse_dingtalk_msg(text)
                if parsed.get("action") == "done":
                    reply = await self.task_manager.handle_dingtalk_msg(text)
        # ── 单项表格分析：支持「分析 表名」模糊匹配 ──
        elif (m := re.match(r"分析\s+(.+)", text)):
            target = m.group(1).strip()
            # 解释常见别名
            alias_map = {
                "库存": "海外仓库存数据",
                "采购": "海外仓采购",
                "头程": "海外仓入库订单头程费用",
                "订单": "海外仓订单数据表",
            }
            table_name = alias_map.get(target, target)
            # 后台异步执行，不阻塞消息回复
            asyncio.create_task(self._run_single_analysis(chat_id, msg_id, table_name))
            reply = f"🔍 正在分析「{table_name}」…\n请稍候，报告生成后将自动发送到这里。"
        # ── 报告生成（由 feishu-bridge 统一处理，SWI WS 不再重复触发）──
        elif text in ("生成报告", "重新生成报告", "表格审核", "审核表格", "表格报告"):
            # 不在此处理 — feishu-bridge 会通过 HTTP API 触发并发送结果
            # 仅当 feishu-bridge 未运行时回复提示
            reply = (
                "⚠️ 报告生成请通过 feishu-bridge 发起。\n"
                "如果你看到这条消息，说明 feishu-bridge 未运行。"
            )
        else:
            if self.task_manager:
                parsed = self.task_manager.parse_dingtalk_msg(text)
                if parsed.get("action") == "add":
                    task = await self.task_manager.add(parsed["content"], parsed.get("deadline", "today"))
                    dl = "今日" if task.deadline_type == "today" else "本周"
                    reply = f"已记录 [{dl}] #{task.id}: {task.content}"
                else:
                    reply = await self.task_manager.handle_dingtalk_msg(text)

        if reply and msg_id:
            await self.feishu_client.reply_text(msg_id, reply)
            # 同时发 webhook
            await self.feishu_client.send_webhook(reply)

    async def _run_report_and_reply(self, chat_id: str, msg_id: str):
        """后台执行报告生成并回复结果。"""
        try:
            result = await self.trigger_agent("table_reporter")
            if result.status == "success":
                await self.feishu_client.reply_text(
                    msg_id,
                    f"✅ 报告生成完成：{result.summary}",
                )
            else:
                await self.feishu_client.reply_text(
                    msg_id,
                    f"⚠️ 报告生成异常: {result.summary}\n{result.error or ''}",
                )
        except Exception as e:
            logger.error(f"报告生成异常: {e}")
            await self.feishu_client.reply_text(
                msg_id,
                f"❌ 报告生成失败: {e}",
            )

    async def _run_single_analysis(self, chat_id: str, msg_id: str, table_name: str):
        """后台执行单项表格分析并回复结果到飞书。"""
        try:
            result = await self.trigger_agent("table_reporter", table_name=table_name)
            report = result.data.get("report", "")
            if result.status == "success" and report:
                # 发送分析报告到群
                await self.feishu_client.send_text_to_chat(
                    f"📊 单项分析: {result.data.get('single_table', table_name)}\n\n{report}",
                    chat_id,
                )
            elif result.status == "success":
                await self.feishu_client.send_text_to_chat(
                    f"✅ {result.summary}\n\n{result.data.get('report', '')}",
                    chat_id,
                )
            else:
                await self.feishu_client.send_text_to_chat(
                    f"⚠️ 分析异常: {result.summary}\n{result.error or ''}",
                    chat_id,
                )
        except Exception as e:
            logger.error(f"单项分析异常: {e}")
            await self.feishu_client.send_text_to_chat(
                f"❌ 分析失败: {e}",
                chat_id,
            )

    async def test_dingtalk(self) -> bool:
        """测试钉钉通知连通性。"""
        if not self.dingtalk_notifier:
            return False
        return await self.dingtalk_notifier.health_check()

    async def test_desktop(self) -> bool:
        """测试桌面通知。"""
        if not self.desktop_notifier:
            return False
        return await self.desktop_notifier.health_check()

    async def shutdown(self):
        """优雅关闭所有组件。"""
        logger.info("正在关闭系统...")
        if self._cloudflared_process:
            self._cloudflared_process.terminate()
            self._cloudflared_process = None
        if self.scheduler:
            await self.scheduler.stop()
        if self.notifier:
            await self.notifier.close()
        if self.feishu_client:
            await self.feishu_client.close()
        if self.feishu_ws:
            await self.feishu_ws.stop()
        if self.message_bus:
            await self.message_bus.stop()
        logger.info("系统已关闭")
