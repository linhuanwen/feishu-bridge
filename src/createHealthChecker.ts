export type HealthCheckResult = {
  name: string;
  healthy: boolean;
  detail?: string;
};

export type HealthCheck = {
  name: string;
  check: () => Promise<Omit<HealthCheckResult, "name">>;
};

export type HealthReport = HealthCheckResult;

export type HealthCheckerOptions = {
  checks: HealthCheck[];
  /** 服务从健康变为不健康时触发（仅状态变更时通知，避免重复轰炸） */
  onUnhealthy?: (service: string, detail: string) => void;
  /** 服务从不健康恢复为健康时触发 */
  onRecovered?: (service: string) => void;
  intervalMs: number;
};

export type HealthChecker = {
  /** 启动周期性健康检查，并立即执行一次 */
  start: () => void;
  /** 停止周期性健康检查 */
  stop: () => void;
  /** 执行一次所有检查，返回报告 */
  runOnce: () => Promise<HealthReport[]>;
};

export function createHealthChecker(options: HealthCheckerOptions): HealthChecker {
  const { checks, onUnhealthy, onRecovered, intervalMs } = options;
  let timer: ReturnType<typeof setInterval> | null = null;

  // 跟踪每个服务的上一次健康状态，只在状态变更时通知
  // undefined = 首次检查（不通知，除非不健康且需要初始化告警）
  const previousState = new Map<string, boolean>();

  async function runOnce(): Promise<HealthReport[]> {
    const results = await Promise.all(
      checks.map(async (c): Promise<HealthReport> => {
        try {
          const result = await c.check();
          return { name: c.name, ...result };
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          return { name: c.name, healthy: false, detail };
        }
      }),
    );

    // 仅状态变更时通知，避免重复轰炸
    for (const r of results) {
      const prev = previousState.get(r.name);

      if (!r.healthy && prev !== false) {
        // 首次发现异常 或 从健康→不健康
        onUnhealthy?.(r.name, r.detail ?? "未知错误");
      } else if (r.healthy && prev === false) {
        // 从不健康→健康（恢复）
        onRecovered?.(r.name);
      }

      previousState.set(r.name, r.healthy);
    }

    return results;
  }

  function start(): void {
    // 立即执行一次
    void runOnce();

    // 周期性执行（intervalMs 为 0 时不启动定时器）
    if (intervalMs > 0) {
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
    }
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, runOnce };
}
