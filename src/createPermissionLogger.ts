/**
 * Claude Code 权限请求日志条目。
 * 记录 Claude Code 在 task/inquire 执行过程中触发的每次工具权限请求。
 */
export type PermissionLogEntry = {
  timestamp: Date;
  /** 工具名：Read, Write, Edit, Bash, Glob, Grep, WebFetch, 等 */
  tool: string;
  /** 操作描述，如 "git log", "read file", "delete file" */
  operation: string;
  /** 操作目标，如文件路径、命令等 */
  target: string;
  /** 风险分类 */
  category: "read" | "write" | "unknown";
};

export type PermissionLogStats = {
  total: number;
  readCount: number;
  writeCount: number;
  byTool: Record<string, number>;
};

export type PermissionLogger = {
  /** 记录一条权限请求 */
  log: (entry: Omit<PermissionLogEntry, "timestamp">) => void;
  /** 获取全部日志 */
  getAll: () => PermissionLogEntry[];
  /** 按风险类别筛选 */
  getByCategory: (category: PermissionLogEntry["category"]) => PermissionLogEntry[];
  /** 按工具名筛选 */
  getByTool: (tool: string) => PermissionLogEntry[];
  /** 获取统计摘要 */
  getStats: () => PermissionLogStats;
  /** 清空日志 */
  clear: () => void;
};

export function createPermissionLogger(
  opts?: { now?: () => Date },
): PermissionLogger {
  const now = opts?.now ?? (() => new Date());
  const entries: PermissionLogEntry[] = [];

  function log(entry: Omit<PermissionLogEntry, "timestamp">): void {
    entries.push({ ...entry, timestamp: now() });
  }

  function getAll(): PermissionLogEntry[] {
    return [...entries];
  }

  function getByCategory(
    category: PermissionLogEntry["category"],
  ): PermissionLogEntry[] {
    return entries.filter((e) => e.category === category);
  }

  function getByTool(tool: string): PermissionLogEntry[] {
    return entries.filter((e) => e.tool === tool);
  }

  function getStats(): PermissionLogStats {
    const byTool: Record<string, number> = {};
    let readCount = 0;
    let writeCount = 0;

    for (const e of entries) {
      byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
      if (e.category === "read") readCount++;
      if (e.category === "write") writeCount++;
    }

    return {
      total: entries.length,
      readCount,
      writeCount,
      byTool,
    };
  }

  function clear(): void {
    entries.length = 0;
  }

  return { log, getAll, getByCategory, getByTool, getStats, clear };
}
