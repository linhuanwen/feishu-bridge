import { resolve } from "path";

export type ScriptRunResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string };

export type RunScriptDeps = {
  /** 执行脚本文件（mock 边界，使用 execFile 而非 exec 防止 shell 注入） */
  execFile?: (
    file: string,
    args: string[],
    options: { timeout: number },
    callback: (
      error: Error | null,
      stdout: string,
      stderr: string,
    ) => void,
  ) => void;
  /** 白名单路径列表（精确匹配，标准化后比较） */
  whitelist: string[];
  /** 执行超时（毫秒），默认 30 秒 */
  timeoutMs?: number;
};

/**
 * 在沙箱中执行白名单内的脚本。
 *
 * 安全措施：
 * 1. 路径标准化（resolve）防止路径穿越
 * 2. 标准化后精确匹配白名单（大小写不敏感）
 * 3. 使用 execFile 而非 exec，避免 shell 注入
 * 4. 可配置超时
 */
export async function runScript(
  scriptPath: string,
  deps: RunScriptDeps,
): Promise<ScriptRunResult> {
  const execFile = deps.execFile ?? defaultExecFile;
  const timeoutMs = deps.timeoutMs ?? 30_000;

  // 1. 标准化路径
  const normalized = normalizePath(scriptPath);

  // 2. 白名单检查（标准化后大小写不敏感精确匹配）
  const allowed = deps.whitelist.some(
    (w) => normalizePath(w).toLowerCase() === normalized.toLowerCase(),
  );

  if (!allowed) {
    return {
      ok: false,
      error: `⛔ 脚本不在白名单中，已被拒绝：${scriptPath}`,
    };
  }

  // 3. 执行脚本
  return new Promise<ScriptRunResult>((resolve) => {
    execFile(
      normalized,
      [],
      { timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          if ((error as any).killed) {
            resolve({
              ok: false,
              error: `⏰ 脚本执行超时（${timeoutMs / 1000} 秒）：${scriptPath}`,
            });
          } else {
            resolve({
              ok: false,
              error: stderr || error.message || `脚本执行失败：${scriptPath}`,
            });
          }
        } else {
          resolve({ ok: true, stdout: stdout.trim(), stderr: stderr.trim() });
        }
      },
    );
  });
}

/** 路径标准化（跨平台） */
function normalizePath(p: string): string {
  try {
    return resolve(p);
  } catch {
    // resolve 失败时回退到原始路径
    return p;
  }
}

/** 默认的 execFile 实现 */
async function defaultExecFile(
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (
    error: Error | null,
    stdout: string,
    stderr: string,
  ) => void,
): Promise<void> {
  const { execFile } = await import("child_process");
  execFile(file, args, { timeout: options.timeout }, callback);
}
