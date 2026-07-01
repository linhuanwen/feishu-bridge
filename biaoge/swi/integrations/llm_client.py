"""
LLM API 客户端 — 通过 httpx 调用 OpenAI 兼容的 Chat Completions API。
支持: DeepSeek、OpenAI、及其他兼容接口。

注意：使用同步 httpx.Client + loop.run_in_executor() 而非 AsyncClient，
原因同 feishu/bot.py：nest_asyncio 与 anyio cancel scope 追踪冲突。
"""
import asyncio
from dataclasses import dataclass
from loguru import logger
import httpx


@dataclass
class LLMConfig:
    """LLM 连接配置。"""
    api_key: str = ""
    model: str = "deepseek-chat"
    max_tokens: int = 4096
    temperature: float = 0.3
    api_base: str = "https://api.deepseek.com/v1"


class LLMClient:
    """
    LLM API 客户端 — OpenAI 兼容的 Chat Completions 格式。
    默认对接 DeepSeek，可切换为其他兼容接口。
    """

    def __init__(self, config: LLMConfig):
        self.config = config
        # 不在此处创建共享的 httpx.AsyncClient —— 线程池中每次新建 sync Client

    @property
    def is_available(self) -> bool:
        return bool(self.config.api_key)

    async def analyze(self, system_prompt: str, user_message: str) -> str:
        """
        发送请求到 LLM，返回文本响应。

        参数:
            system_prompt: 系统提示词
            user_message: 用户消息（要分析的数据）

        返回:
            LLM 文本回复；出错时返回错误描述字符串（不抛异常）
        """
        if not self.is_available:
            logger.warning("LLM API Key 未配置")
            return "[LLM 未配置: 请在 config/llm.yaml 中设置 api_key]"

        body = {
            "model": self.config.model,
            "max_tokens": self.config.max_tokens,
            "temperature": self.config.temperature,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
        }

        def _sync_call():
            with httpx.Client(
                timeout=120.0,
                headers={
                    "Authorization": f"Bearer {self.config.api_key}",
                    "Content-Type": "application/json",
                },
            ) as client:
                resp = client.post(
                    f"{self.config.api_base}/chat/completions",
                    json=body,
                )
                resp.raise_for_status()
                return resp.json()

        try:
            loop = asyncio.get_running_loop()
            data = await loop.run_in_executor(None, _sync_call)

            # OpenAI 兼容响应: choices[0].message.content
            choices = data.get("choices", [])
            text = ""
            if choices:
                text = choices[0].get("message", {}).get("content", "")

            # 记录 token 用量
            usage = data.get("usage", {})
            logger.info(
                f"LLM 调用完成 | "
                f"输入: {usage.get('prompt_tokens', '?')} tokens | "
                f"输出: {usage.get('completion_tokens', '?')} tokens | "
                f"模型: {data.get('model', self.config.model)}"
            )
            return text

        except httpx.HTTPStatusError as e:
            logger.error(
                f"LLM API HTTP 错误: {e.response.status_code} "
                f"{e.response.text[:500]}"
            )
            return f"[LLM 错误: HTTP {e.response.status_code}]"
        except httpx.RequestError as e:
            logger.error(f"LLM API 网络错误: {e}")
            return f"[LLM 错误: 网络异常 — {e}]"
        except Exception as e:
            logger.exception(f"LLM API 未知错误: {e}")
            return f"[LLM 错误: {e}]"

    async def close(self):
        # 线程池中的同步 Client 用后即关，无需清理
        pass
