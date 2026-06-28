import type { PermissionLogEntry } from "./createPermissionLogger.js";

// ── 工具分类常量 ──

/** 始终安全的纯读工具 — 可以直接预授权 */
export const READ_ONLY_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
] as const;

/** 始终需要确认的写工具 — 绝不能预授权 */
export const WRITE_TOOLS = ["Write", "Edit"] as const;

/** Bash 安全子命令模式 — 纯读操作，可预授权 */
export const SAFE_BASH_PATTERNS = [
  "git log",
  "git diff",
  "git status",
  "git show",
  "git branch",
  "git tag",
  "git remote",
  "git config",
  "git rev-parse",
  "git rev-list",
  "dir ",
  "ls ",
  "type ",
  "cat ",
  "echo ",
  "tree ",
  "find ",
  "which ",
  "where ",
  "head ",
  "tail ",
  "wc ",
] as const;

/** Bash 危险子命令模式 — 写/破坏性操作，绝不能预授权 */
export const DANGEROUS_BASH_PATTERNS = [
  "rm ",
  "del ",
  "rmdir ",
  "rd ",
  "move ",
  "mv ",
  "copy ",
  "cp ",
  "rename ",
  "ren ",
  "npm install",
  "npm uninstall",
  "npm update",
  "npm run",
  "npm exec",
  "npx ",
  "yarn add",
  "yarn remove",
  "pnpm add",
  "pnpm remove",
  "pip install",
  "pip uninstall",
  "choco install",
  "choco uninstall",
  "scoop install",
  "scoop uninstall",
  "winget install",
  "winget uninstall",
  "reg ",
  "format ",
  "shutdown",
  "taskkill",
  "tskill",
  "net ",
  "sc ",
  "diskpart",
  "chkdsk",
  "icacls",
  "takeown",
  "setx",
  "set ",
  "export ",
  "curl ",
  "wget ",
] as const;

// ── 分类函数 ──

/**
 * 判断一个工具+操作组合的风险分类。
 *
 * 规则优先级：
 * 1. 纯读工具（Read/Glob/Grep/WebFetch/WebSearch）→ read
 * 2. 纯写工具（Write/Edit）→ write
 * 3. Bash：检查子命令
 *    - 匹配安全模式 → read
 *    - 匹配危险模式 → write
 *    - 未知命令 → write（安全优先）
 * 4. 其他未知工具 → unknown
 */
export function classifyToolOperation(
  tool: string,
  operation: string,
): "read" | "write" | "unknown" {
  // 纯读工具
  if ((READ_ONLY_TOOLS as readonly string[]).includes(tool)) {
    return "read";
  }

  // 纯写工具
  if ((WRITE_TOOLS as readonly string[]).includes(tool)) {
    return "write";
  }

  // Bash 需要检查子命令
  if (tool === "Bash") {
    return classifyBashOperation(operation);
  }

  // 未知工具 — 不过度假设
  return "unknown";
}

function classifyBashOperation(operation: string): "read" | "write" {
  const normalized = operation.toLowerCase().trim();

  // 先检查危险模式（优先级更高）
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (normalized.startsWith(pattern.toLowerCase())) {
      return "write";
    }
  }

  // 再检查安全模式
  for (const pattern of SAFE_BASH_PATTERNS) {
    if (normalized.startsWith(pattern.toLowerCase())) {
      return "read";
    }
  }

  // 未知 Bash 命令 → write（安全优先）
  return "write";
}

// ── 推荐 & 报告类型 ──

export type PreAuthRecommendation = {
  /** 工具名 */
  tool: string;
  /** 预授权规则字符串，如 "Read", "Bash(git log:*)" */
  rule: string;
  /** 预授权理由 */
  reason: string;
  /** 该操作被记录到的次数 */
  frequency: number;
};

export type AnalysisReport = {
  totalRequests: number;
  readOnlyRequests: number;
  writeRequests: number;
  unknownRequests: number;
  /** 按工具分组的计数 */
  byTool: Record<string, number>;
  /** 推荐的预授权规则列表（仅 read 操作） */
  recommendations: PreAuthRecommendation[];
};

export type PermissionAnalyzer = {
  /** 分析日志并生成报告 */
  analyze: (logs: PermissionLogEntry[]) => AnalysisReport;
  /** 将报告格式化为可读的文本摘要 */
  formatSummary: (report: AnalysisReport) => string;
};

// ── 工厂函数 ──

export function createPermissionAnalyzer(): PermissionAnalyzer {
  function analyze(logs: PermissionLogEntry[]): AnalysisReport {
    const byTool: Record<string, number> = {};
    let readOnlyRequests = 0;
    let writeRequests = 0;
    let unknownRequests = 0;

    // 按工具统计
    for (const entry of logs) {
      byTool[entry.tool] = (byTool[entry.tool] ?? 0) + 1;
      if (entry.category === "read") readOnlyRequests++;
      else if (entry.category === "write") writeRequests++;
      else unknownRequests++;
    }

    // 生成推荐
    const recommendations = generateRecommendations(logs);

    return {
      totalRequests: logs.length,
      readOnlyRequests,
      writeRequests,
      unknownRequests,
      byTool,
      recommendations,
    };
  }

  function formatSummary(report: AnalysisReport): string {
    const lines: string[] = [
      `📊 权限请求分析报告`,
      `总计请求：${report.totalRequests}`,
      `  纯读操作：${report.readOnlyRequests}`,
      `  写操作：${report.writeRequests}`,
      `  未知：${report.unknownRequests}`,
      ``,
      `🔧 工具使用频率：`,
    ];

    for (const [tool, count] of Object.entries(report.byTool).sort(
      (a, b) => b[1] - a[1],
    )) {
      lines.push(`  ${tool}: ${count} 次`);
    }

    if (report.recommendations.length > 0) {
      lines.push(``);
      lines.push(`✅ 建议预授权的规则（${report.recommendations.length} 条）：`);
      for (const rec of report.recommendations) {
        lines.push(`  ${rec.rule}  — ${rec.reason}（${rec.frequency} 次）`);
      }
    }

    return lines.join("\n");
  }

  return { analyze, formatSummary };
}

// ── 推荐生成逻辑 ──

function generateRecommendations(
  logs: PermissionLogEntry[],
): PreAuthRecommendation[] {
  const recommendations: PreAuthRecommendation[] = [];
  const seen = new Set<string>();

  // 按工具+操作分组统计
  const grouped = groupByToolAndOperation(logs);

  for (const [key, entries] of grouped) {
    if (entries.length === 0) continue;
    const entry = entries[0];

    // 只推荐纯读操作
    if (entry.category !== "read") continue;

    const rule = buildAllowRule(entry.tool, entry.operation);
    if (!rule || seen.has(rule)) continue;
    seen.add(rule);

    recommendations.push({
      tool: entry.tool,
      rule,
      reason: buildReason(entry.tool, entry.operation),
      frequency: entries.length,
    });
  }

  // 按频率降序排列
  recommendations.sort((a, b) => b.frequency - a.frequency);

  return recommendations;
}

function groupByToolAndOperation(
  logs: PermissionLogEntry[],
): Map<string, PermissionLogEntry[]> {
  const map = new Map<string, PermissionLogEntry[]>();

  for (const entry of logs) {
    // Bash 按子命令前缀分组，其他工具只按工具名分组
    const key =
      entry.tool === "Bash"
        ? `Bash:${extractBashSubCommand(entry.operation)}`
        : entry.tool;

    const existing = map.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      map.set(key, [entry]);
    }
  }

  return map;
}

function extractBashSubCommand(operation: string): string {
  const normalized = operation.trim().toLowerCase();
  // 取第一个空格前的部分作为子命令名
  const spaceIdx = normalized.indexOf(" ");
  if (spaceIdx === -1) return normalized;
  return normalized.slice(0, spaceIdx);
}

function buildAllowRule(tool: string, operation: string): string | null {
  if ((READ_ONLY_TOOLS as readonly string[]).includes(tool)) {
    return tool;
  }

  if (tool === "Bash") {
    const subCommand = extractBashSubCommand(operation);
    // 为安全 Bash 命令生成规则
    const isSafe = (SAFE_BASH_PATTERNS as readonly string[]).some((p) =>
      p.toLowerCase().startsWith(subCommand),
    );
    if (isSafe) {
      return `Bash(${subCommand}:*)`;
    }
    return null;
  }

  return null;
}

function buildReason(tool: string, operation: string): string {
  if ((READ_ONLY_TOOLS as readonly string[]).includes(tool)) {
    return `纯读操作，不修改文件系统`;
  }

  if (tool === "Bash") {
    const subCommand = extractBashSubCommand(operation);
    if (subCommand.startsWith("git")) {
      return `Git 只读查询，安全无害`;
    }
    if (
      ["dir", "ls", "type", "cat", "echo", "tree", "find", "which", "where", "head", "tail", "wc"].includes(
        subCommand,
      )
    ) {
      return `文件浏览/查看命令，只读操作`;
    }
  }

  return `低风险操作`;
}
