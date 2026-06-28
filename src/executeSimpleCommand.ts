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
          return { commandId: cmd.id, arg: trimmed.slice(withSpace.length).trim() };
        }
        // 尝试「别名参数」（中文风格，无空格，如"打开Chrome"）
        if (trimmed.startsWith(alias) && trimmed.length > alias.length) {
          return { commandId: cmd.id, arg: trimmed.slice(alias.length).trim() };
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
