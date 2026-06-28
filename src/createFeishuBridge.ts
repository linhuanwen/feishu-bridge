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
            msg_type: "text" | "image" | "interactive";
          };
        }) => Promise<{ data?: { message_id?: string } }>;
        /** 更新应用已发送的消息卡片内容 */
        patch: (req: {
          data: { content: string };
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

  async function sendReply(chatId: string, text: string): Promise<void> {
    await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
  }

  /**
   * 发送图片回复：上传截图到飞书 IM 服务，获取 image_key，
   * 然后通过 image 消息类型发送。
   */
  async function sendImageReply(chatId: string, imagePath: string): Promise<void> {
    const readFile = deps.readImageFile ?? defaultReadImageFile;

    // 读取图片文件
    const imageBase64 = await readFile(imagePath);

    // 上传图片到飞书 IM 服务获取 image_key
    const uploadRes = await client.im.v1.image.create({
      data: {
        image_type: "message",
        image: Buffer.from(imageBase64, "base64"),
      },
    });

    const imageKey = uploadRes.data.image_key;

    // 发送图片消息
    await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ image_key: imageKey }),
        msg_type: "image",
      },
    });
  }

  let stopped = false;

  const messageHandler = deps.onMessage ?? ((data) => handleFeishuMessage(data, { sendReply, now }));

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
            await messageHandler(data, { sendReply, sendImageReply, now, logger: log });
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

    /** 发送飞书交互卡片消息 */
    sendCard: async (chatId: string, cardJson: string): Promise<{ message_id: string }> => {
      try {
        const res = await client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            content: cardJson,
            msg_type: "interactive" as any,
          },
        });
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
      await client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: cardJson },
      });
    },

    /** 发送纯文本消息到指定 chat */
    sendTextMessage: async (chatId: string, text: string): Promise<void> => {
      await client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text }),
          msg_type: "text",
        },
      });
    },
  };

  /** 默认的图片文件读取实现 */
  async function defaultReadImageFile(filePath: string): Promise<string> {
    const { readFile } = await import("fs/promises");
    const buffer = await readFile(filePath);
    return buffer.toString("base64");
  }
}
