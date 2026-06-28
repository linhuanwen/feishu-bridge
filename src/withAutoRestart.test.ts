import { describe, it, expect, vi, beforeEach } from "vitest";
import { withAutoRestart } from "./withAutoRestart.js";

describe("withAutoRestart", () => {
  let onCrash: ReturnType<typeof vi.fn>;
  let onExhausted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onCrash = vi.fn();
    onExhausted = vi.fn();
  });

  it("正常执行包装的函数，返回其结果", async () => {
    let running = false;
    const fn = async () => {
      running = true;
    };

    const restartable = withAutoRestart({
      fn,
      maxRetries: 3,
      onCrash,
      onExhausted,
    });

    await restartable.start();
    expect(running).toBe(true);
    expect(onCrash).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("崩溃后自动重启并调用 onCrash", async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error("模拟崩溃");
      }
    };

    const restartable = withAutoRestart({
      fn,
      maxRetries: 3,
      onCrash,
      onExhausted,
      // 无延迟，立即重试（测试环境）
      retryDelayMs: 0,
    });

    await restartable.start();

    // 崩溃 2 次后第 3 次成功
    expect(callCount).toBe(3);
    expect(onCrash).toHaveBeenCalledTimes(2);
    expect(onCrash).toHaveBeenCalledWith(1, "模拟崩溃");
    expect(onCrash).toHaveBeenCalledWith(2, "模拟崩溃");
    expect(onExhausted).not.toHaveBeenCalled();
  });

  it("超过最大重试次数后调用 onExhausted", async () => {
    const fn = async () => {
      throw new Error("持续崩溃");
    };

    const restartable = withAutoRestart({
      fn,
      maxRetries: 3,
      onCrash,
      onExhausted,
      retryDelayMs: 0,
    });

    await restartable.start();

    // 初始 1 次 + 3 次重试 = 共 4 次调用
    expect(onCrash).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledWith(3, "持续崩溃");
  });

  it("maxRetries 为 0 时崩溃不重试", async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error("崩溃");
    };

    const restartable = withAutoRestart({
      fn,
      maxRetries: 0,
      onCrash,
      onExhausted,
      retryDelayMs: 0,
    });

    await restartable.start();
    expect(callCount).toBe(1);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("稳定运行后重置重试计数", async () => {
    // 使用可外部控制的 Promise 来模拟长期运行服务的崩溃与恢复
    let rejectFn: (err: Error) => void = () => {};
    let resolveFn: () => void = () => {};

    let callCount = 0;
    const fn = async () => {
      callCount++;
      // 返回一个受控的 Promise
      return new Promise<void>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
      });
    };

    const restartable = withAutoRestart({
      fn,
      maxRetries: 3,
      onCrash,
      onExhausted,
      retryDelayMs: 10,
      resetAfterMs: 500,
    });

    // 启动 — fn 被调用并挂起
    const startPromise = restartable.start();
    expect(callCount).toBe(1);

    // 第一次崩溃
    rejectFn(new Error("崩溃 #1"));
    // 等待微任务处理完毕
    await new Promise((r) => setTimeout(r, 20)); // 等待 10ms 延迟 + 余量

    expect(onCrash).toHaveBeenCalledTimes(1);
    expect(onCrash).toHaveBeenCalledWith(1, "崩溃 #1");
    expect(callCount).toBe(2); // 已重试

    // 第二次成功
    resolveFn();
    await startPromise; // start() 返回，scheduleReset 已触发

    // 等待 resetAfterMs 过后（用真实时间近似，因为 resetAfterMs 的 timer 是真实 setTimeout）
    await new Promise((r) => setTimeout(r, 600));

    // 再次启动，第一次就崩溃
    const startPromise2 = restartable.start();
    rejectFn(new Error("崩溃 #2"));
    await new Promise((r) => setTimeout(r, 20));

    // 计数应已重置，所以是 attempt 1 而非 2
    expect(onCrash).toHaveBeenCalledTimes(2);
    expect(onCrash).toHaveBeenLastCalledWith(1, "崩溃 #2");
    expect(callCount).toBe(4); // 第 3 次 = start2，第 4 次 = 重试

    // 清理
    restartable.stop();
    try { resolveFn(); } catch { /* 忽略 */ }
  }, 5000);

  it("stop 方法中止自动重启", async () => {
    let callCount = 0;
    const fn = async () => {
      callCount++;
      throw new Error("崩溃");
    };

    const restartable = withAutoRestart({
      fn,
      maxRetries: 10,
      onCrash,
      onExhausted,
      retryDelayMs: 100,
    });

    // 不 await start() — 它会一直重试
    const startPromise = restartable.start();

    // 等待第一次调用完成
    await new Promise((r) => setTimeout(r, 20));

    restartable.stop();

    await startPromise;

    // 应该只有 1 次调用（stop 阻止了重试）
    expect(callCount).toBe(1);
  }, 5000);
});
