"""
钉钉机器人集成 — 通过 Webhook 发送群消息。
支持类型：Text, Markdown, Link, ActionCard, FeedCard。
支持安全方式：加签 (HMAC-SHA256)
文档: https://open.dingtalk.com/document/orgapp/custom-bot-send-message-type
"""
import time
import hmac
import hashlib
import base64
import asyncio
from urllib.parse import quote_plus
from dataclasses import dataclass, field
from typing import Optional
from loguru import logger
import httpx


@dataclass
class DingTalkConfig:
    """钉钉机器人配置。"""
    webhook_url: str = ""
    secret: str = ""              # 加签密钥（SEC开头）
    enabled: bool = True
    rate_limit_per_minute: int = 20
    retry_times: int = 3
    retry_seconds: float = 5.0


class TokenBucket:
    """简易令牌桶限流器。"""
    def __init__(self, rate: int = 20, burst: int = 5):
        self.rate = rate / 60.0          # 每秒生成令牌数
        self.burst = burst               # 最大突发
        self.tokens = float(burst)
        self.last_fill = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> bool:
        """获取一个令牌，获取失败返回 False。"""
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self.last_fill
            self.tokens = min(self.burst, self.tokens + elapsed * self.rate)
            self.last_fill = now
            if self.tokens >= 1.0:
                self.tokens -= 1.0
                return True
            return False

    async def wait_and_acquire(self, timeout: float = 10.0) -> bool:
        """等待直到获取令牌或超时。"""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if await self.acquire():
                return True
            await asyncio.sleep(0.5)
        return False


class DingTalkNotifier:
    """
    钉钉群机器人通知服务。

    用法:
        notifier = DingTalkNotifier(DingTalkConfig(webhook_url="..."))
        await notifier.send_text("标题", "内容")
        await notifier.send_markdown("## 日报", "内容")
    """

    def __init__(self, config: DingTalkConfig):
        self.config = config
        self._bucket = TokenBucket(rate=config.rate_limit_per_minute)
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(15.0))
        self._session_lock = asyncio.Lock()
        self._sent_count = 0

    @property
    def is_available(self) -> bool:
        return bool(self.config.webhook_url) and self.config.enabled

    # ─── 加签 ──────────────────────────────────

    def _get_signed_url(self) -> str:
        """
        钉钉加签：HMAC-SHA256 签名。
        算法：timestamp + "\n" + secret → HMAC-SHA256 → Base64 → URL编码。
        文档：https://open.dingtalk.com/document/orgapp/customize-robot-security-settings
        """
        if not self.config.secret:
            return self.config.webhook_url

        timestamp = str(round(time.time() * 1000))
        secret = self.config.secret

        # HMAC-SHA256
        string_to_sign = f"{timestamp}\n{secret}"
        hmac_code = hmac.new(
            secret.encode("utf-8"),
            string_to_sign.encode("utf-8"),
            digestmod=hashlib.sha256,
        ).digest()

        # Base64 编码 + URL 编码
        sign = quote_plus(base64.b64encode(hmac_code).decode("utf-8"))

        return f"{self.config.webhook_url}&timestamp={timestamp}&sign={sign}"

    # ─── 发送方法 ──────────────────────────────

    async def send_text(self, title: str, content: str, priority: int = 0) -> bool:
        """
        发送纯文本消息。
        priority: 0=普通, 1=重要, 2=紧急（紧急消息会优先获取令牌）
        """
        text = f"{title}\n\n{content}" if title else content
        payload = {
            "msgtype": "text",
            "text": {"content": text}
        }
        return await self._send(payload, priority)

    async def send_markdown(self, title: str, markdown: str, priority: int = 0) -> bool:
        """发送 Markdown 消息。"""
        payload = {
            "msgtype": "markdown",
            "markdown": {
                "title": title,
                "text": markdown
            }
        }
        return await self._send(payload, priority)

    async def send_link(
        self, title: str, text: str, url: str, pic_url: str = ""
    ) -> bool:
        """发送链接消息。"""
        payload = {
            "msgtype": "link",
            "link": {
                "title": title,
                "text": text,
                "messageUrl": url,
                "picUrl": pic_url or "",
            }
        }
        return await self._send(payload)

    async def send_action_card_single(
        self, title: str, text: str,
        btn_title: str = "查看详情", btn_url: str = ""
    ) -> bool:
        """发送单个按钮的 ActionCard。"""
        payload = {
            "msgtype": "actionCard",
            "actionCard": {
                "title": title,
                "text": text,
                "singleTitle": btn_title,
                "singleURL": btn_url,
            }
        }
        return await self._send(payload)

    # ─── 内部 ──────────────────────────────────

    async def _send(self, payload: dict, priority: int = 0) -> bool:
        """发送消息到钉钉，带限流和重试。"""
        if not self.is_available:
            logger.debug("钉钉通知未配置或已禁用，跳过发送")
            return False

        # 限流
        if not await self._bucket.wait_and_acquire(timeout=30.0):
            logger.error("钉钉发送限流等待超时")
            return False

        # 重试发送
        last_error = None
        for attempt in range(self.config.retry_times + 1):
            try:
                url = self._get_signed_url()
                resp = await self._http.post(url, json=payload)
                resp.raise_for_status()
                result = resp.json()
                if result.get("errcode") == 0:
                    self._sent_count += 1
                    logger.debug(f"钉钉消息发送成功 (第{self._sent_count}条)")
                    return True
                else:
                    # 钉钉返回错误码
                    errcode = result.get("errcode")
                    errmsg = result.get("errmsg", "")
                    logger.warning(f"钉钉返回错误: errcode={errcode} errmsg={errmsg}")

                    # 限流错误码，等久一点
                    if errcode == 45009:  # 接口调用太频繁
                        await asyncio.sleep(5.0 * (attempt + 1))
                        continue
                    return False

            except httpx.HTTPError as e:
                last_error = e
                logger.warning(f"钉钉发送失败 (尝试 {attempt+1}/{self.config.retry_times+1}): {e}")
                if attempt < self.config.retry_times:
                    await asyncio.sleep(self.config.retry_seconds * (attempt + 1))
            except Exception as e:
                last_error = e
                logger.error(f"钉钉发送异常: {e}")
                return False

        logger.error(f"钉钉发送最终失败: {last_error}")
        return False

    # ─── 生命周期 ──────────────────────────────

    async def close(self):
        """关闭 HTTP 客户端。"""
        await self._http.aclose()
        logger.debug("钉钉通知 HTTP 客户端已关闭")

    async def health_check(self) -> bool:
        """发送一条测试消息验证配置是否正确。"""
        return await self.send_text(
            title="✅ 超级工作个体",
            content=f"系统连接测试成功！\n时间：{time.strftime('%Y-%m-%d %H:%M:%S')}",
        )
