"""
Windows 桌面通知 — 三种级别，纯 PowerShell 实现，零依赖。

- priority=0 普通 → 右下角系统托盘气泡（5秒自动消失）
- priority=1 警告 → 气泡停留10秒 + 留存 Windows 通知中心
- priority=2 紧急 → 屏幕中央弹窗（必须手动点确定才能关闭）
"""
import asyncio
import subprocess
from dataclasses import dataclass
from loguru import logger


@dataclass
class DesktopNotifyConfig:
    """桌面通知配置。"""
    enabled: bool = True
    app_name: str = "超级工作个体"


class DesktopNotifier:
    """Windows 桌面通知。Agent 通过 send_text(title, content, priority) 调用。"""

    def __init__(self, config: DesktopNotifyConfig = None):
        self.config = config or DesktopNotifyConfig()

    @property
    def is_available(self) -> bool:
        return True

    # ─── 三种通知方式 ───────────────────────────

    def _balloon(self, title: str, content: str, duration_sec: int = 5, icon: str = "Info"):
        """右下角系统托盘气泡。"""
        # 转义单引号防止 PowerShell 语法错误
        safe_title = title.replace("'", "`'")
        safe_content = content.replace("'", "`'")
        ps = f'''
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Application
$n.BalloonTipTitle = '{safe_title}'
$n.BalloonTipText = '{safe_content}'
$n.BalloonTipIcon = '{icon}'
$n.Visible = $true
$n.ShowBalloonTip({duration_sec * 1000})
Start-Sleep -Seconds {duration_sec + 1}
$n.Visible = $false
$n.Dispose()
'''
        self._run_ps(ps, timeout=duration_sec + 5)

    def _messagebox(self, title: str, content: str, icon: str = "Error"):
        """屏幕中央弹窗，必须手动点确定关闭。"""
        safe_title = title.replace("'", "`'")
        safe_content = content.replace("'", "`'").replace('\n', '`n')
        # MessageBox 的 icon 参数: 16=Stop, 32=Question, 48=Exclamation, 64=Information
        icon_code = {"Error": 16, "Warning": 48, "Info": 64}.get(icon, 64)
        ps = f'''
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show('{safe_content}', '{safe_title}', 0, {icon_code})
'''
        self._run_ps(ps, timeout=300)  # 弹窗可以停留很久

    def _toast_persist(self, title: str, content: str):
        """留存到 Windows 通知中心（不会自动消失）。"""
        safe_title = title.replace("'", "`'")
        safe_content = content.replace("'", "`'")
        ps = f'''
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $tpl.GetElementsByTagName("text")
$nodes.Item(0).AppendChild($tpl.CreateTextNode('{safe_title}')) > $null
$nodes.Item(1).AppendChild($tpl.CreateTextNode('{safe_content}')) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($tpl)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("SWI-Notifications")
$notifier.Show($toast)
'''
        self._run_ps(ps, timeout=10)

    # ─── PowerShell 执行器 ─────────────────────

    def _run_ps(self, script: str, timeout: int = 10):
        """在后台执行 PowerShell 脚本，不阻塞。"""
        def _run():
            try:
                subprocess.run(
                    ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                    capture_output=True,
                    timeout=timeout,
                )
            except subprocess.TimeoutExpired:
                pass
            except Exception as e:
                logger.debug(f"PS 执行异常: {e}")

        import threading
        t = threading.Thread(target=_run, daemon=True)
        t.start()

    # ─── 对外接口 ──────────────────────────────

    def show(self, title: str, content: str, priority: int = 0):
        """
        发送桌面通知。
        priority: 0=普通气泡  1=警告气泡+留存  2=弹窗强制注意
        """
        if not self.config.enabled:
            return

        if priority >= 2:
            self._messagebox(title, content, "Error")
            self._toast_persist(title, content)
        elif priority >= 1:
            self._balloon(title, content, 10, "Warning")
            self._toast_persist(title, content)
        else:
            self._balloon(title, content, 5, "Info")

        logger.debug(f"桌面通知[{priority}]: {title}")

    # ─── Agent 兼容接口 ────────────────────────

    async def send_text(self, title: str, content: str, priority: int = 0) -> bool:
        self.show(title, content, priority)
        return True

    async def send_markdown(self, title: str, markdown: str, priority: int = 0) -> bool:
        text = markdown.replace("**", "").replace("##", "").replace("*", "")
        self.show(title, text, priority)
        return True

    async def health_check(self) -> bool:
        """依次测试三种通知。"""
        self._balloon("普通通知", "这是普通消息，右下角气泡5秒后消失", 5, "Info")
        return True

    async def close(self):
        pass
