import * as fs from "fs";
import * as path from "path";

export type RotatingLoggerOptions = {
  logDir: string;
  retentionDays: number;
  now?: () => Date;
};

/**
 * 创建按天轮转的文件日志记录器。
 *
 * - 日志写入 `feishu-bridge-YYYY-MM-DD.log`
 * - 日期变更时自动切换到新文件
 * - 启动时清理超过 retentionDays 天的旧日志
 * - 返回 `(msg: string) => void`，兼容现有 logger 签名
 */
export function createRotatingLogger(
  options: RotatingLoggerOptions,
): (msg: string) => void {
  const { logDir, retentionDays } = options;
  const getNow = options.now ?? (() => new Date());

  // 确保日志目录存在
  fs.mkdirSync(logDir, { recursive: true });

  // 启动时清理旧日志
  cleanOldLogs(logDir, retentionDays, getNow());

  let currentDate = dateString(getNow());

  function getLogPath(date: string): string {
    return path.join(logDir, `feishu-bridge-${date}.log`);
  }

  function formatTimestamp(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const s = String(date.getSeconds()).padStart(2, "0");
    return `[${y}-${m}-${d}T${h}:${min}:${s}]`;
  }

  return (msg: string): void => {
    const now = getNow();
    const today = dateString(now);

    // 日期变更 → 切换文件
    if (today !== currentDate) {
      currentDate = today;
      // 切换时也顺便清理旧日志
      cleanOldLogs(logDir, retentionDays, now);
    }

    const line = `${formatTimestamp(now)} ${msg}\n`;
    fs.appendFileSync(getLogPath(currentDate), line, "utf-8");
  };
}

function dateString(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 清理超过 retentionDays 天的旧日志文件。
 * 只删除匹配 `feishu-bridge-YYYY-MM-DD.log` 模式的文件。
 */
function cleanOldLogs(
  logDir: string,
  retentionDays: number,
  now: Date,
): void {
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = dateString(cutoff);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return;
  }

  const logPattern = /^feishu-bridge-(\d{4}-\d{2}-\d{2})\.log$/;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(logPattern);
    if (!match) continue; // 跳过非日志文件

    const fileDate = match[1];
    if (fileDate < cutoffStr) {
      fs.unlinkSync(path.join(logDir, entry.name));
    }
  }
}
