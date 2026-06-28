import type { IntentLabel } from "./classifyIntent.js";
import type { FeishuMessageEvent } from "./types.js";
import type { InquireResult } from "./executeInquire.js";
import type { TaskResult } from "./executeTask.js";
import type { CommandReply } from "./executeSimpleCommand.js";

export type { FeishuMessageEvent };

export type ClassifiedMessageHandlerDeps = {
  sendReply: (chatId: string, text: string) => Promise<void>;
  sendImageReply?: (chatId: string, imagePath: string) => Promise<void>;
  classifyIntent: (message: string) => Promise<IntentLabel>;
  isSenderAllowed?: (openId: string) => boolean;
  executeSimpleCommand?: (message: string) => Promise<CommandReply | null>;
  executeInquire?: (message: string) => Promise<InquireResult>;
  /** task 分类的执行器（Claude Code 会话管理） */
  executeTask?: (message: string, chatId: string) => Promise<TaskResult>;
  logger?: (message: string) => void;
};

function extractTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

/**
 * 白名单校验。如果未配置 isSenderAllowed 则默认放行。
 * 返回 true 表示允许，false 表示拒绝。
 */
function checkWhitelist(
  event: FeishuMessageEvent,
  deps: ClassifiedMessageHandlerDeps,
  log: (msg: string) => void,
): boolean {
  if (!deps.isSenderAllowed) return true;
  const senderOpenId = event.sender.sender_id.open_id;
  if (!senderOpenId || !deps.isSenderAllowed(senderOpenId)) {
    log(`白名单拒绝: ${senderOpenId ?? "unknown"}`);
    return false;
  }
  return true;
}

export async function handleClassifiedMessage(
  event: FeishuMessageEvent,
  deps: ClassifiedMessageHandlerDeps,
): Promise<void> {
  const log = deps.logger ?? (() => {});

  if (event.sender.sender_type === "app") {
    log("忽略 Bot 自身消息");
    return;
  }

  const chatId = event.message.chat_id;
  const text = extractTextContent(event.message.content);

  if (!text) {
    log("收到非文本消息，跳过");
    await deps.sendReply(chatId, "暂不支持该消息类型，请发送文字指令。");
    return;
  }

  log(`收到用户消息: ${text}`);

  // 白名单校验（所有分类统一检查，避免在三处重复）
  if (!checkWhitelist(event, deps, log)) {
    const senderOpenId = event.sender.sender_id.open_id ?? "unknown";
    await deps.sendReply(
      chatId,
      `⛔ 您没有权限使用此服务。\n\n请将此 open_id 告知管理员以加入白名单：\n\`${senderOpenId}\``,
    );
    return;
  }

  const label = await deps.classifyIntent(text);
  log(`分类结果: ${label}`);

  if (label === "simple") {
    if (deps.executeSimpleCommand) {
      const result = await deps.executeSimpleCommand(text);
      if (result !== null) {
        if (result.kind === "text") {
          await deps.sendReply(chatId, result.content);
        } else if (result.kind === "image") {
          if (deps.sendImageReply) {
            await deps.sendImageReply(chatId, result.filePath);
          } else {
            await deps.sendReply(chatId, "截图功能未配置，请联系管理员。");
          }
        }
        return;
      }

      // 无匹配指令
      await deps.sendReply(
        chatId,
        "未知指令。支持的命令：ls <路径>、列出 <路径>、截图、状态、打开 <程序>、关闭 <程序>、运行 <脚本>",
      );
      return;
    }
  }

  if (label === "inquire" && deps.executeInquire) {
    const inquireResult = await deps.executeInquire(text);
    if (inquireResult.ok) {
      await deps.sendReply(chatId, inquireResult.summary);
    } else {
      await deps.sendReply(chatId, `❌ ${inquireResult.error}`);
    }
    return;
  }

  if (label === "task" && deps.executeTask) {
    log(`task 路径：转发到 Claude Code 会话管理`);
    // 先立即回复确认，避免飞书超时重发
    await deps.sendReply(chatId, "🔄 任务已收到，正在处理中……\n完成后会通知你。");
    // 异步执行，完成后主动推送结果
    deps.executeTask(text, chatId)
      .then(async (taskResult) => {
        try {
          if (taskResult.ok) {
            await deps.sendReply(chatId, `✅ 任务完成：\n${taskResult.summary}`);
          } else {
            await deps.sendReply(chatId, `❌ ${taskResult.error}`);
          }
        } catch (err) {
          log(`[ERROR] 发送任务结果失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[ERROR] executeTask 异常（未捕获）: ${msg}`);
        deps.sendReply(chatId, `❌ 任务执行异常：${msg}`).catch(() => {});
      });
    return;
  }

  await deps.sendReply(chatId, `分类为：${label}`);
}
