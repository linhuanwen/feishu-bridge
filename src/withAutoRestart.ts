export type AutoRestartOptions = {
  /** 要包装的异步函数（如启动网关） */
  fn: () => Promise<void>;
  /** 最多重试次数，默认 3 */
  maxRetries?: number;
  /** 崩溃回调，传递当前重试次数和错误消息 */
  onCrash?: (attempt: number, errorMessage: string) => void;
  /** 重试次数耗尽回调 */
  onExhausted?: (totalRetries: number, lastErrorMessage: string) => void;
  /** 重试延迟（毫秒），默认 2000 */
  retryDelayMs?: number;
  /** 稳定运行多长时间（毫秒）后重置崩溃计数，默认 60_000 */
  resetAfterMs?: number;
};

export type Restartable = {
  /** 启动包装的函数，崩溃时自动重启 */
  start: () => Promise<void>;
  /** 停止自动重启循环 */
  stop: () => void;
};

/**
 * 为异步启动函数添加崩溃自动重启能力。
 *
 * - 崩溃后等待 retryDelayMs 再重试
 * - 最多重试 maxRetries 次（不含首次尝试）
 * - 连续崩溃计数在稳定运行 resetAfterMs 后归零
 * - 调用 stop() 可立即中止重启循环（包括正在进行的 delay）
 */
export function withAutoRestart(options: AutoRestartOptions): Restartable {
  const {
    fn,
    maxRetries = 3,
    retryDelayMs = 2000,
    resetAfterMs = 60_000,
    onCrash,
    onExhausted,
  } = options;

  let stopped = false;
  let retryCount = 0;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;

  // 用于中止 delay 的 resolver
  let delayResolver: (() => void) | null = null;

  function clearResetTimer(): void {
    if (resetTimer !== null) {
      clearTimeout(resetTimer);
      resetTimer = null;
    }
  }

  function scheduleReset(): void {
    clearResetTimer();
    resetTimer = setTimeout(() => {
      retryCount = 0;
      resetTimer = null;
    }, resetAfterMs);
  }

  /** 可被 stop() 中止的延迟 */
  function abortableDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        delayResolver = null;
        resolve();
      }, ms);
      delayResolver = () => {
        clearTimeout(timer);
        delayResolver = null;
        resolve();
      };
    });
  }

  async function start(): Promise<void> {
    stopped = false;
    retryCount = 0;

    while (!stopped) {
      try {
        await fn();
        // 正常运行结束 → 启动重置计时器
        scheduleReset();
        return;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (stopped) return;

        // 检查是否还能重试
        if (retryCount >= maxRetries) {
          onExhausted?.(maxRetries, errorMessage);
          return;
        }

        retryCount++;
        onCrash?.(retryCount, errorMessage);

        // 等待后重试
        if (retryDelayMs > 0 && !stopped) {
          await abortableDelay(retryDelayMs);
        }
      }
    }
  }

  function stop(): void {
    stopped = true;
    clearResetTimer();
    // 中止正在进行的 delay
    delayResolver?.();
  }

  return { start, stop };
}
