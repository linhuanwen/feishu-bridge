import { describe, it, expect, vi } from "vitest";
import { handleFeishuMessage } from "./handleFeishuMessage.js";
import type { FeishuMessageEvent } from "./types.js";

describe("handleFeishuMessage", () => {
  it("收到用户文本消息时，向对应 chat_id 发送连接确认回复", async () => {
    process.env.TZ = "Asia/Shanghai";
    const sendReply = vi.fn().mockResolvedValue(undefined);
    const now = () => new Date("2026-06-15T16:49:41.913+08:00");

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_123",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "你好" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_user" },
      },
    };

    await handleFeishuMessage(event, { sendReply, now });

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      "已连接，当前时间：2026-06-15T16:49:41.913+08:00",
    );
  });

  it("忽略 Bot 自己发送的消息，避免循环回复", async () => {
    const sendReply = vi.fn().mockResolvedValue(undefined);
    const now = () => new Date();

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_bot",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "已连接" }),
      },
      sender: {
        sender_type: "app",
        sender_id: { open_id: "ou_bot" },
      },
    };

    await handleFeishuMessage(event, { sendReply, now });

    expect(sendReply).not.toHaveBeenCalled();
  });
});
