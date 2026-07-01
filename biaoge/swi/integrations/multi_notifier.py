"""
多通道通知器 — 同时向钉钉和桌面发送通知。
Agent 调用一个接口，消息自动分发到所有已启用的通知通道。
"""
from loguru import logger


class MultiNotifier:
    """
    聚合多个通知后端，Agent 只跟这一个对象交互。
    用法和单个 notifier 完全一样。
    """

    def __init__(self):
        self._backends = []           # [(name, notifier_instance)]
        self._desktop = None          # 桌面通知的快捷引用

    def add(self, name: str, notifier):
        """注册一个通知后端。"""
        self._backends.append((name, notifier))
        if name == "desktop":
            self._desktop = notifier
        logger.debug(f"通知后端已注册: {name}")

    @property
    def is_available(self) -> bool:
        return any(n.is_available if hasattr(n, 'is_available') else True
                   for _, n in self._backends)

    @property
    def desktop(self):
        """直接访问桌面通知器（用于桌面专属功能）。"""
        return self._desktop

    # ─── 标准接口（兼容原 dingtalk_bot 的调用方式）────

    async def send_text(self, title: str, content: str, priority: int = 0) -> bool:
        """发送文本到所有已启用后端。"""
        results = []
        for name, backend in self._backends:
            try:
                if hasattr(backend, 'send_text'):
                    ok = await backend.send_text(title, content, priority)
                    results.append(ok)
                else:
                    ok = backend.send_text(title, content, priority)
                    # 有的后端可能是同步的
            except Exception as e:
                logger.error(f"通知后端 [{name}] 发送失败: {e}")
                results.append(False)
        return any(results)  # 至少有一个成功就算成功

    async def send_markdown(self, title: str, markdown: str, priority: int = 0) -> bool:
        """发送 Markdown 到所有已启用后端。"""
        results = []
        for name, backend in self._backends:
            try:
                if hasattr(backend, 'send_markdown'):
                    ok = await backend.send_markdown(title, markdown, priority)
                else:
                    ok = await backend.send_text(title, markdown, priority)
                results.append(ok)
            except Exception as e:
                logger.error(f"通知后端 [{name}] 发送失败: {e}")
                results.append(False)
        return any(results)

    async def health_check(self) -> bool:
        """测试所有后端连通性。"""
        results = []
        for name, backend in self._backends:
            try:
                if hasattr(backend, 'health_check'):
                    ok = await backend.health_check()
                else:
                    ok = True
                results.append(ok)
                if ok:
                    logger.info(f"  后端 [{name}] 连接正常")
            except Exception as e:
                logger.error(f"  后端 [{name}] 连接失败: {e}")
                results.append(False)
        return any(results)

    async def close(self):
        """关闭所有后端。"""
        for name, backend in self._backends:
            try:
                if hasattr(backend, 'close'):
                    await backend.close()
            except Exception as e:
                logger.warning(f"关闭后端 [{name}] 时出错: {e}")
