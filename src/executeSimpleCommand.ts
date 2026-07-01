import type { ListDirectoryResult } from "./listDirectory.js";
import type { CommandConfig } from "./commandConfig.js";
import type { SystemStatusResult } from "./getSystemStatus.js";
import { formatSystemStatus } from "./getSystemStatus.js";
import type { ProgramResult } from "./programManager.js";
import type { ScriptRunResult } from "./runScript.js";

/** 简单指令的返回结果：文本或图片 */
export type CommandReply =
  | { kind: "text"; content: string }
  | { kind: "image"; filePath: string };

export type SimpleCommandDeps = {
  listDirectory: (path: string) => Promise<ListDirectoryResult>;
  commandConfig: CommandConfig;
  /** 截图（可选） */
  captureScreenshot?: () => Promise<{ filePath: string }>;
  /** 系统状态查询（可选） */
  getSystemStatus?: () => Promise<SystemStatusResult>;
  /** 格式化系统状态为文本（可选，默认用 formatSystemStatus） */
  formatSystemStatus?: (result: SystemStatusResult) => string;
  /** 打开程序（可选） */
  openProgram?: (name: string) => Promise<ProgramResult>;
  /** 关闭程序（可选） */
  closeProgram?: (name: string) => Promise<ProgramResult>;
  /** 运行脚本（可选） */
  runScript?: (scriptPath: string) => Promise<ScriptRunResult>;
};

function formatDirectoryResult(path: string, result: ListDirectoryResult): string {
  if (!result.ok) {
    return result.error;
  }

  const lines = result.entries.map(
    (e) => `${e.name}  ${e.size}  ${e.modifiedAt}`,
  );

  return `📂 ${path}（${result.entries.length} 项）\n${lines.join("\n")}`;
}

/**
 * 根据配置匹配用户消息对应的指令。
 * - 无参指令：消息与别名完全相等
 * - 有参指令：消息以「别名 」或「别名」开头，提取参数
 */
export function matchCommand(
  message: string,
  config: CommandConfig,
): { commandId: string; arg: string } | null {
  const trimmed = message.trim();
  for (const cmd of config.commands) {
    for (const alias of cmd.aliases) {
      if (cmd.needsArg) {
        // 尝试「别名 参数」（有空格）
        const withSpace = alias + " ";
        if (trimmed.startsWith(withSpace)) {
          const arg = trimmed.slice(withSpace.length).trim();
          if (!isArgExcludedForAlias(alias, arg)) {
            return { commandId: cmd.id, arg };
          }
        }
        // 尝试「别名参数」（中文风格，无空格，如"打开Chrome"）
        if (trimmed.startsWith(alias) && trimmed.length > alias.length) {
          const arg = trimmed.slice(alias.length).trim();
          if (!isArgExcludedForAlias(alias, arg)) {
            return { commandId: cmd.id, arg };
          }
        }
      } else {
        // 无参指令：完全匹配
        if (trimmed === alias) {
          return { commandId: cmd.id, arg: "" };
        }
      }
    }
  }
  return null;
}

/**
 * 防御层：避免 simple 指令别名误匹配会话管理命令。
 * 例如 "列出对话" 不应被 "列出" 别名捕获为 listDirectory("对话")。
 */
function isArgExcludedForAlias(alias: string, arg: string): boolean {
  // "列出" / "目录" / "ls" / "dir" 的参数不能以会话关键词开头
  if (["ls", "dir", "列出", "目录"].includes(alias)) {
    const sessionKeywords = /^(对话|会话)/i;
    if (sessionKeywords.test(arg)) return true;
  }
  // "关闭" 的参数不应是 "对话"（避免与 Claude Code 的 / 命令概念混淆）
  if (["关闭", "退出", "结束"].includes(alias)) {
    if (/^对话/i.test(arg)) return true;
  }
  return false;
}

export async function executeSimpleCommand(
  message: string,
  deps: SimpleCommandDeps,
): Promise<CommandReply | null> {
  const match = matchCommand(message, deps.commandConfig);
  if (!match) return null;

  const { commandId, arg } = match;

  if (commandId === "listDirectory") {
    const result = await deps.listDirectory(arg);
    return { kind: "text", content: formatDirectoryResult(arg, result) };
  }

  if (commandId === "screenshot" && deps.captureScreenshot) {
    const { filePath } = await deps.captureScreenshot();
    return { kind: "image", filePath };
  }

  if (commandId === "systemStatus" && deps.getSystemStatus) {
    const status = await deps.getSystemStatus();
    const formatter = deps.formatSystemStatus ?? formatSystemStatus;
    return { kind: "text", content: formatter(status) };
  }

  if (commandId === "openProgram" && deps.openProgram) {
    const result = await deps.openProgram(arg);
    return { kind: "text", content: result.message };
  }

  if (commandId === "closeProgram" && deps.closeProgram) {
    const result = await deps.closeProgram(arg);
    return { kind: "text", content: result.message };
  }

  if (commandId === "runScript" && deps.runScript) {
    const result = await deps.runScript(arg);
    if (result.ok) {
      return { kind: "text", content: `✅ 脚本执行完成\n${result.stdout}` };
    }
    return { kind: "text", content: result.error };
  }

  return null;
}
