import { describe, it, expect, vi } from "vitest";
import { handleClassifiedMessage } from "./handleClassifiedMessage.js";
import type { FeishuMessageEvent } from "./types.js";
import type { IntentLabel } from "./classifyIntent.js";

describe("handleClassifiedMessage", () => {
  it("对用户消息调用分类器并发送分类结果", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("simple" as IntentLabel);

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_123",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "看看 D 盘" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_user" },
      },
    };

    await handleClassifiedMessage(event, { sendReply, classifyIntent });

    expect(classifyIntent).toHaveBeenCalledWith("看看 D 盘");
    expect(sendReply).toHaveBeenCalledWith("oc_456", "分类为：simple", expect.any(String));
  });

  it("非文本消息（空内容）不调用分类器，直接提示用户", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("simple" as IntentLabel);

    // 图片、文件、表情等消息没有 text 字段
    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_img",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "image",
        content: JSON.stringify({ image_key: "img_xxx" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_user" },
      },
    };

    await handleClassifiedMessage(event, { sendReply, classifyIntent });

    expect(classifyIntent).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith("oc_456", "暂不支持该消息类型，请发送文字指令。", expect.any(String));
  });

  it("忽略 Bot 自身消息", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("simple" as IntentLabel);

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_bot",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "分类为：simple" }),
      },
      sender: {
        sender_type: "app",
        sender_id: { open_id: "ou_bot" },
      },
    };

    await handleClassifiedMessage(event, { sendReply, classifyIntent });

    expect(classifyIntent).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it("分类为 simple 但用户不在白名单时，回复 open_id 并拒绝", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("simple" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(false);

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_eve",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "ls D:\\" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_eve" },
      },
    };

    await handleClassifiedMessage(event, { sendReply, classifyIntent, isSenderAllowed });

    expect(isSenderAllowed).toHaveBeenCalledWith("ou_eve");
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("ou_eve"),
  expect.any(String),
    );
  });

  it("分类为 simple + 白名单通过 + 指令匹配时，执行并返回结果", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("simple" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(true);
    const executeSimpleCommand = vi.fn().mockResolvedValue({
      kind: "text",
      content: "📂 D:\\（2 项）\na.txt  100 B  2026-01-01",
    });

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_ls",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "ls D:\\" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      classifyIntent,
      isSenderAllowed,
      executeSimpleCommand,
    });

    expect(isSenderAllowed).toHaveBeenCalledWith("ou_alice");
    expect(executeSimpleCommand).toHaveBeenCalledWith("ls D:\\");
    expect(sendReply).toHaveBeenCalledWith("oc_456", "📂 D:\\（2 项）\na.txt  100 B  2026-01-01", expect.any(String));
  });

  // ---- inquire 路由测试 ----

  it("分类为 inquire → 调用 executeInquire 并返回文件摘要", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("inquire" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(true);
    const executeInquire = vi.fn().mockResolvedValue({
      ok: true,
      summary: "文件 d:\\notes\\todo.md 的内容：\n- 买牛奶\n- 写报告",
    });

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_inq",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "读一下 d:\\notes\\todo.md" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      classifyIntent,
      isSenderAllowed,
      executeInquire,
    });

    expect(executeInquire).toHaveBeenCalledWith("读一下 d:\\notes\\todo.md");
    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("买牛奶"),
  expect.any(String),
    );
  });

  it("分类为 inquire + 白名单拒绝 → 回复 open_id 并拒绝", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("inquire" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(false);
    const executeInquire = vi.fn();

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_eve",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "读一下 secret.txt" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_eve" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      classifyIntent,
      isSenderAllowed,
      executeInquire,
    });

    expect(isSenderAllowed).toHaveBeenCalledWith("ou_eve");
    expect(executeInquire).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("ou_eve"),
  expect.any(String),
    );
  });

  it("分类为 inquire + executeInquire 返回错误 → 向用户发送错误信息", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("inquire" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(true);
    const executeInquire = vi.fn().mockResolvedValue({
      ok: false,
      error: "查询超时（60 秒），请简化请求或检查文件大小。",
    });

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_timeout",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "读一下 huge.pdf" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      classifyIntent,
      isSenderAllowed,
      executeInquire,
    });

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("超时"),
  expect.any(String),
    );
  });

  it("分类为 simple + 白名单通过 + 无匹配指令时，返回提示", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("simple" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(true);
    const executeSimpleCommand = vi.fn().mockResolvedValue(null);

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_unknown",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "今天天气如何" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      classifyIntent,
      isSenderAllowed,
      executeSimpleCommand,
    });

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("分类为"),
      expect.any(String),
    );
  });

  // ---- image 回复路径 ----

  it("指令返回 image 类型 → 调用 sendImageReply 发送图片", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const sendImageReply = vi.fn().mockResolvedValue(undefined);
    const classifyIntent = vi.fn().mockResolvedValue("simple" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(true);
    const executeSimpleCommand = vi.fn().mockResolvedValue({
      kind: "image",
      filePath: "C:\\temp\\screenshot-test.png",
    });

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_ss",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "截图" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      sendImageReply,
      classifyIntent,
      isSenderAllowed,
      executeSimpleCommand,
    });

    expect(sendImageReply).toHaveBeenCalledWith(
      "oc_456",
      "C:\\temp\\screenshot-test.png",
    );
    expect(sendReply).not.toHaveBeenCalled();
  });

  // ---- task 路由测试 ----

  it("分类为 task → 调用 executeTask 并返回结果", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("task" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(true);
    const executeTask = vi.fn().mockResolvedValue({
      ok: true,
      summary: "代码审查完成：发现 3 个潜在问题...",
      sessionId: "sess-abc",
    });

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_task",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "审查 d:\\tool\\yuancheng 的代码" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      classifyIntent,
      isSenderAllowed,
      executeTask,
    });

    expect(executeTask).toHaveBeenCalledWith(
      "审查 d:\\tool\\yuancheng 的代码",
      "oc_456",
    );
    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("代码审查完成"),
  expect.any(String),
    );
  });

  it("分类为 task + 白名单拒绝 → 回复 open_id 并拒绝", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("task" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(false);
    const executeTask = vi.fn();

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_eve",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "审查代码" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_eve" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      classifyIntent,
      isSenderAllowed,
      executeTask,
    });

    expect(isSenderAllowed).toHaveBeenCalledWith("ou_eve");
    expect(executeTask).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("ou_eve"),
  expect.any(String),
    );
  });

  it("分类为 task + executeTask 返回错误 → 向用户发送错误信息", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("task" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(true);
    const executeTask = vi.fn().mockResolvedValue({
      ok: false,
      error: "无法确定项目目录。请在消息中指定目录路径。",
    });

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_no_dir",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "审查代码" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      classifyIntent,
      isSenderAllowed,
      executeTask,
    });

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("无法确定项目目录"),
  expect.any(String),
    );
  });

  it("未配置 executeTask 时 task 分类向后兼容（回复分类标签）", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("task" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(true);

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_task",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "审查代码" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      classifyIntent,
      isSenderAllowed,
      // 不传 executeTask
    });

    expect(sendReply).toHaveBeenCalledWith("oc_456", "分类为：task", expect.any(String));
  });

  it("指令返回 image 但没有 sendImageReply → 回退为文字提示", async () => {
    const sendReply = vi.fn().mockResolvedValue("msg_001");
    const classifyIntent = vi.fn().mockResolvedValue("simple" as IntentLabel);
    const isSenderAllowed = vi.fn().mockReturnValue(true);
    const executeSimpleCommand = vi.fn().mockResolvedValue({
      kind: "image",
      filePath: "C:\\temp\\screenshot-test.png",
    });

    const event: FeishuMessageEvent = {
      message: {
        message_id: "om_ss2",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: "截图" }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };

    await handleClassifiedMessage(event, {
      sendReply,
      // 不传 sendImageReply
      classifyIntent,
      isSenderAllowed,
      executeSimpleCommand,
    });

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("截图功能未配置"),
  expect.any(String),
    );
  });
});
