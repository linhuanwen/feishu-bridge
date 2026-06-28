import { describe, it, expect, vi } from "vitest";
import { captureScreenshot } from "./captureScreenshot.js";

describe("captureScreenshot", () => {
  it("调用 PowerShell 截图并返回文件路径", async () => {
    const mockExec = vi.fn().mockResolvedValue({
      stdout: "screenshot saved",
      stderr: "",
    });

    const result = await captureScreenshot({
      exec: mockExec,
      tmpDir: "C:\\temp",
      now: () => new Date("2026-06-27T12:00:00.000Z"),
    });

    expect(result.filePath).toContain("C:\\temp");
    expect(result.filePath).toContain(".png");
    expect(mockExec).toHaveBeenCalledTimes(1);
    const cmd = mockExec.mock.calls[0][0] as string;
    expect(cmd).toContain("PowerShell");
    expect(cmd).toContain("System.Windows.Forms");
    expect(cmd).toContain("Graphics");
  });

  it("exec 失败时抛出错误", async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error("PowerShell not found"));

    await expect(
      captureScreenshot({ exec: mockExec }),
    ).rejects.toThrow("PowerShell not found");
  });
});
