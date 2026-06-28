import { describe, it, expect, vi } from "vitest";
import { runScript, type ScriptRunResult } from "./runScript.js";

describe("runScript", () => {
  const whitelist = [
    "d:\\scripts\\backup.bat",
    "d:\\scripts\\cleanup.ps1",
    "c:\\tools\\report.exe",
  ];

  it("白名单内脚本 → 执行并返回 stdout", async () => {
    const mockExecFile = vi.fn().mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "备份完成", "");
      },
    );

    const result = await runScript("d:\\scripts\\backup.bat", {
      execFile: mockExecFile as any,
      whitelist,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.stdout).toContain("备份完成");
    }
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("不在白名单的脚本 → 被拒绝并返回清晰提示", async () => {
    const mockExecFile = vi.fn();

    const result = await runScript("d:\\malware.bat", {
      execFile: mockExecFile as any,
      whitelist,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("不在白名单");
      expect(result.error).toContain("d:\\malware.bat");
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("路径穿越（..\\..\\）→ 标准化后不在白名单 → 被拒绝", async () => {
    const mockExecFile = vi.fn();

    const result = await runScript("d:\\scripts\\..\\..\\windows\\system32\\calc.exe", {
      execFile: mockExecFile as any,
      whitelist,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("不在白名单");
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("已在白名单的路径大小写变化 → 标准化后匹配成功", async () => {
    const mockExecFile = vi.fn().mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: Function) => {
        cb(null, "清理完成", "");
      },
    );

    const result = await runScript("D:\\Scripts\\Cleanup.ps1", {
      execFile: mockExecFile as any,
      whitelist,
    });

    expect(result.ok).toBe(true);
  });

  it("脚本超时 → 返回超时错误", async () => {
    const mockExecFile = vi.fn().mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: Function) => {
        // 模拟超时：不调用回调
        // execFile 的超时由 Node.js 处理，此处模拟错误回调
        const err: any = new Error("ETIMEDOUT");
        err.killed = true;
        cb(err, "", "");
      },
    );

    const result = await runScript("d:\\scripts\\backup.bat", {
      execFile: mockExecFile as any,
      whitelist,
      timeoutMs: 100,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("超时");
    }
  });

  it("脚本执行失败（非零退出码）→ 返回 stderr", async () => {
    const mockExecFile = vi.fn().mockImplementation(
      (_file: string, _args: string[], _opts: unknown, cb: Function) => {
        const err: any = new Error("Command failed");
        err.code = 1;
        cb(err, "", "找不到文件");
      },
    );

    const result = await runScript("d:\\scripts\\backup.bat", {
      execFile: mockExecFile as any,
      whitelist,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("找不到文件");
    }
  });
});
