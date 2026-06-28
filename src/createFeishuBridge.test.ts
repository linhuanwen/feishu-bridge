import { describe, it, expect, vi } from "vitest";
import {
  createFeishuBridge,
  type FeishuClient,
  type FeishuEventDispatcher,
  type FeishuWSClient,
} from "./createFeishuBridge.js";
import { type FeishuMessageEvent } from "./types.js";

describe("createFeishuBridge", () => {
  it("启动后注册 im.message.receive_v1 处理器，收到用户消息时发送连接确认回复", async () => {
    process.env.TZ = "Asia/Shanghai";
    const createCapture = vi.fn();
    const registeredHandlers: Record<string, (data: FeishuMessageEvent) => Promise<void>> = {};

    const mockEventDispatcher: FeishuEventDispatcher = {
      register: vi.fn((handlers) => {
        Object.assign(registeredHandlers, handlers);
        return mockEventDispatcher;
      }),
    };

    const mockCreate = vi.fn().mockResolvedValue({ data: { message_id: "om_reply" } });
    const mockClient: FeishuClient = {
      im: {
        v1: {
          message: {
            create: mockCreate,
          },
          image: {
            create: vi.fn().mockResolvedValue({ data: { image_key: "img_test_key" } }),
          },
        },
      },
    };

    const mockStart = vi.fn();

    const mockWSClient: FeishuWSClient = {
      start: mockStart,
    };

    const bridge = createFeishuBridge({
      appId: "cli_test",
      appSecret: "secret_test",
      createClient: () => mockClient,
      createWSClient: () => mockWSClient,
      createEventDispatcher: () => mockEventDispatcher,
      now: () => new Date("2026-06-15T16:49:41.913+08:00"),
      logger: () => {},
    });

    await bridge.start();

    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockEventDispatcher.register).toHaveBeenCalledWith(
      expect.objectContaining({
        "im.message.receive_v1": expect.any(Function),
      }),
    );

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

    const handler = registeredHandlers["im.message.receive_v1"];
    await handler(event);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_456",
        content: JSON.stringify({ text: "已连接，当前时间：2026-06-15T16:49:41.913+08:00" }),
        msg_type: "text",
      },
    });
  });
});
