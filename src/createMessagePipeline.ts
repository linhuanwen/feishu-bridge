import { handleClassifiedMessage } from "./handleClassifiedMessage.js";
import {
  executeSimpleCommand,
  matchCommand,
  type CommandReply,
} from "./executeSimpleCommand.js";
import type { IntentLabel } from "./classifyIntent.js";
import type { ListDirectoryResult } from "./listDirectory.js";
import type { CommandConfig } from "./commandConfig.js";
import type { InquireResult } from "./executeInquire.js";
import type { TaskResult } from "./executeTask.js";
import type {
  FeishuMessageEvent,
  MessageHandlerContext,
  Operation,
} from "./types.js";
import type { FeishuBridgeDeps } from "./createFeishuBridge.js";
import type { PermissionGate } from "./createPermissionGate.js";
import type { SystemStatusResult } from "./getSystemStatus.js";
import type { ProgramResult } from "./programManager.js";
import type { ScriptRunResult } from "./runScript.js";

export type MessagePipelineDeps = {
  classifyIntent: (message: string) => Promise<IntentLabel>;
  isSenderAllowed: (openId: string) => boolean;
  listDirectory: (path: string) => Promise<ListDirectoryResult>;
  /** 可选：指令配置表 */
  commandConfig?: CommandConfig;
  /** 可选：高危操作确认门 */
  permissionGate?: PermissionGate;
  /** 可选：从消息文本中提取 Operation，用于权限判断 */
  extractOperation?: (message: string) => Operation | null;
  /** 可选：文件内容查询执行器（Claude Code 单次调用） */
  executeInquire?: (message: string) => Promise<InquireResult>;
  /** 可选：复杂任务执行器（Claude Code 会话管理） */
  executeTask?: (message: string, chatId: string) => Promise<TaskResult>;
  /** 可选：截图 */
  captureScreenshot?: () => Promise<{ filePath: string }>;
  /** 可选：系统状态查询 */
  getSystemStatus?: () => Promise<SystemStatusResult>;
  /** 可选：格式化系统状态 */
  formatSystemStatus?: (result: SystemStatusResult) => string;
  /** 可选：打开程序 */
  openProgram?: (name: string) => Promise<ProgramResult>;
  /** 可选：关闭程序 */
  closeProgram?: (name: string) => Promise<ProgramResult>;
  /** 可选：运行脚本 */
  runScript?: (scriptPath: string) => Promise<ScriptRunResult>;
};

/** 内置的最简指令配置，保证向后兼容 */
const DEFAULT_COMMAND_CONFIG: CommandConfig = {
  commands: [
    { id: "listDirectory", aliases: ["ls", "dir", "列出", "目录"], needsArg: true },
  ],
  scriptWhitelist: [],
  programMap: {},
};

export function createMessagePipeline(deps: MessagePipelineDeps) {
  const {
    classifyIntent,
    isSenderAllowed,
    listDirectory,
    permissionGate,
    executeInquire,
    executeTask,
    captureScreenshot,
    getSystemStatus,
    formatSystemStatus,
    openProgram,
    closeProgram,
    runScript,
  } = deps;
  const commandConfig = deps.commandConfig ?? DEFAULT_COMMAND_CONFIG;
  const extractOperation =
    deps.extractOperation ??
    ((message: string) => extractOperationFromMessage(message, commandConfig));

  const runSimpleCommand = (message: string): Promise<CommandReply | null> =>
    executeSimpleCommand(message, {
      listDirectory,
      commandConfig,
      captureScreenshot,
      getSystemStatus,
      formatSystemStatus,
      openProgram,
      closeProgram,
      runScript,
    });

  function textResult(text: string): CommandReply {
    return { kind: "text", content: text };
  }

  /** 带权限门保护的指令执行 */
  async function guardedExecute(
    chatId: string,
    message: string,
    openId: string | undefined,
    logger: (msg: string) => void,
  ): Promise<CommandReply | null> {
    if (!permissionGate) {
      return runSimpleCommand(message);
    }

    const operation = extractOperation(message);

    if (!operation) {
      return runSimpleCommand(message);
    }

    // 经过确认门 —— execute 回调适配为返回 string
    const guardResult = await permissionGate.guard(
      chatId,
      operation,
      async () => {
        const result = await runSimpleCommand(message);
        if (result === null) return "未知指令。支持的命令：ls <路径>、列出 <路径>、截图、状态、打开 <程序>、关闭 <程序>、运行 <脚本>";
        if (result.kind === "image") return `📷 截图已生成: ${result.filePath}`;
        return result.content;
      },
      undefined, // timeoutMs 使用默认值
      openId,
    );

    if (guardResult.status === "allowed" || guardResult.status === "allowed_always") {
      if (guardResult.result) {
        return textResult(guardResult.result);
      }
      return null;
    }

    if (guardResult.status === "timeout") {
      logger(`[Pipeline] 高危操作确认超时: ${operation.action}: ${operation.target}`);
      return textResult("⏰ 确认超时，操作已取消。");
    }

    // denied
    logger(`[Pipeline] 高危操作被用户拒绝: ${operation.action}: ${operation.target}`);
    return textResult("🚫 操作已取消。");
  }

  const onMessage: NonNullable<FeishuBridgeDeps["onMessage"]> = async (
    event: FeishuMessageEvent,
    ctx,
  ) => {
    const openId = event.sender?.sender_id?.open_id;
    await handleClassifiedMessage(event, {
      sendReply: ctx.sendReply,
      sendImageReply: ctx.sendImageReply,
      sendPostReply: ctx.sendPostReply,
      deleteMessage: ctx.deleteMessage,
      classifyIntent,
      isSenderAllowed,
      executeSimpleCommand: async (message: string) =>
        guardedExecute(event.message.chat_id, message, openId, ctx.logger),
      executeInquire,
      executeTask,
      logger: ctx.logger,
    });
  };

  return { onMessage };
}

/** commandId → Operation.action 映射 */
const COMMAND_ACTION_MAP: Record<string, string> = {
  listDirectory: "list_dir",
  screenshot: "screenshot",
  systemStatus: "status",
  openProgram: "open_app",
  closeProgram: "close_app",
  runScript: "run_script",
};

/**
 * 从消息文本中提取 Operation。
 * 优先通过 commandConfig 匹配（与 executeSimpleCommand 共享匹配逻辑），
 * 再补充未在配置表中注册的特殊操作。
 */
function extractOperationFromMessage(
  message: string,
  commandConfig: CommandConfig,
): Operation | null {
  // 1. 通过 commandConfig 匹配（与 executeSimpleCommand 共享逻辑）
  const cmdMatch = matchCommand(message, commandConfig);
  if (cmdMatch) {
    const action = COMMAND_ACTION_MAP[cmdMatch.commandId] ?? cmdMatch.commandId;
    return {
      action,
      target: cmdMatch.arg || message.trim(),
    };
  }

  // 2. 额外的高危操作模式（尚未在 commandConfig 中注册）
  // 删除 → 高危 delete
  const deleteMatch = message.match(/^(?:删除|del|rm|remove)\s+(.+)/i);
  if (deleteMatch) {
    return { action: "delete", target: deleteMatch[1].trim() };
  }

  // 安装 → 高危 install
  const installMatch = message.match(/^(?:安装|install)\s+(.+)/i);
  if (installMatch) {
    return { action: "install", target: installMatch[1].trim() };
  }

  // 卸载 → 高危 uninstall
  const uninstallMatch = message.match(/^(?:卸载|uninstall)\s+(.+)/i);
  if (uninstallMatch) {
    return { action: "uninstall", target: uninstallMatch[1].trim() };
  }

  // 注册表操作 → 高危 registry_write
  if (/注册表|registry/i.test(message)) {
    return { action: "registry_write", target: message };
  }

  // 系统配置 → 高危 system_config
  if (/系统配置|system\s*config/i.test(message)) {
    return { action: "system_config", target: message };
  }

  return null;
}
