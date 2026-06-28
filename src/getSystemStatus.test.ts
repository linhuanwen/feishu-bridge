import { describe, it, expect, vi } from "vitest";
import { getSystemStatus, formatSystemStatus } from "./getSystemStatus.js";

describe("getSystemStatus", () => {
  it("解析 WMIC 输出返回 CPU 温度、内存、GPU 状态", async () => {
    const mockExec = vi
      .fn()
      // 第一次调用：CPU 温度（WMIC 返回十分之一开尔文）
      .mockResolvedValueOnce({
        stdout: "CurrentTemperature\n3030\n",
        stderr: "",
      })
      // 第二次调用：内存信息
      .mockResolvedValueOnce({
        stdout:
          "TotalVisibleMemorySize=33554432\nFreePhysicalMemory=16777216\n",
        stderr: "",
      })
      // 第三次调用：GPU 信息
      .mockResolvedValueOnce({
        stdout: "Caption\nNVIDIA GeForce RTX 5060\n",
        stderr: "",
      })
      // 第四次调用：系统运行时间
      .mockResolvedValueOnce({
        stdout: "LastBootUpTime\n20260627120000.500000+480\n",
        stderr: "",
      });

    const result = await getSystemStatus({ exec: mockExec });

    // CPU 温度：3030 / 10 - 273.15 ≈ 29.85°C
    expect(result.cpuTemp).toBeCloseTo(29.85, 1);
    // 内存：33554432 KB ≈ 32 GB total, 16777216 KB ≈ 16 GB free
    expect(result.memory.total).toBe(32);
    expect(result.memory.used).toBe(16);
    expect(result.memory.free).toBe(16);
    expect(result.memory.usagePercent).toBe(50);
    // GPU
    expect(result.gpu).toBe("NVIDIA GeForce RTX 5060");
    // 运行时间存在
    expect(result.osUptime).not.toBeNull();

    expect(mockExec).toHaveBeenCalledTimes(4);
  });

  it("WMIC 命令全部失败时返回 null 值的降级结果", async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error("command not found"));

    const result = await getSystemStatus({ exec: mockExec });

    expect(result.cpuTemp).toBeNull();
    expect(result.memory.total).toBe(0);
    expect(result.gpu).toBeNull();
    expect(result.osUptime).toBeNull();
  });

  it("formatSystemStatus 输出可读文本", async () => {
    const mockExec = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "CurrentTemperature\n3050\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "TotalVisibleMemorySize=16777216\nFreePhysicalMemory=8388608\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "Caption\nIntel Arc Graphics\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "LastBootUpTime\n20260627080000.000000+480\n",
        stderr: "",
      });

    const result = await getSystemStatus({ exec: mockExec });
    const text = formatSystemStatus(result);

    expect(text).toContain("📊 系统状态");
    expect(text).toContain("🌡 CPU 温度");
    expect(text).toContain("31.9°C"); // 3050/10 - 273.15 = 31.85 → toFixed(1) = 31.9
    expect(text).toContain("💾 内存");
    expect(text).toContain("🎮 GPU");
    expect(text).toContain("Intel Arc Graphics");
    expect(text).toContain("⏱ 系统运行时间");
  });

  it("formatSystemStatus 处理 null 值的降级显示", () => {
    const text = formatSystemStatus({
      cpuTemp: null,
      memory: { total: 0, used: 0, free: 0, usagePercent: 0 },
      gpu: null,
      osUptime: null,
    });

    expect(text).toContain("无法获取");
    expect(text).toContain("?");
  });
});
