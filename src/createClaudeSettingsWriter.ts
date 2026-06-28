import * as path from "path";
import type { PreAuthRecommendation } from "./createPermissionAnalyzer.js";

// ── 类型 ──

export type ClaudeSettings = {
  permissions?: {
    allow?: string[];
    deny?: string[];
    ask?: string[];
  };
  [key: string]: unknown;
};

export const DEFAULT_CLAUDE_SETTINGS_PATH = ".claude/settings.json";

export type ClaudeSettingsWriterDeps = {
  writeFile: (filePath: string, content: string) => Promise<void>;
  readFile: (filePath: string) => Promise<string>;
  mkdir: (dirPath: string) => Promise<void>;
};

export type ClaudeSettingsWriter = {
  /** 写入预授权规则到指定项目的 Claude Code settings.json */
  writeSettings: (
    projectDir: string,
    allowRules: string[],
    /** 可选的规则元数据（包含 reason，用于生成注释） */
    ruleMeta?: Array<{ rule: string; reason: string }>,
  ) => Promise<void>;
  /** 生成 settings.json 内容文本（含注释），用于预览 */
  generateContent: (
    allowRules: string[],
    ruleMeta?: Array<{ rule: string; reason: string }>,
  ) => string;
};

// ── 写工具名单 ──

/** 绝不能出现在 allow 列表中的写工具 */
const WRITE_TOOL_PREFIXES = ["Write", "Edit"];

/** 危险的 Bash 子命令前缀 */
const DANGEROUS_BASH_PREFIXES = [
  "Bash(rm",
  "Bash(del ",
  "Bash(mv ",
  "Bash(move ",
  "Bash(cp ",
  "Bash(copy ",
  "Bash(rename",
  "Bash(npm",
  "Bash(npx",
  "Bash(yarn",
  "Bash(pnpm",
  "Bash(pip",
  "Bash(choco",
  "Bash(scoop",
  "Bash(winget",
  "Bash(reg",
  "Bash(format",
  "Bash(shutdown",
  "Bash(taskkill",
  "Bash(net ",
  "Bash(sc ",
  "Bash(diskpart",
  "Bash(chkdsk",
  "Bash(icacls",
  "Bash(takeown",
  "Bash(setx",
  "Bash(set ",
  "Bash(export",
  "Bash(curl",
  "Bash(wget",
  "Bash(rmdir",
  "Bash(rd ",
];

// ── 工厂函数 ──

export function createClaudeSettingsWriter(
  deps: ClaudeSettingsWriterDeps,
): ClaudeSettingsWriter {
  const { writeFile, readFile, mkdir } = deps;

  async function writeSettings(
    projectDir: string,
    allowRules: string[],
    ruleMeta?: Array<{ rule: string; reason: string }>,
  ): Promise<void> {
    // 过滤掉危险的写操作规则（安全网）
    const safeRules = allowRules.filter(isSafeAllowRule);

    // 尝试读取已有 settings
    let existing: ClaudeSettings = {};
    const settingsPath = path.join(projectDir, DEFAULT_CLAUDE_SETTINGS_PATH);
    try {
      const raw = await readFile(settingsPath);
      existing = JSON.parse(raw) as ClaudeSettings;
    } catch {
      // 文件不存在或解析失败 → 使用空配置
    }

    // 合并规则
    const merged = mergeAllowRules(existing, safeRules);

    // 生成内容
    const content = stringifySettings(merged, safeRules, ruleMeta);

    // 确保 .claude 目录存在
    const claudeDir = path.dirname(settingsPath);
    await mkdir(claudeDir);

    // 写入
    await writeFile(settingsPath, content);
  }

  function generateContent(
    allowRules: string[],
    ruleMeta?: Array<{ rule: string; reason: string }>,
  ): string {
    const safeRules = allowRules.filter(isSafeAllowRule);
    return stringifySettings(
      { permissions: { allow: safeRules, deny: [], ask: [] } },
      safeRules,
      ruleMeta,
    );
  }

  return { writeSettings, generateContent };
}

// ── 导出的工具函数 ──

/**
 * 合并新的 allow 规则到已有 settings 中。
 * - 保留已有 allow 规则
 * - 新规则追加并去重
 * - 保留已有 deny/ask 规则
 * - 保留 permissions 之外的设置项
 */
export function mergeAllowRules(
  existing: ClaudeSettings,
  newAllowRules: string[],
): ClaudeSettings {
  const existingAllow = existing.permissions?.allow ?? [];
  const existingDeny = existing.permissions?.deny ?? [];
  const existingAsk = existing.permissions?.ask ?? [];

  // 合并去重
  const mergedAllow = [...existingAllow];
  for (const rule of newAllowRules) {
    if (!mergedAllow.includes(rule)) {
      mergedAllow.push(rule);
    }
  }

  return {
    ...existing,
    permissions: {
      ...existing.permissions,
      allow: mergedAllow,
      deny: existingDeny,
      ask: existingAsk,
    },
  };
}

/**
 * 生成 settings.json 字符串（纯 JSON，不含注释）。
 * 用于测试和程序化处理。
 */
export function generateSettingsContent(
  allowRules: string[],
  _ruleMeta?: Array<{ rule: string; reason: string }>,
): string {
  const settings: ClaudeSettings = {
    permissions: {
      allow: allowRules,
      deny: [],
      ask: [],
    },
  };
  return JSON.stringify(settings, null, 2);
}

// ── 内部实现 ──

function isSafeAllowRule(rule: string): boolean {
  // 拒绝纯写工具
  if (WRITE_TOOL_PREFIXES.some((prefix) => rule === prefix)) {
    return false;
  }

  // 拒绝危险 Bash 命令
  if (
    DANGEROUS_BASH_PREFIXES.some((prefix) => rule.startsWith(prefix))
  ) {
    return false;
  }

  return true;
}

function stringifySettings(
  settings: ClaudeSettings,
  allowRules: string[],
  ruleMeta?: Array<{ rule: string; reason: string }>,
): string {
  const metaMap = new Map<string, string>();
  if (ruleMeta) {
    for (const { rule, reason } of ruleMeta) {
      metaMap.set(rule, reason);
    }
  }

  const lines: string[] = [];

  // 文件头注释
  lines.push("// ──────────────────────────────────────────────");
  lines.push("// Feishu Bridge — Claude Code 权限预配置");
  lines.push("//");
  lines.push("// 此文件由 Feishu Bridge 权限分析器自动生成。");
  lines.push(
    "// 纯读操作（Read/Glob/Grep/git log 等）已预授权，",
  );
  lines.push("// 不再经过飞书确认。");
  lines.push(
    "// 写操作（Write/Edit/Bash 危险命令）仍需要飞书确认。",
  );
  lines.push("//");
  lines.push("// 最后更新: " + new Date().toISOString());
  lines.push("// ──────────────────────────────────────────────");
  lines.push("");

  // 逐条规则注释
  const rulesCommentLines: string[] = [];
  for (const rule of allowRules) {
    const reason = metaMap.get(rule);
    if (reason) {
      rulesCommentLines.push(`//   "${rule}" — ${reason}`);
    } else {
      rulesCommentLines.push(`//   "${rule}"`);
    }
  }
  if (rulesCommentLines.length > 0) {
    lines.push("// 预授权规则说明:");
    lines.push(...rulesCommentLines);
    lines.push("");
  }

  // JSON 主体
  const json = JSON.stringify(settings, null, 2);
  lines.push(json);
  lines.push("");

  return lines.join("\n");
}
