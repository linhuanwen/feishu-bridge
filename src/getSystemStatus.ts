export type SystemStatusResult = {
  /** CPU 温度（摄氏度），null 表示无法获取 */
  cpuTemp: number | null;
  memory: { total: number; used: number; free: number; usagePercent: number };
  /** GPU 名称，null 表示无法获取 */
  gpu: string | null;
  /** 系统运行时间（秒），null 表示无法获取 */
  osUptime: number | null;
};

export type GetSystemStatusDeps = {
  /** 执行系统命令（mock 边界） */
  exec?: (command: string) => Promise<{ stdout: string; stderr: string }>;
};

/**
 * 通过 WMIC 查询系统硬件状态。
 * WMIC 在 Windows 11 上可能不可用，此时回退到 null 值。
 */
export async function getSystemStatus(
  deps: GetSystemStatusDeps = {},
): Promise<SystemStatusResult> {
  const exec = deps.exec ?? defaultExec;

  const [cpuTemp, memory, gpu, uptime] = await Promise.allSettled([
    queryCpuTemp(exec),
    queryMemory(exec),
    queryGpu(exec),
    queryUptime(exec),
  ]);

  return {
    cpuTemp: cpuTemp.status === "fulfilled" ? cpuTemp.value : null,
    memory:
      memory.status === "fulfilled"
        ? memory.value
        : { total: 0, used: 0, free: 0, usagePercent: 0 },
    gpu: gpu.status === "fulfilled" ? gpu.value : null,
    osUptime: uptime.status === "fulfilled" ? uptime.value : null,
  };
}

// ── 各查询子函数 ──

async function queryCpuTemp(
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>,
): Promise<number> {
  const { stdout } = await exec(
    'wmic /namespace:\\\\root\\wmi PATH MSAcpi_ThermalZoneTemperature get CurrentTemperature /value',
  );
  // 输出格式：CurrentTemperature=3030（十分之一开尔文）
  const match = stdout.match(/CurrentTemperature[=\s]+(\d+)/i);
  if (!match) throw new Error("无法解析 CPU 温度");
  const kelvin = Number(match[1]) / 10;
  return kelvin - 273.15; // 转为摄氏度
}

async function queryMemory(
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>,
): Promise<{ total: number; used: number; free: number; usagePercent: number }> {
  const { stdout } = await exec(
    "wmic OS get TotalVisibleMemorySize,FreePhysicalMemory /value",
  );
  const totalMatch = stdout.match(/TotalVisibleMemorySize[=\s]+(\d+)/i);
  const freeMatch = stdout.match(/FreePhysicalMemory[=\s]+(\d+)/i);

  const totalKB = totalMatch ? Number(totalMatch[1]) : 0;
  const freeKB = freeMatch ? Number(freeMatch[1]) : 0;
  // 转换为 GB
  const total = Math.round(totalKB / (1024 * 1024));
  const free = Math.round(freeKB / (1024 * 1024));
  const used = total - free;
  const usagePercent = total > 0 ? Math.round((used / total) * 100) : 0;

  return { total, used, free, usagePercent };
}

async function queryGpu(
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>,
): Promise<string> {
  const { stdout } = await exec(
    "wmic path win32_videocontroller get caption /value",
  );
  const match = stdout.match(/Caption[=\s]+(.+)/i);
  if (!match) throw new Error("无法解析 GPU 信息");
  return match[1].trim();
}

async function queryUptime(
  exec: (cmd: string) => Promise<{ stdout: string; stderr: string }>,
): Promise<number> {
  const { stdout } = await exec("wmic OS get LastBootUpTime /value");
  const match = stdout.match(/LastBootUpTime[=\s]+(\d{14})/);
  if (!match) throw new Error("无法解析系统启动时间");

  // WMIC 格式：YYYYMMDDHHmmss
  const bootStr = match[1];
  const year = Number(bootStr.slice(0, 4));
  const month = Number(bootStr.slice(4, 6)) - 1;
  const day = Number(bootStr.slice(6, 8));
  const hour = Number(bootStr.slice(8, 10));
  const min = Number(bootStr.slice(10, 12));
  const sec = Number(bootStr.slice(12, 14));

  const bootTime = new Date(year, month, day, hour, min, sec);
  const now = new Date();
  return Math.round((now.getTime() - bootTime.getTime()) / 1000);
}

/** 格式化 SystemStatusResult 为用户可读文本 */
export function formatSystemStatus(result: SystemStatusResult): string {
  const lines: string[] = ["📊 系统状态"];

  // CPU 温度
  if (result.cpuTemp !== null) {
    lines.push(`🌡 CPU 温度：${result.cpuTemp.toFixed(1)}°C`);
  } else {
    lines.push("🌡 CPU 温度：无法获取（WMIC 不可用）");
  }

  // 内存
  const memPercent =
    result.memory.total > 0
      ? ((result.memory.used / result.memory.total) * 100).toFixed(1)
      : "?";
  lines.push(
    `💾 内存：${result.memory.used} GB / ${result.memory.total} GB（${memPercent}%）`,
  );

  // GPU
  lines.push(`🎮 GPU：${result.gpu ?? "无法获取"}`);

  // 运行时间
  if (result.osUptime !== null) {
    const hours = Math.floor(result.osUptime / 3600);
    const mins = Math.floor((result.osUptime % 3600) / 60);
    lines.push(`⏱ 系统运行时间：${hours} 小时 ${mins} 分钟`);
  } else {
    lines.push("⏱ 系统运行时间：无法获取");
  }

  return lines.join("\n");
}

/** 默认的 exec 实现 */
async function defaultExec(
  command: string,
): Promise<{ stdout: string; stderr: string }> {
  const { exec } = await import("child_process");
  return new Promise((resolve, reject) => {
    exec(command, { timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}
