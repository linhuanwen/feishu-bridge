import * as fs from "fs";
import * as path from "path";

export type StartupManagerOptions = {
  /** 启动文件夹路径（可注入用于测试） */
  startupDir?: string;
  /** 应用名称，用作快捷方式文件名 */
  appName: string;
  /** 启动时要执行的命令 */
  command: string;
};

export type StartupManager = {
  /** 创建开机自启条目 */
  enable: () => void;
  /** 移除开机自启条目 */
  disable: () => void;
  /** 检查是否已启用开机自启 */
  isEnabled: () => boolean;
  /** 获取启动文件夹路径 */
  getStartupPath: () => string;
};

/**
 * 获取 Windows 用户启动文件夹路径。
 * 通常为: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
 */
function getDefaultStartupDir(): string {
  const appData = process.env.APPDATA;
  if (!appData) {
    // 回退：构造路径
    const home = process.env.USERPROFILE ?? "C:\\Users\\Default";
    return path.join(home, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  }
  return path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
}

/**
 * 创建 Windows 开机自启管理器。
 *
 * 在启动文件夹中放置一个 .bat 文件来启动应用。
 * - enable()  创建启动脚本
 * - disable() 删除启动脚本
 * - isEnabled() 检查启动脚本是否存在
 */
export function createStartupManager(options: StartupManagerOptions): StartupManager {
  const startupDir = options.startupDir ?? getDefaultStartupDir();
  const safeName = options.appName.replace(/[<>:"/\\|?*]/g, "_");
  const shortcutPath = path.join(startupDir, `${safeName}.bat`);

  function enable(): void {
    fs.mkdirSync(startupDir, { recursive: true });

    // 写入启动批处理脚本
    const script = [
      "@echo off",
      `:: ${options.appName} — 开机自启`,
      `:: 由 createStartupManager 自动生成`,
      `cd /d "${process.cwd()}"`,
      options.command,
    ].join("\r\n");

    fs.writeFileSync(shortcutPath, script, "utf-8");
  }

  function disable(): void {
    try {
      fs.unlinkSync(shortcutPath);
    } catch {
      // 文件不存在时静默忽略
    }
  }

  function isEnabled(): boolean {
    return fs.existsSync(shortcutPath);
  }

  function getStartupPath(): string {
    return startupDir;
  }

  return { enable, disable, isEnabled, getStartupPath };
}
