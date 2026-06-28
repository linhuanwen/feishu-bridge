import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHealthChecker, type HealthCheck } from "./createHealthChecker.js";

describe("createHealthChecker", () => {
  let onUnhealthy: ReturnType<typeof vi.fn>;
  let checks: HealthCheck[];

  beforeEach(() => {
    onUnhealthy = vi.fn();
    checks = [];
  });

  it("runOnce 执行所有注册的检查并返回结果", async () => {
    checks = [
      { name: "Ollama", check: async () => ({ healthy: true }) },
      { name: "Claude CLI", check: async () => ({ healthy: true }) },
    ];

    const checker = createHealthChecker({
      checks,
      onUnhealthy,
      intervalMs: 300_000,
    });

    const report = await checker.runOnce();
    expect(report.length).toBe(2);
    expect(report[0].name).toBe("Ollama");
    expect(report[0].healthy).toBe(true);
    expect(report[1].name).toBe("Claude CLI");
    expect(report[1].healthy).toBe(true);
  });

  it("所有检查通过时不调用 onUnhealthy", async () => {
    checks = [
      { name: "Ollama", check: async () => ({ healthy: true }) },
      { name: "Claude CLI", check: async () => ({ healthy: true }) },
    ];

    const checker = createHealthChecker({
      checks,
      onUnhealthy,
      intervalMs: 300_000,
    });

    await checker.runOnce();
    expect(onUnhealthy).not.toHaveBeenCalled();
  });

  it("检查失败时调用 onUnhealthy 并传递服务名和详情", async () => {
    checks = [
      { name: "Ollama", check: async () => ({ healthy: false, detail: "连接超时" }) },
      { name: "Claude CLI", check: async () => ({ healthy: true }) },
    ];

    const checker = createHealthChecker({
      checks,
      onUnhealthy,
      intervalMs: 300_000,
    });

    await checker.runOnce();
    expect(onUnhealthy).toHaveBeenCalledTimes(1);
    expect(onUnhealthy).toHaveBeenCalledWith("Ollama", "连接超时");
  });

  it("多个检查失败时每个都调用 onUnhealthy", async () => {
    checks = [
      { name: "Ollama", check: async () => ({ healthy: false, detail: "无响应" }) },
      { name: "Claude CLI", check: async () => ({ healthy: false, detail: "未安装" }) },
    ];

    const checker = createHealthChecker({
      checks,
      onUnhealthy,
      intervalMs: 300_000,
    });

    await checker.runOnce();
    expect(onUnhealthy).toHaveBeenCalledTimes(2);
  });

  it("start 启动周期性检查，stop 停止", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    checks = [
      {
        name: "Test",
        check: async () => {
          callCount++;
          return { healthy: true };
        },
      },
    ];

    const checker = createHealthChecker({
      checks,
      onUnhealthy,
      intervalMs: 60_000,
    });

    checker.start();

    // 启动时立即执行一次
    expect(callCount).toBe(1);

    // 前进 60 秒，应触发第二次
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callCount).toBe(2);

    // 前进 60 秒，应触发第三次
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callCount).toBe(3);

    // 停止后不再触发
    checker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callCount).toBe(3);

    vi.useRealTimers();
  });

  it("intervalMs 为 0 时 start 只执行一次不启动定时器", async () => {
    vi.useFakeTimers();

    let callCount = 0;
    checks = [
      {
        name: "Test",
        check: async () => {
          callCount++;
          return { healthy: true };
        },
      },
    ];

    const checker = createHealthChecker({
      checks,
      onUnhealthy,
      intervalMs: 0,
    });

    checker.start();
    expect(callCount).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    // 不应有额外的调用
    expect(callCount).toBe(1);

    vi.useRealTimers();
  });

  it("检查抛出异常时视为 unhealthy", async () => {
    checks = [
      { name: "Ollama", check: async () => { throw new Error("网络错误"); } },
    ];

    const checker = createHealthChecker({
      checks,
      onUnhealthy,
      intervalMs: 300_000,
    });

    const report = await checker.runOnce();
    expect(report[0].healthy).toBe(false);
    expect(report[0].detail).toContain("网络错误");
    expect(onUnhealthy).toHaveBeenCalledWith("Ollama", "网络错误");
  });

  it("onUnhealthy 为可选参数，不传时仅返回报告", async () => {
    checks = [
      { name: "Ollama", check: async () => ({ healthy: false, detail: "无响应" }) },
    ];

    const checker = createHealthChecker({
      checks,
      intervalMs: 300_000,
    });

    // 不应抛错
    const report = await checker.runOnce();
    expect(report[0].healthy).toBe(false);
  });
});
