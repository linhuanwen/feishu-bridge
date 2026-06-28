import { describe, it, expect, vi } from "vitest";
import { executeSimpleCommand, type CommandReply } from "./executeSimpleCommand.js";
import type { CommandConfig } from "./commandConfig.js";

const testConfig: CommandConfig = {
  commands: [
    { id: "screenshot", aliases: ["截图", "截屏", "screenshot"], needsArg: false },
    { id: "systemStatus", aliases: ["状态", "温度", "cpu", "status", "系统状态"], needsArg: false },
    { id: "listDirectory", aliases: ["ls", "dir", "列出", "目录"], needsArg: true },
    { id: "openProgram", aliases: ["打开", "启动"], needsArg: true },
    { id: "closeProgram", aliases: ["关闭", "退出", "结束"], needsArg: true },
    { id: "runScript", aliases: ["运行", "执行脚本", "执行"], needsArg: true },
  ],
  scriptWhitelist: [],
  programMap: {},
};

describe("executeSimpleCommand", () => {
  const mockListDir = vi.fn();

  beforeEach(() => {
    mockListDir.mockClear();
  });

  function textOf(reply: CommandReply | null): string | null {
    if (reply === null) return null;
    if (reply.kind === "text") return reply.content;
    return null;
  }

  it("匹配 'ls <路径>' 并返回格式化的目录列表", async () => {
    mockListDir.mockResolvedValue({
      ok: true,
      entries: [
        { name: "a.txt", size: "100 B", modifiedAt: "2026-01-01T00:00:00.000Z" },
        { name: "subdir", size: "0 B", modifiedAt: "2026-01-02T00:00:00.000Z" },
      ],
    });

    const reply = await executeSimpleCommand("ls D:\\projects", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
    });

    expect(reply).not.toBeNull();
    expect(textOf(reply)).toContain("D:\\projects");
    expect(textOf(reply)).toContain("a.txt");
    expect(textOf(reply)).toContain("100 B");
    expect(textOf(reply)).toContain("subdir");
    expect(mockListDir).toHaveBeenCalledWith("D:\\projects");
  });

  it("匹配 'dir <路径>' 并返回目录列表", async () => {
    mockListDir.mockResolvedValue({
      ok: true,
      entries: [{ name: "readme.md", size: "1.5 KB", modifiedAt: "2026-06-01T00:00:00.000Z" }],
    });

    const reply = await executeSimpleCommand("dir C:\\test", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
    });

    expect(reply).not.toBeNull();
    expect(textOf(reply)).toContain("readme.md");
    expect(textOf(reply)).toContain("1.5 KB");
    expect(mockListDir).toHaveBeenCalledWith("C:\\test");
  });

  it("路径不存在时返回错误提示", async () => {
    mockListDir.mockResolvedValue({
      ok: false,
      error: "找不到路径：Z:\\xxx（ENOENT）",
    });

    const reply = await executeSimpleCommand("ls Z:\\xxx", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
    });

    expect(reply).not.toBeNull();
    expect(textOf(reply)).toContain("找不到路径");
  });

  it("不匹配任何已知指令时返回 null", async () => {
    const reply = await executeSimpleCommand("今天天气怎么样", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
    });

    expect(reply).toBeNull();
    expect(mockListDir).not.toHaveBeenCalled();
  });

  it("匹配 '截图' 并返回 image 类型结果", async () => {
    const mockCaptureScreenshot = vi.fn().mockResolvedValue({
      filePath: "C:\\temp\\screenshot-2026-06-27.png",
    });

    const reply = await executeSimpleCommand("截图", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      captureScreenshot: mockCaptureScreenshot,
    });

    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("image");
    if (reply!.kind === "image") {
      expect(reply!.filePath).toContain("screenshot");
    }
    expect(mockCaptureScreenshot).toHaveBeenCalledTimes(1);
  });

  it("匹配英文 'screenshot' 也返回 image 结果", async () => {
    const mockCaptureScreenshot = vi.fn().mockResolvedValue({
      filePath: "C:\\temp\\screenshot-2026-06-27.png",
    });

    const reply = await executeSimpleCommand("screenshot", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      captureScreenshot: mockCaptureScreenshot,
    });

    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("image");
    expect(mockCaptureScreenshot).toHaveBeenCalledTimes(1);
  });

  it("未配置 captureScreenshot 时截图指令返回 null（优雅降级）", async () => {
    const reply = await executeSimpleCommand("截图", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      // 不传 captureScreenshot
    });

    // 指令匹配了但没有对应执行器 → 返回 null
    expect(reply).toBeNull();
  });

  // ── 系统状态 ──

  it("匹配 '状态' 并返回格式化的系统状态文本", async () => {
    const mockGetSystemStatus = vi.fn().mockResolvedValue({
      cpuTemp: 45.2,
      memory: { total: 32, used: 20, free: 12, usagePercent: 63 },
      gpu: "NVIDIA GeForce RTX 5060",
      osUptime: 36000,
    });

    const reply = await executeSimpleCommand("状态", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      getSystemStatus: mockGetSystemStatus,
    });

    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("text");
    if (reply!.kind === "text") {
      expect(reply!.content).toContain("45.2°C");
      expect(reply!.content).toContain("32 GB");
      expect(reply!.content).toContain("RTX 5060");
    }
    expect(mockGetSystemStatus).toHaveBeenCalledTimes(1);
  });

  it("匹配 'cpu' 也返回系统状态", async () => {
    const mockGetSystemStatus = vi.fn().mockResolvedValue({
      cpuTemp: 50,
      memory: { total: 16, used: 8, free: 8, usagePercent: 50 },
      gpu: "Intel Arc",
      osUptime: 7200,
    });

    const reply = await executeSimpleCommand("cpu", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      getSystemStatus: mockGetSystemStatus,
    });

    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("text");
    expect(mockGetSystemStatus).toHaveBeenCalledTimes(1);
  });

  // ── 打开/关闭程序 ──

  it("匹配 '打开 Chrome' → 调用 openProgram 并返回确认文本", async () => {
    const mockOpen = vi.fn().mockResolvedValue({
      success: true,
      message: "✅ Chrome 已启动",
    });

    const reply = await executeSimpleCommand("打开 Chrome", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      openProgram: mockOpen,
    });

    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("text");
    if (reply!.kind === "text") {
      expect(reply!.content).toContain("Chrome 已启动");
    }
    expect(mockOpen).toHaveBeenCalledWith("Chrome");
  });

  it("匹配 '关闭 Chrome' → 调用 closeProgram 并返回确认文本", async () => {
    const mockClose = vi.fn().mockResolvedValue({
      success: true,
      message: "✅ Chrome 已关闭",
    });

    const reply = await executeSimpleCommand("关闭 Chrome", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      closeProgram: mockClose,
    });

    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("text");
    if (reply!.kind === "text") {
      expect(reply!.content).toContain("已关闭");
    }
    expect(mockClose).toHaveBeenCalledWith("Chrome");
  });

  it("匹配中文无空格 '打开Chrome' → 正确提取参数", async () => {
    const mockOpen = vi.fn().mockResolvedValue({
      success: true,
      message: "✅ Chrome 已启动",
    });

    const reply = await executeSimpleCommand("打开Chrome", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      openProgram: mockOpen,
    });

    expect(reply).not.toBeNull();
    expect(mockOpen).toHaveBeenCalledWith("Chrome");
  });

  // ── 运行脚本 ──

  it("匹配 '运行 d:\\backup.bat' → 调用 runScript 并返回执行结果", async () => {
    const mockRunScript = vi.fn().mockResolvedValue({
      ok: true,
      stdout: "备份完成",
      stderr: "",
    });

    const reply = await executeSimpleCommand("运行 d:\\backup.bat", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      runScript: mockRunScript,
    });

    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("text");
    if (reply!.kind === "text") {
      expect(reply!.content).toContain("备份完成");
    }
    expect(mockRunScript).toHaveBeenCalledWith("d:\\backup.bat");
  });

  it("脚本不在白名单 → runScript 返回错误 → 用户看到被拒提示", async () => {
    const mockRunScript = vi.fn().mockResolvedValue({
      ok: false,
      error: "⛔ 脚本不在白名单中，已被拒绝：d:\\malware.bat",
    });

    const reply = await executeSimpleCommand("运行 d:\\malware.bat", {
      listDirectory: mockListDir,
      commandConfig: testConfig,
      runScript: mockRunScript,
    });

    expect(reply).not.toBeNull();
    expect(reply!.kind).toBe("text");
    if (reply!.kind === "text") {
      expect(reply!.content).toContain("不在白名单");
    }
  });
});
