import { join } from "path";
import { tmpdir } from "os";
import type { execFile as ExecFileFn } from "child_process";

export type CaptureScreenshotDeps = {
  /** 执行系统命令（mock 边界）。生产环境留空以使用 execFile 安全调用。 */
  exec?: (command: string) => Promise<{ stdout: string; stderr: string }>;
  /** 截图保存目录，默认系统临时目录 */
  tmpDir?: string;
  /** 时间戳（可注入用于测试） */
  now?: () => Date;
};

/**
 * 调用 Windows PowerShell 截取整个桌面屏幕，保存为 PNG 文件。
 * 返回生成的文件路径。
 *
 * 安全：使用 $args[0] 传递文件路径而非嵌入脚本，避免 PowerShell 注入。
 * 生产环境使用 execFile 直接调用 PowerShell，绕过 shell。
 */
export async function captureScreenshot(
  deps: CaptureScreenshotDeps = {},
): Promise<{ filePath: string }> {
  const dir = deps.tmpDir ?? tmpdir();
  const now = deps.now ?? (() => new Date());
  const timestamp = now().toISOString().replace(/[:.]/g, "-");
  const filePath = join(dir, `screenshot-${timestamp}.png`);

  // PowerShell 脚本：使用 $args[0] 接收文件路径，避免嵌入用户可控值
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save($args[0], [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output 'screenshot saved'
`.trim();

  if (deps.exec) {
    // 测试路径：使用 mock（保持向后兼容）
    await deps.exec(`PowerShell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}" "${filePath.replace(/"/g, '\\"')}"`);
  } else {
    // 生产路径：使用 execFile 直接调用 PowerShell，filePath 作为独立参数传递
    const { execFile } = await import("child_process");
    await new Promise<void>((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", psScript, filePath],
        { timeout: 30_000 },
        (error) => {
          if (error) reject(error);
          else resolve();
        },
      );
    });
  }

  return { filePath };
}
