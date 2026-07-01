import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeTask, type ExecuteTaskDeps } from "./executeTask.js";
import { createSessionRegistry, type SessionRegistry } from "./sessionRegistry.js";

function makeDeps(overrides?: Partial<ExecuteTaskDeps>): ExecuteTaskDeps {
  return {
    callClaude: vi.fn().mockResolvedValue("任务执行完成"),
    generateSessionId: vi
      .fn()
      .mockReturnValueOnce("sess-001")
      .mockReturnValueOnce("sess-002")
      .mockReturnValueOnce("sess-003"),
    now: () => new Date("2026-06-27T10:00:00.000Z"),
    ...overrides,
  };
}

describe("executeTask", () => {
  let registry: SessionRegistry;
  let deps: ExecuteTaskDeps;

  beforeEach(() => {
    registry = createSessionRegistry({
      now: () => new Date("2026-06-27T10:00:00.000Z"),
    });
    deps = makeDeps();
  });

  describe("首次任务消息 — 创建会话", () => {
    it("首次在目录执行任务时创建新 session 并调用 Claude Code", async () => {
      const result = await executeTask(
        "审查 d:\\tool\\yuancheng 的代码",
        "oc_456",
        registry,
        deps,
      );

      expect(result.ok).toBe(true);
      expect(result.sessionId).toBe("sess-001");

      // 验证 registry 记录了 session
      const entry = registry.findByChatId("oc_456");
      expect(entry).not.toBeNull();
      expect(entry!.sessionId).toBeTruthy(); // 注册表可能已被磁盘 UUID 发现更新
      expect(entry!.projectDir).toBe("d:\\tool\\yuancheng");

      // 验证 Claude Code 被正确调用
      expect(deps.callClaude).toHaveBeenCalledTimes(1);
      const callArgs = (deps.callClaude as any).mock.calls[0];
      expect(callArgs[0]).toBe("审查 d:\\tool\\yuancheng 的代码");
      expect(callArgs[1].projectDir).toBe("d:\\tool\\yuancheng");
      expect(callArgs[1].sessionId).toBeUndefined(); // 首次没有 sessionId
    });

    it("从消息中提取项目目录（'在 <路径> 审查代码' 格式）", async () => {
      await executeTask(
        "在 d:\\work\\other-project 审查代码",
        "oc_789",
        registry,
        deps,
      );

      const entry = registry.findByChatId("oc_789");
      expect(entry!.projectDir).toBe("d:\\work\\other-project");
    });

    it("从消息中提取项目目录（'审查 <路径>' 格式）", async () => {
      await executeTask(
        "审查 d:\\projects\\myapp",
        "oc_999",
        registry,
        deps,
      );

      const entry = registry.findByChatId("oc_999");
      expect(entry!.projectDir).toBe("d:\\projects\\myapp");
    });
  });

  describe("后续消息 — 续接会话", () => {
    it("同一 chat 的后续消息自动复用已有项目目录，并传 sessionId 以 --resume 续接", async () => {
      // 第一条消息：创建 session（不传 sessionId）
      await executeTask(
        "审查 d:\\tool\\yuancheng 的代码",
        "oc_456",
        registry,
        deps,
      );

      // 第二条消息：复用项目目录，传 sessionId 以 --resume 续接
      const result = await executeTask(
        "修复你发现的问题",
        "oc_456",
        registry,
        deps,
      );

      expect(result.ok).toBe(true);

      // 第二次调用应传 sessionId（使用 --resume 保持上下文连续）
      const callArgs = (deps.callClaude as any).mock.calls[1];
      expect(callArgs[1].sessionId).toBeTruthy(); // 有 sessionId 即可（注册表可能已被磁盘 UUID 更新）
      expect(callArgs[1].projectDir).toBe("d:\\tool\\yuancheng");
    });

    it("后续消息不需要指定目录，使用已有会话的目录并 --resume", async () => {
      // 先建立会话
      await executeTask(
        "审查 d:\\tool\\yuancheng 的代码",
        "oc_456",
        registry,
        deps,
      );

      // 不指定目录的后续消息
      const result = await executeTask(
        "运行测试看看有没有失败",
        "oc_456",
        registry,
        deps,
      );

      expect(result.ok).toBe(true);
      const callArgs = (deps.callClaude as any).mock.calls[1];
      expect(callArgs[1].projectDir).toBe("d:\\tool\\yuancheng");
      expect(callArgs[1].sessionId).toBeTruthy();
    });
  });

  describe("切换项目", () => {
    it("发送「切换项目 <路径>」更新会话的项目目录", async () => {
      // 先在 A 项目
      await executeTask(
        "审查 d:\\tool\\yuancheng 的代码",
        "oc_456",
        registry,
        deps,
      );

      // 切换到 B 项目
      const result = await executeTask(
        "切换项目 d:\\work\\other-project",
        "oc_456",
        registry,
        deps,
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toContain("d:\\work\\other-project");

      // registry 已更新
      const entry = registry.findByChatId("oc_456");
      expect(entry!.projectDir).toBe("d:\\work\\other-project");
    });

    it("切换项目后生成新的 session ID", async () => {
      await executeTask(
        "审查 d:\\tool\\yuancheng 的代码",
        "oc_456",
        registry,
        deps,
      );

      const result = await executeTask(
        "切换项目 d:\\work\\other",
        "oc_456",
        registry,
        deps,
      );

      expect(result.sessionId).toBe("sess-002"); // 新 session
    });
  });

  describe("当前在哪个项目", () => {
    it("返回当前活跃项目路径", async () => {
      await executeTask(
        "审查 d:\\tool\\yuancheng 的代码",
        "oc_456",
        registry,
        deps,
      );

      const result = await executeTask(
        "当前在哪个项目",
        "oc_456",
        registry,
        deps,
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toContain("d:\\tool\\yuancheng");
      // 这种查询不应该调用 Claude Code
      expect(deps.callClaude).toHaveBeenCalledTimes(1); // 只有第一次调用了
    });

    it("还没有活跃会话时返回提示", async () => {
      const result = await executeTask(
        "当前在哪个项目",
        "oc_456",
        registry,
        deps,
      );

      expect(result.ok).toBe(true);
      expect(result.summary).toContain("没有活跃");
    });
  });

  describe("Claude Code 调用错误处理", () => {
    it("Claude Code 执行失败时返回错误", async () => {
      const failingDeps = makeDeps({
        callClaude: vi.fn().mockRejectedValue(new Error("CLI 进程崩溃")),
      });

      const result = await executeTask(
        "审查 d:\\tool\\yuancheng 的代码",
        "oc_456",
        registry,
        failingDeps,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("任务执行失败");
    });
  });

  describe("Session 意外退出后重连", () => {
    it("已有的 session 被清理后，下次带路径的消息自动创建新 session", async () => {
      // 先创建 session
      await executeTask(
        "审查 d:\\tool\\yuancheng 的代码",
        "oc_456",
        registry,
        deps,
      );

      // 模拟 session 被清理（如超时）——用实际注册的 sessionId
      const entry1 = registry.findByChatId("oc_456");
      expect(entry1).not.toBeNull();
      registry.remove(entry1!.sessionId);

      // 下一条带路径的消息应创建新 session
      const result = await executeTask(
        "在 d:\\tool\\yuancheng 继续审查代码",
        "oc_456",
        registry,
        deps,
      );

      expect(result.ok).toBe(true);
      expect(result.sessionId).toBeTruthy(); // 新的 session
    });

    it("session 清理后不带路径的模糊消息返回错误提示", async () => {
      await executeTask(
        "审查 d:\\tool\\yuancheng 的代码",
        "oc_456",
        registry,
        deps,
      );

      const entry1 = registry.findByChatId("oc_456");
      expect(entry1).not.toBeNull();
      registry.remove(entry1!.sessionId);

      const result = await executeTask(
        "继续审查",
        "oc_456",
        registry,
        deps,
      );

      expect(result.ok).toBe(false);
      expect(result.error).toContain("无法确定项目目录");
    });

    it("使用 deps.taskTimeoutMs 作为 callClaude 的超时参数", async () => {
      const mockCallClaude = vi.fn().mockResolvedValue("任务执行完成");
      const customDeps = makeDeps({
        callClaude: mockCallClaude,
        taskTimeoutMs: 120_000,
      });

      const result = await executeTask(
        "在 d:\\project 审查代码",
        "oc_456",
        registry,
        customDeps,
      );

      expect(result.ok).toBe(true);
      // 验证 callClaude 使用了自定义超时
      const callOpts = mockCallClaude.mock.calls[0][1];
      expect(callOpts.timeoutMs).toBe(120_000);
    });
  });
});
