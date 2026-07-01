"""
飞书集成 — 消息收发 + 多维表格 + 事件回调。

注意：所有 HTTP 调用均使用同步 httpx.Client + loop.run_in_executor()，
而非 httpx.AsyncClient。原因：
  nest_asyncio.apply() 与 anyio 的 cancel scope 追踪存在冲突，
  跨 asyncio task 使用 AsyncClient 会触发：
  "Attempted to exit cancel scope in a different task than it was entered in"
同步 Client 完全不走 anyio，线程池中执行，彻底规避该问题。
"""
import json
import time
import asyncio
import hashlib
from dataclasses import dataclass
from loguru import logger
import httpx


@dataclass
class FeishuConfig:
    app_id: str = ""
    app_secret: str = ""
    webhook_url: str = ""
    bot_name: str = "工作管家"
    # 事件订阅加密（可选）
    encrypt_key: str = ""
    verification_token: str = ""


class FeishuClient:
    """飞书 API 客户端。自动管理 tenant_access_token。"""

    BASE_URL = "https://open.feishu.cn/open-apis"

    def __init__(self, config: FeishuConfig):
        self.config = config
        self._token: str = ""
        self._token_expires_at: float = 0

    @property
    def is_available(self) -> bool:
        return bool(self.config.app_id and self.config.app_secret)

    # ─── 同步 HTTP 线程池封装 ────────────────

    async def _sync_request(
        self, method: str, url: str,
        headers: dict = None,
        json_data: dict = None,
        params: dict = None,
        timeout: int = 30,
    ) -> httpx.Response:
        """在线程池中执行同步 httpx 请求，完全避开 anyio cancel scope。

        同步 httpx.Client 不使用 anyio，因此不会受 nest_asyncio
        与 anyio cancel scope 追踪冲突的影响。
        """
        def _sync():
            with httpx.Client(timeout=timeout) as client:
                return client.request(
                    method, url,
                    headers=headers or {},
                    json=json_data or {},
                    params=params or {},
                )
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, _sync)

    # ─── Token ───────────────────────────────

    async def get_token(self) -> str:
        if self._token and time.time() < self._token_expires_at - 60:
            return self._token
        resp = await self._sync_request(
            "POST",
            f"{self.BASE_URL}/auth/v3/tenant_access_token/internal",
            json_data={"app_id": self.config.app_id, "app_secret": self.config.app_secret},
        )
        data = resp.json()
        if data.get("code") != 0:
            raise Exception(f"飞书 Token 失败: {data}")
        self._token = data["tenant_access_token"]
        self._token_expires_at = time.time() + data.get("expire", 7200)
        return self._token

    # ─── HTTP 封装 ───────────────────────────

    async def _get(self, path: str, params: dict = None) -> dict:
        token = await self.get_token()
        resp = await self._sync_request(
            "GET", f"{self.BASE_URL}{path}",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
        )
        return resp.json()

    async def _post(self, path: str, body: dict = None, params: dict = None) -> dict:
        token = await self.get_token()
        resp = await self._sync_request(
            "POST", f"{self.BASE_URL}{path}",
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            json_data=body or {},
            params=params or {},
        )
        return resp.json()

    # ─── Webhook 消息发送（自定义机器人）─────────

    async def send_webhook(self, text: str) -> bool:
        """通过群自定义机器人 Webhook 发送文本消息。"""
        if not self.config.webhook_url:
            logger.debug("飞书 webhook 未配置")
            return False
        resp = await self._sync_request(
            "POST", self.config.webhook_url,
            json_data={"msg_type": "text", "content": {"text": text}},
        )
        ok = resp.json().get("code") == 0
        if not ok:
            logger.error(f"Webhook 发送失败: {resp.json()}")
        return ok

    async def send_webhook_markdown(self, title: str, content: str) -> bool:
        """发送富文本消息。"""
        if not self.config.webhook_url:
            return False
        body = {
            "msg_type": "post",
            "content": {
                "post": {
                    "zh_cn": {
                        "title": title,
                        "content": [[{"tag": "text", "text": content}]],
                    }
                }
            },
        }
        resp = await self._sync_request(
            "POST", self.config.webhook_url,
            json_data=body,
        )
        return resp.json().get("code") == 0

    # ─── API 发送消息（应用机器人）────────────

    async def send_text_to_chat(self, content: str, chat_id: str) -> bool:
        """通过 Bot API 发送文本消息到指定群聊。"""
        body = {
            "receive_id": chat_id,
            "msg_type": "text",
            "content": json.dumps({"text": content}),
        }
        result = await self._post(
            "/im/v1/messages", body,
            params={"receive_id_type": "chat_id"},
        )
        ok = result.get("code") == 0
        if not ok:
            logger.error(f"发送群消息失败: {result}")
        return ok

    async def send_post_to_chat(
        self, chat_id: str, title: str, paragraphs: list[list[dict]]
    ) -> bool:
        """通过 Bot API 发送富文本 (Post) 消息到指定群聊。

        Args:
            chat_id: 群聊 ID
            title: 消息标题
            paragraphs: 飞书 Post 格式的内容数组，每个元素是一行段落
                例: [[{"tag": "text", "text": "hello"}], [{"tag": "a", "text": "link", "href": "..."}]]
        """
        body = {
            "receive_id": chat_id,
            "msg_type": "post",
            "content": json.dumps({
                "zh_cn": {
                    "title": title,
                    "content": paragraphs,
                }
            }),
        }
        result = await self._post(
            "/im/v1/messages", body,
            params={"receive_id_type": "chat_id"},
        )
        ok = result.get("code") == 0
        if not ok:
            logger.error(f"发送群 Post 消息失败: {result}")
        return ok

    async def send_text(self, content: str, receive_id: str) -> bool:
        """通过 API 发送文本消息（需要 receive_id）。"""
        body = {
            "receive_id": receive_id,
            "msg_type": "text",
            "content": json.dumps({"text": content}),
        }
        result = await self._post("/im/v1/messages", body)
        return result.get("code") == 0

    # ─── 群聊管理 ────────────────────────────

    async def list_chats(self, page_size: int = 100) -> list[dict]:
        """列出机器人在内的所有群聊。自动翻页。

        返回 [{"chat_id": "...", "name": "...", "avatar": "...", "description": "..."}, ...]
        """
        all_chats = []
        page_token = None

        while True:
            params: dict = {"page_size": page_size}
            if page_token:
                params["page_token"] = page_token

            result = await self._get("/im/v1/chats", params=params)
            if result.get("code") != 0:
                logger.error(f"获取群列表失败: {result}")
                break

            data = result.get("data", {})
            items = data.get("items", [])
            for chat in items:
                all_chats.append({
                    "chat_id": chat.get("chat_id", ""),
                    "name": chat.get("name", ""),
                    "avatar": chat.get("avatar", ""),
                    "description": chat.get("description", ""),
                })

            if not data.get("has_more", False):
                break
            page_token = data.get("page_token", "")

        logger.info(f"发现 {len(all_chats)} 个群聊")
        return all_chats

    async def find_chat_by_name(self, name: str) -> dict | None:
        """按名称查找群聊。返回匹配的第一个群，找不到返回 None。"""
        chats = await self.list_chats()
        for chat in chats:
            if chat.get("name") == name:
                return chat
        logger.warning(f"未找到群聊: [{name}]，可用群: {[c['name'] for c in chats]}")
        return None

    # ─── 回复消息 ────────────────────────────

    async def reply_text(self, message_id: str, text: str) -> bool:
        """回复指定消息。"""
        body = {
            "msg_type": "text",
            "content": json.dumps({"text": text}),
        }
        result = await self._post(
            f"/im/v1/messages/{message_id}/reply", body
        )
        return result.get("code") == 0

    # ─── 多维表格 ────────────────────────────

    async def list_tables(self, app_token: str) -> list:
        result = await self._get(f"/bitable/v1/apps/{app_token}/tables")
        if result.get("code") != 0:
            logger.error(f"列表失败: {result}")
            return []
        return [{"table_id": t["table_id"], "name": t["name"]}
                for t in result.get("data", {}).get("items", [])]

    async def list_fields(self, app_token: str, table_id: str) -> list[dict]:
        """
        列出多维表格的所有字段（列定义）。
        返回 [{"field_id": "...", "field_name": "...", "type": 1, "type_name": "文本"}, ...]
        """
        result = await self._get(
            f"/bitable/v1/apps/{app_token}/tables/{table_id}/fields"
        )
        if result.get("code") != 0:
            logger.error(f"获取字段列表失败: {result}")
            return []
        return [
            {
                "field_id": f.get("field_id", ""),
                "field_name": f.get("field_name", ""),
                "type": f.get("type", 0),
                "type_name": self._field_type_name(f.get("type", 0)),
            }
            for f in result.get("data", {}).get("items", [])
        ]

    async def get_all_records(
        self, app_token: str, table_id: str,
    ) -> list[dict]:
        """
        获取多维表格全部记录（自动翻页）。
        返回 [{"record_id": "...", "fields": {...}}, ...]
        """
        all_items = []
        page_token = None
        page_size = 500  # 飞书上限

        while True:
            body: dict = {"page_size": page_size}
            if page_token:
                body["page_token"] = page_token

            result = await self._post(
                f"/bitable/v1/apps/{app_token}/tables/{table_id}/records/search",
                body,
            )
            if result.get("code") != 0:
                logger.error(f"获取记录失败: {result}")
                break

            data = result.get("data", {})
            items = data.get("items", [])
            all_items.extend(
                {"record_id": i.get("record_id", ""), "fields": i.get("fields", {})}
                for i in items
            )

            if not data.get("has_more", False):
                break
            page_token = data.get("page_token", "")

        logger.info(f"获取 {len(all_items)} 条记录 [表:{table_id}]")
        return all_items

    async def search_records(
        self, app_token: str, table_id: str,
        page_size: int = 100, filter_obj: dict = None,
    ) -> list:
        body = {"page_size": page_size}
        if filter_obj:
            body["filter"] = filter_obj
        result = await self._post(
            f"/bitable/v1/apps/{app_token}/tables/{table_id}/records/search", body,
        )
        if result.get("code") != 0:
            logger.error(f"查询失败: {result}")
            return []
        return [{"record_id": i.get("record_id", ""), "fields": i.get("fields", {})}
                for i in result.get("data", {}).get("items", [])]

    # ─── 事件回调验证 ────────────────────────

    @staticmethod
    def verify_challenge(body: dict, verification_token: str = "") -> dict:
        """
        飞书 URL 验证。
        返回 {"challenge": "xxx"} 表示验证通过。
        新版飞书支持明文验证，直接返回 challenge 即可。
        """
        challenge = body.get("challenge", "")
        token = body.get("token", "")
        msg_type = body.get("type", "")

        # 明文验证（新版）
        if challenge and msg_type == "url_verification":
            return {"challenge": challenge}

        # 加密验证（旧版）- 暂不支持
        return {}

    # ─── 解析事件消息 ────────────────────────

    @staticmethod
    def parse_event(body: dict) -> dict:
        """
        解析飞书事件推送，提取消息文本和元数据。
        返回: {"text": "", "chat_id": "", "message_id": "", "user_id": "", "is_mention": False}
        """
        event = body.get("event", {})
        header = body.get("header", {})

        message = event.get("message", {})
        text = ""
        if message.get("msg_type") == "text":
            text = json.loads(message.get("content", "{}")).get("text", "")
        elif isinstance(message.get("content"), str):
            try:
                text = json.loads(message.get("content")).get("text", "")
            except Exception:
                text = message.get("content", "")

        # 去掉 @机器人
        import re
        mentions = message.get("mentions", [])
        for m in mentions:
            name = m.get("name", "")
            if name:
                text = text.replace(f"@{name}", "").strip()

        return {
            "text": text.strip(),
            "chat_id": message.get("chat_id", ""),
            "message_id": message.get("message_id", ""),
            "user_id": event.get("sender", {}).get("sender_id", {}).get("user_id", ""),
            "is_mention": any(
                m.get("id", {}).get("union_id", "") == "app"
                for m in mentions
            ),
        }

    async def close(self):
        # 线程池中的同步 Client 用后即关，无需清理
        pass

    # ─── 静态工具 ────────────────────────────

    @staticmethod
    def _field_type_name(type_code: int) -> str:
        """飞书字段类型代码 → 可读名称。"""
        _map = {
            1: "文本", 2: "数字", 3: "复选框", 4: "日期", 5: "网址",
            7: "附件", 11: "公式", 13: "单选", 15: "多选",
            17: "关联", 18: "自动编号", 20: "创建时间", 21: "修改时间",
            22: "创建人", 23: "修改人", 1001: "用户",
        }
        return _map.get(type_code, f"未知({type_code})")
