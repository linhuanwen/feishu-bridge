import type { ProgramEntry } from "./commandConfig.js";

export type ProgramResult = { success: boolean; message: string };

export type ProgramManagerDeps = {
  /** 执行系统命令（mock 边界） */
  exec?: (command: string) => Promise<{ stdout: string; stderr: string }>;
  /** 程序名 → 可执行文件/进程名映射 */
  programMap: Record<string, ProgramEntry>;
};

/** 在 programMap 中查找程序名，支持精确匹配 */
function resolveProgram(
  name: string,
  programMap: Record<string, ProgramEntry>,
): ProgramEntry | null {
  // 精确匹配
  if (programMap[name]) return programMap[name];
  // 大小写不敏感匹配
  const lower = name.toLowerCase();
  for (const [key, entry] of Object.entries(programMap)) {
    if (key.toLowerCase() === lower) return entry;
  }
  return null;
}

/**
 * 打开指定程序。
 * 1. 在 programMap 配置中查找程序名
 * 2. 通过 `cmd /c start` 启动
 */
export async function openProgram(
  name: string,
  deps: ProgramManagerDeps,
): Promise<ProgramResult> {
  const exec = deps.exec ?? defaultExec;
  const entry = resolveProgram(name, deps.programMap);

  if (!entry) {
    return {
      success: false,
      message: `找不到程序「${name}」，请确认程序名已配置在 programMap 中。`,
    };
  }

  try {
    // 使用 cmd /c start 启动（不等待进程结束）
    await exec(`cmd /c start "" "${entry.executable}"`);
    return { success: true, message: `✅ ${name} 已启动` };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `启动失败：${errMsg}` };
  }
}

/**
 * 关闭指定程序。
 * 1. 在 programMap 配置中查找进程名
 * 2. 通过 `taskkill /IM` 关闭（不带 /F，允许程序正常退出）
 */
export async function closeProgram(
  name: string,
  deps: ProgramManagerDeps,
): Promise<ProgramResult> {
  const exec = deps.exec ?? defaultExec;
  const entry = resolveProgram(name, deps.programMap);

  if (!entry) {
    return {
      success: false,
      message: `找不到程序「${name}」，请确认程序名已配置在 programMap 中。`,
    };
  }

  try {
    await exec(`taskkill /IM "${entry.processName}"`);
    return { success: true, message: `✅ ${name} 已关闭` };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // taskkill 常见错误：进程未运行
    if (errMsg.includes("没有找到") || errMsg.includes("not found") || errMsg.includes("不存在")) {
      return { success: false, message: `${name} 当前未运行。` };
    }
    return { success: false, message: `关闭失败：${errMsg}` };
  }
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
