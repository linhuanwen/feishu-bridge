import { createReadStream } from "fs";
import { handleFeishuMessage } from "./handleFeishuMessage.js";
import type { FeishuMessageEvent, MessageHandlerContext } from "./types.js";

export type { MessageHandlerContext };

export type FeishuClient = {
  im: {
    v1: {
      message: {
        create: (req: {
          params: { receive_id_type: "chat_id" };
          data: {
            receive_id: string;
            content: string;
            msg_type: "text" | "image" | "interactive" | "post";
          };
        }) => Promise<{ data?: { message_id?: string }; code?: number; msg?: string }>;
        /** 更新应用已发送的消息卡片内容 */
        patch: (req: {
          data: { content: string };
          path: { message_id: string };
        }) => Promise<{ code?: number; msg?: string; data?: {} }>;
        /** 回复指定消息（线程回复） */
        reply: (req: {
          path: { message_id: string };
          data: {
            receive_id: string;
            content: string;
            msg_type: "text" | "image" | "interactive" | "post";
          };
        }) => Promise<{ data?: { message_id?: string }; code?: number; msg?: string }>;
        /** 撤回机器人自己发送的消息（24 小时内有效） */
        delete: (req: {
          path: { message_id: string };
        }) => Promise<{ code?: number; msg?: string; data?: {} }>;
      };
      image: {
        create: (req: {
          data: {
            image_type: "message";
            image: ReturnType<typeof createReadStream> | Buffer;
          };
        }) => Promise<{ data: { image_key: string } }>;
      };
    };
  };
};

export type FeishuEventDispatcher = {
  register: (handlers: Record<string, (data: FeishuMessageEvent) => Promise<void>>) => FeishuEventDispatcher;
};

export type FeishuWSClient = {
  start: (opts: { eventDispatcher: FeishuEventDispatcher }) => void;
};

/** 卡片按钮点击事件（card.action.trigger） */
export type CardActionEvent = {
  action: {
    value: unknown;
    tag: string;
  };
  open_id: string;
  operator: { open_id: string };
  context: { open_message_id: string };
};

export type FeishuBridgeDeps = {
  appId: string;
  appSecret: string;
  createClient: (cfg: { appId: string; appSecret: string }) => FeishuClient;
  createWSClient: (cfg: { appId: string; appSecret: string }) => FeishuWSClient;
  createEventDispatcher: () => FeishuEventDispatcher;
  now?: () => Date;
  logger?: (message: string) => void;
  onMessage?: (event: FeishuMessageEvent, ctx: MessageHandlerContext) => Promise<void>;
  /** 卡片按钮点击回调 */
  onCardAction?: (event: CardActionEvent) => Promise<void>;
  /** 读取图片文件为 Base64 字符串 */
  readImageFile?: (filePath: string) => Promise<string>;
};

export function createFeishuBridge(deps: FeishuBridgeDeps) {
  const log = deps.logger ?? ((msg: string) => console.log(msg));
  const now = deps.now ?? (() => new Date());

  const client = deps.createClient({
    appId: deps.appId,
    appSecret: deps.appSecret,
  });

  const wsClient = deps.createWSClient({
    appId: deps.appId,
    appSecret: deps.appSecret,
  });

  /** 给 Promise 加超时，超时后抛出错误 */
  function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[Timeout] ${label} 超时 (${ms}ms)`));
      }, ms);
      promise
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });
  }

  const API_TIMEOUT_MS = 30_000; // 飞书 API 调用超时：30 秒

  /**
   * 发送文本回复。
   * - 传入 replyToMessageId 时：使用线程回复（reply API），消息挂在原消息下方
   * - 不传 replyToMessageId 时：使用普通发送（create API），向后兼容
   * 返回发送成功的 message_id，可用于后续撤回/更新。
   */
  async function sendReply(chatId: string, text: string, replyToMessageId?: string): Promise<string> {
    log(`[sendReply] ${replyToMessageId ? "线程回复" : "发送消息"} 到 ${chatId.slice(0, 12)}...: ${text.slice(0, 80)}`);
    try {
      const data = {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: "text" as const,
      };

      let res: { data?: { message_id?: string }; code?: number; msg?: string };
      if (replyToMessageId) {
        res = await withTimeout(
          client.im.v1.message.reply({
            path: { message_id: replyToMessageId },
            data,
          }),
          API_TIMEOUT_MS,
          "sendReply.reply",
        );
      } else {
        res = await withTimeout(
          client.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data,
          }),
          API_TIMEOUT_MS,
          "sendReply.create",
        );
      }

      const code = res?.code;
      if (code !== undefined && code !== 0) {
        log(`[sendReply] 飞书 API 返回错误: code=${code}, msg=${res?.msg ?? ""}`);
        return "";
      }
      const messageId = res?.data?.message_id ?? "";
      log(`[sendReply] 发送成功: message_id=${messageId || "?"}, chatId=${chatId.slice(0, 12)}...`);
      return messageId;
    } catch (err) {
      log(`[sendReply] 发送失败: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * 发送图片回复：上传截图到飞书 IM 服务，获取 image_key，
   * 然后通过 image 消息类型发送。
   */
  async function sendImageReply(chatId: string, imagePath: string): Promise<void> {
    const readFile = deps.readImageFile ?? defaultReadImageFile;
    log(`[sendImageReply] 发送图片到 ${chatId.slice(0, 12)}...: ${imagePath}`);

    try {
      // 读取图片文件
      const imageBase64 = await readFile(imagePath);

      // 上传图片到飞书 IM 服务获取 image_key
      const uploadRes = await withTimeout(
        client.im.v1.image.create({
          data: {
            image_type: "message",
            image: Buffer.from(imageBase64, "base64"),
          },
        }),
        API_TIMEOUT_MS,
        "sendImageReply.upload",
      );

      const imageKey = uploadRes.data.image_key;

      // 发送图片消息
      await withTimeout(
        client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ image_key: imageKey }),
            msg_type: "image",
          },
        }),
        API_TIMEOUT_MS,
        "sendImageReply.send",
      );
      log(`[sendImageReply] 发送成功: ${chatId.slice(0, 12)}...`);
    } catch (err) {
      log(`[sendImageReply] 发送失败: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  /**
   * 撤回机器人自己发送的消息（24 小时内有效）。
   * 适用于清理临时状态消息（如 "正在处理中…" 提示）。
   */
  async function deleteMessage(messageId: string): Promise<void> {
    if (!messageId) return;
    log(`[deleteMessage] 撤回消息: message_id=${messageId}`);
    try {
      const res = await withTimeout(
        client.im.v1.message.delete({
          path: { message_id: messageId },
        }),
        API_TIMEOUT_MS,
        "deleteMessage",
      );
      const code = (res as any)?.code;
      if (code !== undefined && code !== 0) {
        log(`[deleteMessage] 撤回失败: code=${code}, msg=${(res as any)?.msg ?? ""}`);
      } else {
        log(`[deleteMessage] 撤回成功: message_id=${messageId}`);
      }
    } catch (err) {
      log(`[deleteMessage] 撤回异常: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * 发送富文本（post）消息。
   * 自动检测：如果 content 是 JSON 格式的飞书 post 结构则直接使用，
   * 否则当作 markdown 文本自动转换为 post 格式。
   * 返回发送成功的 message_id。
   */
  async function sendPostReply(chatId: string, postContent: string, replyToMessageId?: string): Promise<string> {
    log(`[sendPostReply] ${replyToMessageId ? "线程回复" : "发送富文本"} 到 ${chatId.slice(0, 12)}...: ${postContent.slice(0, 80)}`);
    try {
      // 自动检测：如果是 JSON 开头则直接当作 post 格式，否则 markdown 转换
      let content: string;
      const trimmed = postContent.trimStart();
      if (trimmed.startsWith("{")) {
        // 已经是飞书 post JSON
        content = postContent;
      } else {
        // Markdown → post
        content = markdownToPostContent(postContent);
      }

      const data = {
        receive_id: chatId,
        content,
        msg_type: "post" as const,
      };

      let res: { data?: { message_id?: string }; code?: number; msg?: string };
      if (replyToMessageId) {
        res = await withTimeout(
          client.im.v1.message.reply({
            path: { message_id: replyToMessageId },
            data,
          }),
          API_TIMEOUT_MS,
          "sendPostReply.reply",
        );
      } else {
        res = await withTimeout(
          client.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data,
          }),
          API_TIMEOUT_MS,
          "sendPostReply.create",
        );
      }

      const code = res?.code;
      if (code !== undefined && code !== 0) {
        log(`[sendPostReply] 飞书 API 返回错误: code=${code}, msg=${res?.msg ?? ""}`);
        // 回退：用纯文本重发
        log(`[sendPostReply] 回退到纯文本发送`);
        return sendReply(chatId, postContent, replyToMessageId);
      }
      const messageId = res?.data?.message_id ?? "";
      log(`[sendPostReply] 发送成功: message_id=${messageId || "?"}`);
      return messageId;
    } catch (err) {
      log(`[sendPostReply] 发送失败: ${err instanceof Error ? err.message : String(err)}`);
      // 回退：用纯文本重发
      try {
        log(`[sendPostReply] 异常回退到纯文本发送`);
        return await sendReply(chatId, postContent, replyToMessageId);
      } catch { /* 放弃 */ }
      throw err;
    }
  }

  let stopped = false;

  const messageHandler = deps.onMessage ?? ((data) => handleFeishuMessage(data, { sendReply, sendImageReply, sendPostReply, deleteMessage, now, logger: log }));

  return {
    start: async (): Promise<void> => {
      log(`Feishu Bridge 启动中，appId: ${deps.appId}`);

      // ── message_id 去重：飞书 WebSocket 可能重复推送同一消息 ──
      // 用 Map 记录最近处理过的 message_id，TTL 5 分钟后自动清除
      const DEDUP_TTL_MS = 5 * 60 * 1000;
      const processedMessages = new Map<string, number>(); // message_id → timestamp

      function isDuplicate(messageId: string): boolean {
        const seenAt = processedMessages.get(messageId);
        if (seenAt !== undefined && now().getTime() - seenAt < DEDUP_TTL_MS) {
          return true;
        }
        processedMessages.set(messageId, now().getTime());
        // 惰性清理过期条目（Map 超过 1000 条时触发）
        if (processedMessages.size > 1000) {
          const cutoff = now().getTime() - DEDUP_TTL_MS;
          for (const [id, ts] of processedMessages) {
            if (ts < cutoff) processedMessages.delete(id);
          }
        }
        return false;
      }

      const handlers: Record<string, (data: any) => Promise<void>> = {
        "im.message.receive_v1": async (data: FeishuMessageEvent) => {
          if (stopped) return;
          const msgId = data.message?.message_id;
          if (msgId && isDuplicate(msgId)) {
            log(`[去重] 跳过重复消息: message_id=${msgId}`);
            return;
          }
          log(`收到消息: chat_id=${data.message.chat_id} message_id=${data.message.message_id}`);
          try {
            await messageHandler(data, { sendReply, sendImageReply, sendPostReply, deleteMessage, now, logger: log });
          } catch (err) {
            log(`[ERROR] 消息处理异常: ${err instanceof Error ? err.message : String(err)}`);
          }
        },
      };

      // 注册卡片按钮点击回调
      if (deps.onCardAction) {
        handlers["card.action.trigger"] = async (data: CardActionEvent) => {
          if (stopped) return;
          log(`收到卡片动作: message_id=${data.context?.open_message_id}`);
          await deps.onCardAction!(data);
        };
      }

      const eventDispatcher = deps.createEventDispatcher().register(handlers);

      wsClient.start({ eventDispatcher });
      log("Feishu Bridge 已启动，等待消息");
    },

    /** 停止 Bridge（阻止新消息处理） */
    stop: (): void => {
      stopped = true;
      log("Feishu Bridge 已停止");
    },

    /** 发送飞书交互卡片消息。
     *  传入 openId 时使用 receive_id_type="open_id"（p2p 私聊推送必须用 open_id），
     *  否则回退到 chat_id。 */
    sendCard: async (chatId: string, cardJson: string, openId?: string): Promise<{ message_id: string }> => {
      // p2p 私聊：用 open_id 作为接收方才能触发手机推送
      const useOpenId = Boolean(openId);
      const receiveIdType = useOpenId ? "open_id" : "chat_id";
      const receiveId = useOpenId ? openId! : chatId;
      try {
        log(`[sendCard] receive_id_type=${receiveIdType} receive_id=${receiveId.slice(0, 12)}...`);
        const res = await withTimeout(
          client.im.v1.message.create({
            params: { receive_id_type: receiveIdType as "chat_id" },
            data: {
              receive_id: receiveId,
              content: cardJson,
              msg_type: "interactive" as any,
            },
          }),
          API_TIMEOUT_MS,
          "sendCard",
        );
        // 检查飞书 API 错误码（code 不为 0 表示失败）
        const code = (res as any)?.code;
        if (code !== undefined && code !== 0) {
          const msg = (res as any)?.msg ?? "未知错误";
          log(`[sendCard] 飞书 API 返回错误: code=${code}, msg=${msg}, card=${cardJson.slice(0, 200)}`);
          return { message_id: "" };
        }
        const messageId = res.data?.message_id ?? "";
        if (!messageId) {
          log(`[sendCard] 未获取到 message_id, 完整响应: ${JSON.stringify(res).slice(0, 300)}`);
        }
        return { message_id: messageId };
      } catch (err) {
        log(`[sendCard] 发送异常: ${err instanceof Error ? err.message : String(err)}`);
        return { message_id: "" };
      }
    },

    /** 更新已发送的卡片消息内容（用户点击按钮后将卡片替换为确认结果） */
    patchCard: async (messageId: string, cardJson: string): Promise<void> => {
      try {
        await withTimeout(
          client.im.v1.message.patch({
            path: { message_id: messageId },
            data: { content: cardJson },
          }),
          API_TIMEOUT_MS,
          "patchCard",
        );
      } catch (err) {
        log(`[patchCard] 更新失败: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },

    /** 发送纯文本消息到指定 chat */
    sendTextMessage: async (chatId: string, text: string): Promise<void> => {
      log(`[sendTextMessage] 发送消息到 ${chatId.slice(0, 12)}...: ${text.slice(0, 80)}`);
      try {
        await withTimeout(
          client.im.v1.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: chatId,
              content: JSON.stringify({ text }),
              msg_type: "text",
            },
          }),
          API_TIMEOUT_MS,
          "sendTextMessage",
        );
        log(`[sendTextMessage] 发送成功: ${chatId.slice(0, 12)}...`);
      } catch (err) {
        log(`[sendTextMessage] 发送失败: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },

    /** 撤回消息（24 小时内有效） */
    deleteMessage,

    /** 发送富文本（post）消息，自动 markdown→post 转换 */
    sendPostReply,
  };

  /** 默认的图片文件读取实现 */
  async function defaultReadImageFile(filePath: string): Promise<string> {
    const { readFile } = await import("fs/promises");
    const buffer = await readFile(filePath);
    return buffer.toString("base64");
  }

  /**
   * 将 Markdown 文本转换为飞书 post 消息 content JSON。
   * 支持：标题、段落、行内代码、加粗、链接。
   */
  function markdownToPostContent(md: string): string {
    const lines = md.split("\n");
    const paragraphs: any[][] = [];
    let title = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 跳过空行
      if (line.trim() === "") {
        continue;
      }

      // 标题（## / ### 开头）→ 作为 post 段落标题
      if (/^#{1,3}\s/.test(line)) {
        const headingText = line.replace(/^#{1,3}\s+/, "");
        if (!title) {
          title = headingText.slice(0, 100);
        }
        paragraphs.push([{ tag: "text", text: headingText + "\n" }]);
        continue;
      }

      // 分割线
      if (/^[-*_]{3,}\s*$/.test(line)) {
        paragraphs.push([{ tag: "text", text: "──────────\n" }]);
        continue;
      }

      // 列表项
      if (/^[\s]*[-*+]\s/.test(line)) {
        const itemText = line.replace(/^[\s]*[-*+]\s+/, "• ");
        paragraphs.push(parseInlineMarkdown(itemText));
        continue;
      }

      // 编号列表
      if (/^[\s]*\d+[.)]\s/.test(line)) {
        paragraphs.push(parseInlineMarkdown(line));
        continue;
      }

      // 代码块（```...```）
      if (line.startsWith("```")) {
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) {
          codeLines.push(lines[i]);
          i++;
        }
        if (codeLines.length > 0) {
          paragraphs.push([{ tag: "text", text: codeLines.join("\n") + "\n" }]);
        }
        continue;
      }

      // 行内代码：`...` → 保留反引号标记
      // 普通段落
      paragraphs.push(parseInlineMarkdown(line));
    }

    // 如果没有提取到标题，从第一段截取
    if (!title && paragraphs.length > 0) {
      const firstText = paragraphs[0]?.find((e: any) => e.tag === "text")?.text ?? "";
      title = firstText.slice(0, 100).replace(/\n/g, " ");
    }
    if (!title) title = "消息";

    return JSON.stringify({
      zh_cn: {
        title,
        content: paragraphs,
      },
    });
  }

  /**
   * 解析行内 Markdown：**加粗**、`行内代码`、[链接](url)、纯文本。
   * 返回飞书 post 段落数组。
   */
  function parseInlineMarkdown(text: string): any[] {
    const elements: any[] = [];
    // 匹配：**bold** | `code` | [text](url)
    const re = /(\*\*(.+?)\*\*)|(`(.+?)`)|(\[(.+?)\]\((.+?)\))/g;
    let last = 0;

    for (const m of text.matchAll(re)) {
      // 前面的纯文本
      if (m.index! > last) {
        const plain = text.slice(last, m.index!);
        elements.push({ tag: "text", text: plain });
      }

      if (m[1]) {
        // **加粗** — 飞书 post 没有原生加粗，用空格包裹强调
        elements.push({ tag: "text", text: `【${m[2]}】` });
      } else if (m[3]) {
        // `代码`
        elements.push({ tag: "text", text: m[4] });
      } else if (m[5]) {
        // [链接](url)
        elements.push({ tag: "a", text: m[6], href: m[7] });
      }

      last = m.index! + m[0].length;
    }

    // 剩余纯文本
    if (last < text.length) {
      elements.push({ tag: "text", text: text.slice(last) });
    }

    // 如果没有任何匹配，返回纯文本
    if (elements.length === 0) {
      elements.push({ tag: "text", text });
    }

    return elements;
  }
}
