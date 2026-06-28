import { describe, it, expect, vi } from "vitest";
import { createMessagePipeline } from "./createMessagePipeline.js";
import type { FeishuMessageEvent, Operation, GuardResult } from "./types.js";

describe("createMessagePipeline", () => {
  it("白名单用户发 'ls D:\\' → 调用 listDirectory 并返回格式化结果", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("simple"),
      isSenderAllowed: (id: string) => id === "ou_alice",
      listDirectory: vi.fn().mockResolvedValue({
        ok: true,
        entries: [
          { name: "projects", size: "0 B", modifiedAt: "2026-06-01T00:00:00.000Z" },
          { name: "readme.txt", size: "1.2 KB", modifiedAt: "2026-05-15T00:00:00.000Z" },
        ],
      }),
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
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

    await pipeline.onMessage(event, {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(sendReply).toHaveBeenCalledTimes(1);
    const reply = sendReply.mock.calls[0][1] as string;
    expect(reply).toContain("D:\\");
    expect(reply).toContain("projects");
    expect(reply).toContain("readme.txt");
  });

  it("非白名单用户被回复 open_id 并拒绝", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("simple"),
      isSenderAllowed: (id: string) => id === "ou_alice",
      listDirectory: vi.fn(),
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
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

    await pipeline.onMessage(event, {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("ou_eve"),
    );
  });

  it("非 simple 分类不触发白名单和指令执行，回复分类结果", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("task"),
      isSenderAllowed: () => true,
      listDirectory: vi.fn(),
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
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

    await pipeline.onMessage(event, {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(sendReply).toHaveBeenCalledWith("oc_456", "分类为：task");
  });
});

describe("createMessagePipeline — inquire 文件查询", () => {
  function makeInquireEvent(text: string): FeishuMessageEvent {
    return {
      message: {
        message_id: "om_inq",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };
  }

  it("inquire 分类 → 调用 executeInquire 并返回文件摘要", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("inquire"),
      isSenderAllowed: () => true,
      listDirectory: vi.fn(),
      executeInquire: vi.fn().mockResolvedValue({
        ok: true,
        summary: "文件 report.xlsx 包含以下工作表：\n- Sheet1: 销售数据 (100行)\n- Sheet2: 汇总",
      }),
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(makeInquireEvent("看看 d:\\data\\report.xlsx"), {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("Sheet1"),
    );
  });

  it("inquire + 白名单拒绝 → 回复 open_id 并拒绝", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("inquire"),
      isSenderAllowed: () => false,
      listDirectory: vi.fn(),
      executeInquire: vi.fn(),
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(
      makeInquireEvent("读一下 secret.txt"),
      { sendReply, now: () => new Date(), logger: () => {} },
    );

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("ou_alice"),
    );
  });

  it("inquire 调用出错 → 返回错误提示", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("inquire"),
      isSenderAllowed: () => true,
      listDirectory: vi.fn(),
      executeInquire: vi.fn().mockResolvedValue({
        ok: false,
        error: "查询超时（60 秒），请简化请求或检查文件大小。",
      }),
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(
      makeInquireEvent("读一下 huge.pdf"),
      { sendReply, now: () => new Date(), logger: () => {} },
    );

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("超时"),
    );
  });

  it("未配置 executeInquire 时向后兼容（回复分类标签）", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("inquire"),
      isSenderAllowed: () => true,
      listDirectory: vi.fn(),
      // 不传 executeInquire
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(
      makeInquireEvent("读一下 test.md"),
      { sendReply, now: () => new Date(), logger: () => {} },
    );

    expect(sendReply).toHaveBeenCalledWith("oc_456", "分类为：inquire");
  });
});

describe("createMessagePipeline — 集成 PermissionGate", () => {
  function makeBaseDeps() {
    return {
      classifyIntent: vi.fn().mockResolvedValue("simple"),
      isSenderAllowed: () => true,
      listDirectory: vi.fn().mockResolvedValue({
        ok: true,
        entries: [
          { name: "test.txt", size: "1 KB", modifiedAt: "2026-01-01T00:00:00.000Z" },
        ],
      }),
    };
  }

  function makeEvent(text: string): FeishuMessageEvent {
    return {
      message: {
        message_id: "om_test",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };
  }

  function createGate(behavior: "allowed" | "denied" | "timeout") {
    return {
      isHighRisk: vi.fn().mockReturnValue(true),
      guard: vi.fn().mockImplementation(
        async (
          _chatId: string,
          _operation: Operation,
          execute: () => Promise<string>,
        ): Promise<GuardResult> => {
          if (behavior === "allowed") {
            const result = await execute();
            return { status: "allowed", result };
          }
          return { status: behavior };
        },
      ),
    };
  }

  it("高危指令通过确认门 → 用户允许 → 执行并返回结果", async () => {
    const gate = createGate("allowed");
    const pipeline = createMessagePipeline({
      ...makeBaseDeps(),
      permissionGate: gate,
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(makeEvent("ls D:\\"), {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(gate.guard).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalled();
    const reply = sendReply.mock.calls[0][1] as string;
    expect(reply).not.toContain("已取消");
  });

  it("高危指令通过确认门 → 用户拒绝 → 不执行，回复「已取消」", async () => {
    const gate = createGate("denied");
    const pipeline = createMessagePipeline({
      ...makeBaseDeps(),
      permissionGate: gate,
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(makeEvent("ls D:\\"), {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(gate.guard).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith("oc_456", expect.stringContaining("已取消"));
  });

  it("高危指令通过确认门 → 超时 → 不执行，回复「已取消」", async () => {
    const gate = createGate("timeout");
    const pipeline = createMessagePipeline({
      ...makeBaseDeps(),
      permissionGate: gate,
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(makeEvent("ls D:\\"), {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(gate.guard).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith("oc_456", expect.stringContaining("已取消"));
  });

  it("未配置 permissionGate 时原有行为不变（向后兼容）", async () => {
    const deps = makeBaseDeps();
    const pipeline = createMessagePipeline(deps);

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(makeEvent("ls D:\\"), {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply.mock.calls[0][1]).toContain("D:\\");
  });
});

describe("createMessagePipeline — task 会话管理", () => {
  function makeTaskEvent(text: string): FeishuMessageEvent {
    return {
      message: {
        message_id: "om_task",
        chat_id: "oc_456",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text }),
      },
      sender: {
        sender_type: "user",
        sender_id: { open_id: "ou_alice" },
      },
    };
  }

  it("task 分类 → 调用 executeTask 并返回会话结果", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("task"),
      isSenderAllowed: () => true,
      listDirectory: vi.fn(),
      executeTask: vi.fn().mockResolvedValue({
        ok: true,
        summary: "代码审查结果：无重大问题。",
        sessionId: "sess-001",
      }),
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(makeTaskEvent("审查 d:\\tool\\yuancheng 的代码"), {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("代码审查结果"),
    );
  });

  it("task + 白名单拒绝 → 回复 open_id 并拒绝", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("task"),
      isSenderAllowed: () => false,
      listDirectory: vi.fn(),
      executeTask: vi.fn(),
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(makeTaskEvent("审查代码"), {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("ou_alice"),
    );
  });

  it("task 执行出错 → 返回错误信息", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("task"),
      isSenderAllowed: () => true,
      listDirectory: vi.fn(),
      executeTask: vi.fn().mockResolvedValue({
        ok: false,
        error: "任务执行失败：CLI 进程崩溃",
      }),
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(makeTaskEvent("审查 d:\\tool 代码"), {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(sendReply).toHaveBeenCalledWith(
      "oc_456",
      expect.stringContaining("任务执行失败"),
    );
  });

  it("未配置 executeTask 时向后兼容（回复分类标签）", async () => {
    const pipeline = createMessagePipeline({
      classifyIntent: vi.fn().mockResolvedValue("task"),
      isSenderAllowed: () => true,
      listDirectory: vi.fn(),
      // 不传 executeTask
    });

    const sendReply = vi.fn().mockResolvedValue(undefined);
    await pipeline.onMessage(makeTaskEvent("审查代码"), {
      sendReply,
      now: () => new Date(),
      logger: () => {},
    });

    expect(sendReply).toHaveBeenCalledWith("oc_456", "分类为：task");
  });
});
