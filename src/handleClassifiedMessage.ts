import type { IntentLabel } from "./classifyIntent.js";
import { SWI_PATTERNS, SWI_FORWARD_PATTERNS } from "./classifyIntent.js";
import type { FeishuMessageEvent } from "./types.js";
import type { InquireResult } from "./executeInquire.js";
import type { TaskResult } from "./executeTask.js";
import type { CommandReply } from "./executeSimpleCommand.js";

export type { FeishuMessageEvent };

export type ClassifiedMessageHandlerDeps = {
  /** 发送文本回复。返回 message_id 用于后续撤回/更新。 */
  sendReply: (chatId: string, text: string, replyToMessageId?: string) => Promise<string>;
  sendImageReply?: (chatId: string, imagePath: string) => Promise<void>;
  /** 发送富文本回复（自动 markdown→post 转换）。返回 message_id。 */
  sendPostReply?: (chatId: string, postContent: string, replyToMessageId?: string) => Promise<string>;
  /** 撤回消息（24 小时内有效） */
  deleteMessage?: (messageId: string) => Promise<void>;
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
    const raw = typeof parsed.text === "string" ? parsed.text : "";
    // 去除飞书 @mention（格式：@_user_1 或 <at ...>...</at>）
    return stripAtMentions(raw).trim();
  } catch {
    return "";
  }
}

/** 去除飞书消息中的 @mention 标记 */
function stripAtMentions(text: string): string {
  // 去除 <at user_id="xxx">name</at> 格式
  let cleaned = text.replace(/<at\b[^>]*>.*?<\/at>/gi, "");
  // 去除 @_user_XXX 格式（飞书纯文本 @mention）
  cleaned = cleaned.replace(/@_user_\w+/g, "");
  return cleaned;
}

/** 判断是否为 SWI 工作管家已处理的命令，feishu-bridge 应静默跳过 */
function isSwiHandledCommand(text: string): boolean {
  for (const re of SWI_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

/** 判断是否需要转发到 SWI HTTP API 处理 */
function isSwiForwardCommand(text: string): boolean {
  for (const re of SWI_FORWARD_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

const SWI_API_BASE = "http://127.0.0.1:8080";

/** 转发消息到 SWI HTTP API 处理（如报告生成）。
 * 等待 SWI 同步执行完成，超时 120 秒。 */
async function forwardToSwiApi(
  text: string,
  chatId: string,
  messageId: string,
  log: (msg: string) => void,
): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);
  try {
    const resp = await fetch(`${SWI_API_BASE}/api/agent/table_reporter/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, reply_msg_id: messageId }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await resp.json() as { ok?: boolean; summary?: string; error?: string };
    if (data.ok && data.summary) {
      return data.summary;
    }
    return `⚠️ SWI 服务返回错误: ${data.error ?? "未知错误"}`;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      log("SWI API 调用超时 (120s)");
      return "⚠️ 报告生成超时（超过 120 秒），请稍后重试。";
    }
    log(`SWI API 调用失败: ${err instanceof Error ? err.message : String(err)}`);
    return "⚠️ 报告服务 (SWI) 未运行或不可用。请确认 biaoge 服务已启动。";
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
  const messageId = event.message.message_id; // 用于线程回复
  const text = extractTextContent(event.message.content);

  if (!text) {
    log("收到非文本消息，跳过");
    await deps.sendReply(chatId, "暂不支持该消息类型，请发送文字指令。", messageId);
    return;
  }

  log(`收到用户消息: ${text}`);

  // 需要转发到 SWI HTTP API 的命令（如报告生成）→ 代理调用 SWI
  if (isSwiForwardCommand(text)) {
    log(`SWI 转发命令: ${text}`);
    await deps.sendReply(chatId, "🔄 正在生成报告，请稍候（可能需要 1-2 分钟）…", messageId);
    const swiReply = await forwardToSwiApi(text, chatId, messageId, log);
    await deps.sendReply(chatId, swiReply, messageId);
    return;
  }

  // SWI 工作管家已处理的命令 → 静默跳过，避免与 SWI 服务重复响应
  if (isSwiHandledCommand(text)) {
    log(`SWI 命令，静默跳过: ${text}`);
    return;
  }

  // 白名单校验（所有分类统一检查，避免在三处重复）
  if (!checkWhitelist(event, deps, log)) {
    const senderOpenId = event.sender.sender_id.open_id ?? "unknown";
    await deps.sendReply(
      chatId,
      `⛔ 您没有权限使用此服务。\n\n请将此 open_id 告知管理员以加入白名单：\n\`${senderOpenId}\``,
      messageId,
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
          await deps.sendReply(chatId, result.content, messageId);
        } else if (result.kind === "image") {
          if (deps.sendImageReply) {
            await deps.sendImageReply(chatId, result.filePath);
          } else {
            await deps.sendReply(chatId, "截图功能未配置，请联系管理员。", messageId);
          }
        }
        return;
      }
    }
    // simple 分类无匹配 → 回退到 task（可复用活跃会话 --resume，不会丢失上下文）
    log(`simple 分类无匹配，回退到 task`);
  }

  if (label === "inquire" && deps.executeInquire) {
    log(`inquire 路径：直接查询 Claude Code`);
    await deps.sendReply(chatId, "🔄 正在查询，请稍候……", messageId);
    const inquireResult = await deps.executeInquire(text);
    if (inquireResult.ok) {
      if (deps.sendPostReply) {
        await deps.sendPostReply(chatId, inquireResult.summary, messageId);
      } else {
        await deps.sendReply(chatId, inquireResult.summary, messageId);
      }
    } else {
      await deps.sendReply(chatId, `❌ ${inquireResult.error}`, messageId);
    }
    return;
  }

  if ((label === "task" || label === "simple") && deps.executeTask) {
    log(`task 路径：转发到 Claude Code 会话管理`);
    await deps.sendReply(chatId, "🔄 任务已收到，正在处理中……\n完成后会通知你。", messageId);
    log(`[TaskPipeline] 确认消息已发送，开始执行任务`);
    deps.executeTask(text, chatId)
      .then(async (taskResult) => {
        log(`[TaskPipeline] 任务执行完成: ok=${taskResult.ok}, sessionId=${taskResult.ok ? taskResult.sessionId : "N/A"}`);
        try {
          if (taskResult.ok) {
            log(`[TaskPipeline] 准备发送结果到 ${chatId.slice(0, 12)}..., 摘要长度: ${taskResult.summary.length}`);
            // 优先使用富文本发送
            if (deps.sendPostReply) {
              await deps.sendPostReply(chatId, `✅ 任务完成：\n${taskResult.summary}`, messageId);
            } else {
              await deps.sendReply(chatId, `✅ 任务完成：\n${taskResult.summary}`, messageId);
            }
            log(`[TaskPipeline] 结果发送成功`);
          } else {
            log(`[TaskPipeline] 准备发送错误到 ${chatId.slice(0, 12)}...: ${taskResult.error.slice(0, 100)}`);
            await deps.sendReply(chatId, `❌ ${taskResult.error}`, messageId);
            log(`[TaskPipeline] 错误发送成功`);
          }
        } catch (err) {
          log(`[ERROR] 发送任务结果失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[ERROR] executeTask 异常（未捕获）: ${msg}`);
        deps.sendReply(chatId, `❌ 任务执行异常：${msg}`, messageId).catch(() => {});
      });
    return;
  }

  await deps.sendReply(chatId, `分类为：${label}`, messageId);
}
