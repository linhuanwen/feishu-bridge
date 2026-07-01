"""
飞书 WebSocket 事件接收 — 通过长连接接收群消息，无需公网 URL。
使用 lark-oapi SDK: lark.ws.Client
"""
import asyncio
import json
import re
from loguru import logger
import lark_oapi as lark


class FeishuWSClient:
    """飞书长连接客户端。在后台线程运行。"""

    def __init__(self, app_id: str, app_secret: str, on_message=None, reply_func=None):
        self.app_id = app_id
        self.app_secret = app_secret
        self._on_message = on_message  # async callback(text, chat_id, msg_id)
        self._reply_func = reply_func  # async callback(msg_id, text)
        self._running = False
        self._task = None

    def _make_event_handler(self):
        """构建飞书事件处理器。"""
        # 捕获主线程的 event loop（用于回调）
        try:
            main_loop = asyncio.get_running_loop()
        except RuntimeError:
            main_loop = asyncio.get_event_loop()

        def on_im_message_receive(data: lark.im.v1.P2ImMessageReceiveV1):
            """收到消息事件。"""
            try:
                msg = data.event.message
                chat_id = msg.chat_id
                msg_id = msg.message_id

                # 提取文本
                text = ""
                if msg.msg_type == "text":
                    try:
                        text = json.loads(msg.content).get("text", "")
                    except Exception:
                        text = msg.content

                # 去 @机器人
                if msg.mentions:
                    for m in msg.mentions:
                        if m.name:
                            text = text.replace(f"@{m.name}", "").strip()

                if text and self._on_message:
                    logger.info(f"飞书消息: '{text[:50]}'")
                    asyncio.run_coroutine_threadsafe(
                        self._on_message(text, chat_id, msg_id),
                        main_loop,
                    )
            except Exception as e:
                logger.error(f"飞书消息处理失败: {e}")

        return (
            lark.EventDispatcherHandler
            .builder("", "")
            .register_p2_im_message_receive_v1(on_im_message_receive)
            .build()
        )

    async def start(self):
        """后台启动飞书 WebSocket（独立线程，带自动重连）。"""
        self._running = True

        def _run():
            import time
            import nest_asyncio
            nest_asyncio.apply()

            handler = self._make_event_handler()

            retry_delays = [5, 15, 30, 60, 120]  # 重试间隔（秒），逐次加长
            retry_index = 0

            while self._running:
                try:
                    client = lark.ws.Client(
                        self.app_id,
                        self.app_secret,
                        event_handler=handler,
                        log_level=lark.LogLevel.INFO,
                    )
                    logger.info("飞书 WebSocket 连接中...")
                    client.start()
                    # client.start() 是阻塞的，返回说明连接断开
                    logger.warning("飞书 WebSocket 连接断开，将自动重连...")
                    retry_index = 0  # 成功连接后重置重试计数
                except Exception as e:
                    msg = str(e)
                    if "timeout" in msg.lower() or "Timeout" in type(e).__name__:
                        logger.warning(f"飞书 WS 连接超时，将重试...")
                    else:
                        logger.error(f"飞书 WS 异常: {e}")

                if not self._running:
                    break

                # 等待后重试
                delay = retry_delays[min(retry_index, len(retry_delays) - 1)]
                logger.info(f"飞书 WS {delay}s 后重试 (第 {retry_index + 1} 次)...")
                time.sleep(delay)
                retry_index += 1

        import threading
        t = threading.Thread(target=_run, daemon=True)
        t.start()
        logger.info("飞书 WebSocket 后台已启动（自动重连）")

    async def stop(self):
        self._running = False
