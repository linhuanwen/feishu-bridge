import { describe, it, expect, vi } from "vitest";
import {
  openProgram,
  closeProgram,
  type ProgramResult,
  type ProgramManagerDeps,
} from "./programManager.js";

function makeDeps(overrides?: Partial<ProgramManagerDeps>): ProgramManagerDeps {
  return {
    exec: vi.fn().mockResolvedValue({ stdout: "OK", stderr: "" }),
    programMap: {
      chrome: { executable: "chrome.exe", processName: "chrome.exe" },
      记事本: { executable: "notepad.exe", processName: "notepad.exe" },
    },
    ...overrides,
  };
}

describe("openProgram", () => {
  it("通过 programMap 精确匹配 → 启动程序", async () => {
    const deps = makeDeps();
    const result = await openProgram("chrome", deps);

    expect(result.success).toBe(true);
    expect(result.message).toContain("chrome 已启动");
    expect(deps.exec).toHaveBeenCalledWith(
      expect.stringContaining("chrome.exe"),
    );
  });

  it("程序名不在 programMap 中 → 返回错误", async () => {
    const deps = makeDeps();
    const result = await openProgram("firefox", deps);

    expect(result.success).toBe(false);
    expect(result.message).toContain("找不到程序");
    expect(result.message).toContain("firefox");
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("支持中文程序名 → '记事本' 映射到 notepad.exe", async () => {
    const deps = makeDeps();
    const result = await openProgram("记事本", deps);

    expect(result.success).toBe(true);
    expect(deps.exec).toHaveBeenCalledWith(
      expect.stringContaining("notepad.exe"),
    );
  });

  it("exec 启动失败时返回错误信息", async () => {
    const deps = makeDeps({
      exec: vi.fn().mockRejectedValue(new Error("找不到可执行文件")),
    });

    const result = await openProgram("chrome", deps);

    expect(result.success).toBe(false);
    expect(result.message).toContain("启动失败");
  });
});

describe("closeProgram", () => {
  it("通过 programMap 查找进程名 → 发送 taskkill 关闭", async () => {
    const deps = makeDeps();
    const result = await closeProgram("chrome", deps);

    expect(result.success).toBe(true);
    expect(result.message).toContain("chrome 已关闭");
    expect(deps.exec).toHaveBeenCalledWith(
      expect.stringContaining("taskkill"),
    );
    expect(deps.exec).toHaveBeenCalledWith(
      expect.stringContaining("chrome.exe"),
    );
  });

  it("程序名不在 programMap 中 → 返回错误", async () => {
    const deps = makeDeps();
    const result = await closeProgram("firefox", deps);

    expect(result.success).toBe(false);
    expect(result.message).toContain("找不到程序");
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("taskkill 失败（进程未运行）→ 返回友好提示", async () => {
    const deps = makeDeps({
      exec: vi.fn().mockRejectedValue(new Error("没有找到进程")),
    });

    const result = await closeProgram("chrome", deps);

    expect(result.success).toBe(false);
    expect(result.message).toContain("未运行");
  });
});
