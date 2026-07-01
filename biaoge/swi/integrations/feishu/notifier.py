"""
飞书通知器 — 将 FeishuClient 包装为 MultiNotifier 兼容接口。
Agent 可通过 self.notify() 统一发送飞书消息。

支持两种发送模式（按优先级）：
  1. Bot API 定向群聊 — 通过 target_chat_name 指定群名，直推无关键词限制
  2. Webhook 兜底 — 使用群自定义机器人 webhook

双应用支持：
  当 chat_app 与主 app 不同时，消息发送使用 chat_app（它在目标群内），
  而主 app 用于 Bitable 等业务 API。
"""
from loguru import logger
from swi.integrations.feishu.bot import FeishuClient, FeishuConfig


class FeishuNotifier:
    """飞书群消息通知后端，实现与 DingTalkNotifier 相同接口。"""

    def __init__(
        self,
        feishu_client,
        target_chat_name: str = "",
        target_chat_id: str = "",
        chat_app_id: str = "",
        chat_app_secret: str = "",
    ):
        """
        Args:
            feishu_client: 主 FeishuClient 实例（用于 Bitable 等业务 API）
            target_chat_name: 目标群聊名称。chat_id 为空时，按名称自动查找。
            target_chat_id: 目标群聊 ID。设置后直接使用，跳过名称查找。
            chat_app_id: 推送专用应用 ID。设置后将创建独立客户端用于发消息。
            chat_app_secret: 推送专用应用 Secret。
        """
        self._client = feishu_client
        self._target_chat_name = target_chat_name.strip()
        self._chat_id: str | None = target_chat_id.strip() or None

        # 推送专用客户端（用于在目标群内发消息）
        self._chat_client: FeishuClient | None = None
        if chat_app_id and chat_app_secret:
            self._chat_client = FeishuClient(FeishuConfig(
                app_id=chat_app_id,
                app_secret=chat_app_secret,
            ))
            logger.info(f"飞书推送通道已独立配置 (app: {chat_app_id[:8]}...)")

    @property
    def is_available(self) -> bool:
        return (
            self._client is not None
            and bool(self._client.config.app_id)
        )

    @property
    def _send_client(self) -> FeishuClient:
        """发送消息使用的客户端：优先 chat_client，否则主 client。"""
        return self._chat_client or self._client

    # ─── 群聊 ID 解析（懒加载，首次发送时查找）─────────

    async def _resolve_chat_id(self) -> str | None:
        """按名称查找目标群聊的 chat_id（若未直接指定），并缓存。"""
        if self._chat_id:
            return self._chat_id
        if not self._target_chat_name:
            return None

        # 用 chat_client 查找（它在目标群里），找不到再用主 client
        finder = self._chat_client or self._client
        chat = await finder.find_chat_by_name(self._target_chat_name)
        if chat:
            self._chat_id = chat["chat_id"]
            logger.info(f"已绑定群聊: [{self._target_chat_name}] → {self._chat_id}")
            return self._chat_id
        else:
            logger.warning(
                f"未找到群聊 [{self._target_chat_name}]，"
                f"将使用 webhook 兜底。可在 feishu.yaml 中设置 target_chat_id 跳过查找。"
            )
            return None

    # ─── 发送接口 ────────────────────────────

    async def send_text(self, title: str, content: str, priority: int = 0) -> bool:
        """发送文本消息。优先推送到目标群聊，兜底 webhook。"""
        text = f"{title}\n\n{content}" if title else content

        chat_id = await self._resolve_chat_id()
        if chat_id:
            return await self._send_client.send_text_to_chat(text, chat_id)

        # fallback: webhook
        return await self._client.send_webhook(text)

    async def send_markdown(self, title: str, markdown: str, priority: int = 0) -> bool:
        """发送富文本报告。优先推送到目标群聊，兜底 webhook。"""
        chat_id = await self._resolve_chat_id()

        if chat_id:
            # Bot API 直推（无关键词限制）
            paragraphs = self._markdown_to_post_content(markdown)
            return await self._send_client.send_post_to_chat(chat_id, title, paragraphs)

        # fallback: webhook（可能受关键词限制）
        paragraphs = self._markdown_to_post_content(markdown)
        body = {
            "msg_type": "post",
            "content": {
                "post": {
                    "zh_cn": {
                        "title": title,
                        "content": paragraphs,
                    }
                }
            },
        }
        import asyncio
        import httpx
        def _sync_post():
            with httpx.Client(timeout=30) as client:
                return client.post(self._client.config.webhook_url, json=body)
        loop = asyncio.get_running_loop()
        resp = await loop.run_in_executor(None, _sync_post)
        ok = resp.json().get("code") == 0
        if not ok:
            logger.error(f"飞书 webhook 发送失败: {resp.json()}")
        return ok

    # ─── Markdown → 飞书 Post 格式 ──────────

    @staticmethod
    def _markdown_to_post_content(md: str) -> list:
        """
        将 Markdown 转为飞书 Post content 结构。

        支持的语法：
          - ## / ### 标题 → 加粗行
          - **文本** → bold
          - - 列表项 → 保留缩进文本
          - 普通段落 → text
        """
        import re

        lines = md.strip().split("\n")
        result = []

        for line in lines:
            stripped = line.strip()
            if not stripped:
                continue

            # 标题行 → 加粗
            if stripped.startswith("## "):
                text = stripped[3:]
                result.append([{"tag": "text", "text": text, "style": ["bold"]}])
            elif stripped.startswith("### "):
                text = stripped[4:]
                result.append([{"tag": "text", "text": text, "style": ["bold"]}])
            elif stripped.startswith("# "):
                text = stripped[2:]
                result.append([{"tag": "text", "text": text, "style": ["bold"]}])
            else:
                # 解析行内 **bold**
                parts = []
                remaining = stripped
                while remaining:
                    m = re.match(r'^(.*?)\*\*(.+?)\*\*(.*)', remaining)
                    if m:
                        if m.group(1):
                            parts.append({"tag": "text", "text": m.group(1)})
                        parts.append({"tag": "text", "text": m.group(2), "style": ["bold"]})
                        remaining = m.group(3)
                    else:
                        parts.append({"tag": "text", "text": remaining})
                        break
                result.append(parts if parts else [{"tag": "text", "text": stripped}])

        # 飞书 post content 每段最多 30 个元素，按行分段已经很安全
        return result

    # ─── 健康检查 ────────────────────────────

    async def health_check(self) -> bool:
        """发送测试消息验证飞书通道连通性。"""
        from datetime import datetime
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 优先测试目标群聊
        chat_id = await self._resolve_chat_id()
        if chat_id:
            ok = await self._send_client.send_text_to_chat(
                f"超级工作个体 — 飞书通道已连接\n时间：{now}",
                chat_id,
            )
            logger.info(
                f"飞书健康检查 → 群 [{self._target_chat_name}]: {'✓' if ok else '✗'}"
            )
            return ok

        # 兜底 webhook
        ok = await self.send_text(
            "飞书通知测试",
            f"超级工作个体 — 飞书通道已连接\n时间：{now}",
        )
        logger.info(f"飞书健康检查 → webhook: {'✓' if ok else '✗'}")
        return ok

    async def close(self):
        """关闭推送专用客户端（如有）。"""
        if self._chat_client:
            await self._chat_client.close()
