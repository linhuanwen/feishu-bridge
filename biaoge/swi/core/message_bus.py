"""
消息总线 — 进程内发布/订阅，基于 asyncio.Queue。
轻量实现，不依赖外部 MQ。
"""
import asyncio
from collections import defaultdict
from typing import Callable, Awaitable
from loguru import logger

from swi.core.event_types import Event, EventType


# 回调函数签名：async def handler(event: Event) -> None
EventHandler = Callable[[Event], Awaitable[None]]


class MessageBus:
    """
    进程内事件总线。
    - 支持按 EventType 订阅
    - 支持通配符 "*" 订阅所有事件
    - 异步发布，不阻塞发布者
    """

    def __init__(self):
        self._subscribers: dict[str, list[EventHandler]] = defaultdict(list)
        self._event_log: list[Event] = []        # 最近事件记录
        self._max_log_size: int = 1000
        self._running = False
        self._queue: asyncio.Queue = asyncio.Queue()
        self._worker_task = None

    # ─── 订阅管理 ────────────────────────────────

    def subscribe(self, event_type: str, handler: EventHandler):
        """订阅特定事件类型。event_type 可以是 EventType 枚举值或 "*"。"""
        self._subscribers[event_type].append(handler)
        logger.debug(f"订阅: {event_type} -> {handler.__name__ if hasattr(handler, '__name__') else handler}")

    def unsubscribe(self, event_type: str, handler: EventHandler):
        """取消订阅。"""
        if event_type in self._subscribers:
            self._subscribers[event_type] = [
                h for h in self._subscribers[event_type] if h != handler
            ]

    # ─── 发布 ────────────────────────────────────

    def publish(self, event: Event):
        """发布事件到队列（同步方法，不阻塞）。"""
        if not self._running:
            logger.warning(f"消息总线未启动，事件丢弃: {event.type}")
            return
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            logger.error("事件队列已满，事件丢弃")

    # ─── 生命周期 ────────────────────────────────

    async def start(self):
        """启动消息总线，开始处理事件。"""
        self._running = True
        self._worker_task = asyncio.create_task(self._worker())
        logger.info("消息总线已启动")

    async def stop(self):
        """停止消息总线。"""
        self._running = False
        if self._worker_task:
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
        logger.info("消息总线已停止")

    # ─── 内部 ────────────────────────────────────

    async def _worker(self):
        """后台工作协程，从队列取事件并分发。"""
        while self._running:
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                await self._dispatch(event)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error(f"事件分发异常: {e}")

    async def _dispatch(self, event: Event):
        """分发事件给所有匹配的订阅者。"""
        # 记录事件
        self._event_log.append(event)
        if len(self._event_log) > self._max_log_size:
            self._event_log = self._event_log[-self._max_log_size:]

        # 找到匹配的订阅者
        handlers = []
        if event.type in self._subscribers:
            handlers.extend(self._subscribers[event.type])
        if "*" in self._subscribers:
            handlers.extend(self._subscribers["*"])

        if not handlers:
            return

        # 并发通知所有订阅者
        tasks = []
        for handler in handlers:
            tasks.append(self._safe_call(handler, event))
        if tasks:
            await asyncio.gather(*tasks)

    async def _safe_call(self, handler: EventHandler, event: Event):
        """安全调用处理器，捕获异常。"""
        try:
            await handler(event)
        except Exception as e:
            logger.error(f"事件处理器异常 [{handler.__name__ if hasattr(handler, '__name__') else handler}]: {e}")

    # ─── 查询 ────────────────────────────────────

    def recent_events(self, limit: int = 50, event_type: str = None) -> list[Event]:
        """获取最近的事件记录。"""
        events = self._event_log
        if event_type:
            events = [e for e in events if e.type == event_type]
        return events[-limit:]

    @property
    def subscriber_count(self) -> int:
        return sum(len(h) for h in self._subscribers.values())

    @property
    def queue_size(self) -> int:
        return self._queue.qsize()
