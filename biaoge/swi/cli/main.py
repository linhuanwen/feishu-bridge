"""
命令行入口 — Click-based CLI。
用法:
    python run.py start       启动系统
    python run.py stop        停止系统
    python run.py status      查看状态
    python run.py trigger <id> 手动触发Agent
    python run.py test-msg    测试钉钉消息
"""
import asyncio
import signal
import sys
from pathlib import Path
import click

PROJECT_DIR = Path(__file__).parent.parent.parent


def _get_runner():
    """延迟导入，避免 CLI 启动时的导入延迟。"""
    from swi.core.runner import Runner
    return Runner(PROJECT_DIR)


@click.group()
@click.version_option(version="0.1.0", prog_name="swi")
def cli():
    """超级工作个体 -- AI 个人工作管家"""
    pass


@cli.command()
@click.option("--dashboard/--no-dashboard", default=True, help="是否启动 Web 仪表盘")
def start(dashboard):
    """启动系统（调度器 + 可选仪表盘）。"""
    runner = _get_runner()

    async def _start():
        await runner.initialize()
        if dashboard:
            await runner.start_dashboard()
        await runner.start_scheduler()
        click.echo("[OK] 系统运行中... 按 Ctrl+C 停止")

        # 等待停止信号
        stop_event = asyncio.Event()
        loop = asyncio.get_running_loop()
        if sys.platform == "win32":
            # Windows 上用 signal
            def _handler(signum, frame):
                click.echo("\n[STOP] 收到停止信号...")
                stop_event.set()
            for sig in (signal.SIGINT, signal.SIGTERM):
                try:
                    signal.signal(sig, _handler)
                except Exception:
                    pass
        else:
            loop.add_signal_handler(signal.SIGINT, stop_event.set)
            loop.add_signal_handler(signal.SIGTERM, stop_event.set)

        await stop_event.wait()
        await runner.shutdown()
        click.echo("[BYE] 系统已停止")

    try:
        asyncio.run(_start())
    except (RuntimeError, asyncio.CancelledError) as e:
        # nest_asyncio + lark WS 可能导致事件循环关闭异常，
        # 此时 uvicorn 已正常退出，忽略关闭阶段的错误
        msg = str(e)
        if "running event loop" in msg or "cancel" in msg.lower():
            click.echo("[BYE] 系统已停止")
        else:
            raise


@cli.command()
def status():
    """查看所有 Agent 状态。"""
    runner = _get_runner()

    async def _status():
        await runner.initialize()
        agents = runner.list_agents()
        if not agents:
            click.echo("[WARN] 没有注册的 Agent")
        else:
            click.echo(f"\n{'Agent ID':<20} {'名称':<12} {'周期':<16} {'状态':<6} {'下次运行'}")
            click.echo("-" * 80)
            for a in agents:
                status_icon = "[ON]" if a["enabled"] else "[OFF]"
                click.echo(
                    f"{a['agent_id']:<20} "
                    f"{a['agent_name']:<12} "
                    f"{a['schedule']:<16} "
                    f"{status_icon:<6} "
                    f"{a['next_run'] or '未调度'}"
                )
        await runner.shutdown()

    asyncio.run(_status())


@cli.command()
@click.argument("agent_id")
def trigger(agent_id):
    """手动触发指定 Agent 立即执行。"""
    runner = _get_runner()

    async def _trigger():
        await runner.initialize()
        try:
            result = await runner.trigger_agent(agent_id)
            icon = {"success": "[OK]", "warning": "[WARN]", "error": "[ERR]"}.get(result.status, "?")
            click.echo(f"{icon} Agent [{agent_id}] 执行完成")
            click.echo(f"   状态: {result.status}")
            click.echo(f"   摘要: {result.summary}")
            if result.error:
                click.echo(f"   错误: {result.error}")
        except ValueError as e:
            click.echo(f"[ERR] {e}")
        await runner.shutdown()

    asyncio.run(_trigger())


@cli.command()
def trigger_all():
    """手动触发所有已启用 Agent。"""
    runner = _get_runner()

    async def _trigger_all():
        await runner.initialize()
        results = await runner.trigger_all()
        for agent_id, result in results.items():
            icon = {"success": "[OK]", "warning": "[WARN]", "error": "[ERR]"}.get(result.status, "?")
            click.echo(f"{icon} [{agent_id}] {result.summary}")
        await runner.shutdown()

    asyncio.run(_trigger_all())


@cli.command()
def test_msg():
    """发送一条测试消息到钉钉，验证配置是否正确。"""
    runner = _get_runner()

    async def _test():
        await runner.initialize(init_db=False)
        ok = await runner.test_dingtalk()
        if ok:
            click.echo("[OK] 钉钉测试消息发送成功！请检查你的钉钉群。")
        else:
            click.echo("[ERR] 钉钉测试消息发送失败，请检查 config/dingtalk.yaml 中的 webhook_url")
        await runner.shutdown()

    asyncio.run(_test())


@cli.command()
def test_desktop():
    """测试桌面通知，弹一条测试消息。"""
    runner = _get_runner()

    async def _test():
        await runner.initialize(init_db=False)
        ok = await runner.test_desktop()
        if ok:
            click.echo("[OK] 桌面通知测试成功！请查看屏幕右下角。")
        else:
            click.echo("[ERR] 桌面通知测试失败")
        await runner.shutdown()

    asyncio.run(_test())


@cli.command()
def init():
    """初始化数据库和配置文件（首次使用）。"""
    from swi.data.engine import init_database
    from swi.utils.logging_setup import setup_logging

    setup_logging("INFO", str(PROJECT_DIR / "logs"))

    async def _init():
        await init_database(str(PROJECT_DIR / "data"))
        click.echo("[OK] 数据库初始化完成")

    asyncio.run(_init())
    click.echo("[OK] 系统初始化完成，请编辑 config/dingtalk.yaml 配置钉钉 Webhook")


if __name__ == "__main__":
    cli()
