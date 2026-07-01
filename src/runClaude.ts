import { spawn as spawnPty } from "node-pty";
import { spawn } from "child_process";

/** claude 子进程执行选项 */
export type ClaudeRunOptions = {
  /** 项目工作目录 */
  projectDir: string;
  /** Claude Code 会话 UUID（用于 --resume） */
  sessionId?: string;
  /** 超时时间（毫秒），默认 900_000（15 分钟） */
  timeoutMs?: number;
  /** Claude CLI 路径 */
  claudePath: string;
  /**
   * 可选：进度心跳回调。
   * 在子进程运行期间每 30 秒触发一次，用于向用户发送「任务仍在进行中」的提醒。
   * 进程退出（正常/异常/超时）后不再触发。
   */
  onProgress?: (elapsedMs: number, pid: number) => void;
};

/**
 * 使用 -p 模式运行 Claude Code（不支持 / 命令，但速度快、输出干净）。
 * 适用于普通任务消息。
 *
 * 使用 spawn（而非 execFile）以获得：
 * 1. stdio 控制 — 显式忽略 stdin，避免 Claude Code 输出 "no stdin data" 警告
 * 2. 可靠的 Windows 超时 — execFile 发 SIGTERM 对 Windows 原生进程无效
 */
export function runClaudePrint(
  prompt: string,
  opts: ClaudeRunOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt];
    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    }

    const child = spawn(opts.claudePath, args, {
      cwd: opts.projectDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    // ── 进度心跳：每 30 秒触发一次，进程退出后自动停止 ──
    const HEARTBEAT_MS = 30_000;
    const startTime = Date.now();
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (opts.onProgress && child.pid) {
      heartbeatTimer = setInterval(() => {
        if (opts.onProgress) {
          opts.onProgress(Date.now() - startTime, child.pid!);
        }
      }, HEARTBEAT_MS);
    }

    const timeoutMs = opts.timeoutMs ?? 900_000;
    const timer = setTimeout(() => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      // Windows: SIGTERM 无效，用 taskkill 强制终止进程树
      if (process.platform === "win32") {
        const { exec } = require("child_process") as typeof import("child_process");
        exec(`taskkill /PID ${child.pid} /T /F`, () => {});
      } else {
        child.kill("SIGTERM");
      }
      reject(new Error(`Claude Code 执行超时 (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

      // stderr 上的非致命警告（Claude Code 启动阶段信息输出）
      const stderrClean = stderr.replace(/\x1b\[[0-9;]*m/g, "");
      const isStderrOnlyWarning =
        !stderrClean ||
        stderrClean.includes("no stdin data") ||
        stderrClean.split("\n").every((l) => l.startsWith("Warning:") || l.startsWith("[") || !l.trim());

      if (code === 0 || (stdout && isStderrOnlyWarning)) {
        resolve(stdout || stderr || "命令已执行。");
      } else {
        reject(new Error(stderr || stdout || `进程退出码: ${code}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      reject(err);
    });
  });
}

// ── 就绪检测辅助 ──

/**
 * 检查 PTY 输出中是否出现了 Claude Code 的就绪提示符。
 * Claude Code 就绪时会显示 `> ` 或 `⏺` 提示符。
 */
function hasReadyPrompt(output: string): boolean {
  // 最后一行以 > 或 ⏺ 开头
  if (/>\s*$/m.test(output)) return true;
  if (/⏺\s*$/m.test(output)) return true;
  // 独立的 > 行（常见于 TUI 消失后的纯文本模式）
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (trimmed === ">" || trimmed === "⏺") return true;
    if (/^[>⏺]\s/.test(trimmed)) return true;
    break; // 只检查最后一段非空行
  }
  return false;
}

/**
 * 使用伪终端（node-pty）运行 Claude Code 交互模式。
 *
 * 为什么用 node-pty：
 * 1. Claude Code 的 PermissionRequest hook 只在交互式 TTY 中触发
 * 2. -p 模式（runClaudePrint）不触发 hook，权限请求无法推到飞书
 *
 * 关键配置：
 * - useConpty: false — 用老式 winpty，避免 ConPTY 撕裂 ANSI 序列
 * - NO_COLOR=1 — 告知 Claude Code 不输出 ANSI 颜色码
 * - TERM=dumb — 告知程序不要使用高级终端特性
 *
 * 智能输入时序：
 * 1. 积累 Claude Code 启动输出
 * 2. 检测到欢迎界面（新会话）→ 发送 Enter 选择默认主题
 * 3. 检测到就绪提示符 → 立即发送用户输入
 * 4. 超时回退：最多等 MAX_INIT_WAIT_MS（15 秒）
 */
export function runClaudeInteractive(
  input: string,
  opts: ClaudeRunOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args: string[] = [];
    if (opts.sessionId) {
      args.push("--resume", opts.sessionId);
    }

    let ptyProc: ReturnType<typeof spawnPty>;
    try {
      ptyProc = spawnPty(opts.claudePath, args, {
        cwd: opts.projectDir,
        cols: 120,
        rows: 40,
        useConpty: false, // 用老式 winpty，避免 ANSI 撕裂
        env: {
          ...(process.env as Record<string, string>),
          NO_COLOR: "1",
          TERM: "dumb",
        },
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const outputChunks: string[] = [];
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const IDLE_TIMEOUT_MS = 20_000;
    let killedByUs = false;

    // ── 输入时序 ──
    // --resume：固定 5 秒延迟（确保会话加载完成），期间检测欢迎界面做快速失败
    // 新会话：检测欢迎界面 → Enter 跳过 → 检测提示符 → 发输入
    let userInputSent = false;
    let enterSent = false;
    const INIT_DELAY_MS = opts.sessionId ? 5000 : 1500;
    const MAX_INIT_WAIT_MS = 15_000;
    let initTimer: ReturnType<typeof setTimeout> | null = null;

    function sendUserInput(): void {
      if (userInputSent) return;
      userInputSent = true;
      if (initTimer) clearTimeout(initTimer);
      console.log(`[PTY] sendUserInput: 发送用户输入 (outputChunks 当前长度=${outputChunks.join("").length})`);
      ptyProc.write(input + "\n");
      resetIdleTimer();
    }

    if (opts.sessionId) {
      // ── --resume 路径：固定延迟，简单可靠 ──
      // 不在 onData 中做 isFreshStart 检查——PTY 启动阶段 TUI 初始化输出
      // 可能偶然命中模式（如 "Press Enter to confirm"），造成误杀。
      // 改为在 5 秒定时器触发时积累足够数据后再做一次检查。
      ptyProc.onData((data: string) => {
        if (!userInputSent) {
          outputChunks.push(data);
        } else {
          outputChunks.push(data);
          resetIdleTimer();
        }
      });

      setTimeout(() => {
        if (!userInputSent) {
          const accumulated = outputChunks.join("");
          if (isFreshStart(accumulated)) {
            // 5 秒后仍检测到欢迎界面 → 会话真的无效
            console.log(
              `[PTY] --resume 检测到欢迎界面（${accumulated.length} 字节），会话可能无效`,
            );
            killedByUs = true;
            try { ptyProc.kill(); } catch { /* 忽略 */ }
            return;
          }
          sendUserInput();
        }
      }, INIT_DELAY_MS);
    } else {
      // ── 新会话路径：欢迎界面 → Enter 跳过 → 固定延迟发输入 ──
      // 不依赖 hasReadyPrompt（提示符格式多变，容易误判/漏判），
      // 仿照 --resume 路径用固定延迟，简单可靠。
      console.log("[PTY] 新会话路径，等待 Claude Code 初始化...");
      const ENTER_DELAY_MS = 4000; // Enter 后等 4 秒再发用户输入

      ptyProc.onData((data: string) => {
        if (!userInputSent) {
          outputChunks.push(data);
          console.log(`[PTY] onData(init): +${data.length}字节, 总计=${outputChunks.join("").length}字节, enterSent=${enterSent}`);

          // 检测欢迎界面 → 发 Enter 选择默认主题
          if (!enterSent && isFreshStart(outputChunks.join(""))) {
            enterSent = true;
            console.log("[PTY] 检测到欢迎界面，发送 Enter 选择默认主题");
            ptyProc.write("\n");
            outputChunks.length = 0; // 清空欢迎界面，避免混入最终输出

            // Enter 后等固定时间发用户输入（不依赖提示符检测）
            if (initTimer) clearTimeout(initTimer);
            initTimer = setTimeout(() => {
              if (!userInputSent) {
                console.log("[PTY] Enter 后 %ds 延迟到期，发送用户输入", ENTER_DELAY_MS / 1000);
                sendUserInput();
              }
            }, ENTER_DELAY_MS);
          }
        } else {
          outputChunks.push(data);
          resetIdleTimer();
        }
      });

      // 超时回退：如果欢迎界面一直没出现，也强制发输入
      initTimer = setTimeout(() => {
        if (!userInputSent) {
          console.log("[PTY] initTimer 触发，强制发送用户输入");
          sendUserInput();
        }
      }, MAX_INIT_WAIT_MS);
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Claude Code 交互模式超时"));
    }, opts.timeoutMs ?? 300_000);

    ptyProc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);

      const output = outputChunks.join("").trim();
      console.log(`[PTY] onExit: exitCode=${exitCode}, outputLen=${output.length}, killedByUs=${killedByUs}, userInputSent=${userInputSent}`);

      // --resume 失败（session 过期/不存在），Claude 显示 Welcome 界面。
      // 抛出包含 "resume" 的错误，callClaudeWithSession 会捕获并回退到 -p 模式重建会话。
      if (opts.sessionId && isFreshStart(output)) {
        reject(new Error(
          `Session resume failed: 无法恢复会话 ${opts.sessionId.slice(0, 8)}...` +
          `（会话可能已过期或不存在，将自动创建新会话）`,
        ));
        return;
      }

      if (killedByUs || exitCode === 0 || output) {
        const cleaned = extractResponse(output);
        resolve(cleaned || "命令已执行。");
      } else {
        reject(new Error(output || `进程退出码: ${exitCode}`));
      }
    });

    function resetIdleTimer(): void {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killedByUs = true;
        try { ptyProc.kill(); } catch { /* 忽略 */ }
      }, IDLE_TIMEOUT_MS);
    }

    function cleanup(): void {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      try { ptyProc.kill(); } catch { /* 忽略 */ }
    }
  });
}

/**
 * 检测 Claude Code 输出是否显示「首次启动」界面。
 */
function isFreshStart(raw: string): boolean {
  const stripped = raw.replace(/\x1b\[[?>!$"'()*+ ]?[0-9;]*[a-zA-Z]/g, "");
  const clean = stripped.replace(/\x1b\].*?(\x07|\x1b\\)/g, "");

  const freshPatterns = [
    /Welcome\s*(to\s*)?Claude\s*Code\s*v/i,
    /Let['']s\s*get\s*started/i,
    /Choose\s*the\s*text\s*style/i,
    /Auto\s*\(\s*match\s*terminal\s*\)/i,
    /Dark\s*mode\s*\(/i,
    /Light\s*mode\s*\(/i,
    // 新版 Claude Code 主题选择界面（无传统 Welcome 文字）
    /To change this later, run \/theme/i,
    /Select (a|your) (theme|style|text style)/i,
    /Use (arrow keys|↑|↓|↑|↓).*select/i,
    /Press Enter to confirm/i,
  ];

  const matched = freshPatterns.filter((p) => p.test(clean));
  // 新版界面可能命中 1-2 个模式（主题选择器 + 提示文字）
  // "To change this later, run /theme" 仅出现在首启界面
  // 阈值 >= 2：PTY 启动阶段 TUI 初始化输出可能偶然命中单个模式（如 "Press Enter to confirm"），
  // 需要至少 2 个模式同时命中才认为是真正的欢迎界面。
  if (matched.length >= 2) {
    console.log(
      `[isFreshStart] ✅ 检测到欢迎界面（命中 ${matched.length} 个模式）: ` +
      matched.map((r) => r.source.slice(0, 60)).join(" | "),
    );
    return true;
  }
  if (matched.length === 1) {
    console.log(
      `[isFreshStart] ⚠️ 仅命中 1 个模式（忽略，疑似 PTY 初始化误判）: ` +
      `${matched[0].source.slice(0, 80)}`,
    );
  }
  return false;
}

/**
 * 从 Claude Code 交互输出中提取实际响应内容。
 * 清理 ANSI 序列、TUI 装饰字符、提示符等。
 */
function extractResponse(raw: string): string {
  let text = raw;

  // ── 1. ANSI/CSI 序列 ──

  // CSI 序列：ESC [ ... 终结符
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b\[[?>!$"'()*+ ]?[0-9;]*[a-zA-Z]/g, "");
  // OSC 序列：ESC ] ... (BEL 或 ST)
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b\].*?(\x07|\x1b\\)/g, "");
  // 单字符 ESC 序列
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b[NOPQRSWXYZ=>[\]^_\\`bcdhikmnpqrstuvwxyz{|}~]/g, "");

  // 孤儿 CSI 片段（DEC 私有模式等，[?>] 前缀必须存在）
  // eslint-disable-next-line no-control-regex
  text = text.replace(/(?:^|\s|(?<!\w))\[[?>][0-9;]*[a-zA-Z]/gm, "");
  // 孤儿 SGR 片段：孤立的 [...m（ESC 丢失后残留的颜色码）
  // eslint-disable-next-line no-control-regex
  text = text.replace(/(?:^|\s|(?<!\w))\[[0-9;]*m/gm, "");

  // 控制字符（保留 \t \n \r）
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

  // ── 2. 框线字符和块元素 ──
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟]/g, "");

  // ── 3. TUI 提示符和状态指示 ──

  // 独立的提示符行
  text = text.replace(/^[>⏺●]\s*$/gm, "");

  // TUI 状态指示
  text = text.replace(/⏺\s*思考中[.\s]*/g, "");
  text = text.replace(/⏺\s*处理中[.\s]*/g, "");
  text = text.replace(/⏺\s*正在[^\n]*/g, "");

  // ── 4. Welcome / 主题选择界面残留 ──

  // 传统 Welcome
  text = text.replace(/Welcome\s*to\s*Claude\s*Code\s*v[\d.]+\s*/gi, "");
  text = text.replace(/Let['']s\s*get\s*started[.\s]*/gi, "");
  text = text.replace(/Choose\s*the\s*text\s*style[^\n]*/gi, "");
  text = text.replace(/Auto\s*\(\s*match\s*terminal\s*\)/gi, "");
  text = text.replace(/Dark\s*mode\s*(?:\([^)]*\))?\s*/gi, "");
  text = text.replace(/Light\s*mode\s*(?:\([^)]*\))?\s*/gi, "");
  text = text.replace(/Syntax\s*theme:\s*[^\n]*/gi, "");

  // 新版 Claude Code 主题选择界面
  text = text.replace(/To change this later, run \/theme[^\n]*/gi, "");
  text = text.replace(/Select (a|your) (theme|style|text style)[^\n]*/gi, "");
  text = text.replace(/Use (arrow keys|↑|↓|↑|↓).*select[^\n]*/gi, "");
  text = text.replace(/Press Enter to confirm[^\n]*/gi, "");

  // 主题选择器 TUI 行：
  // - 带勾选标记的编号行（如 "> 1.  √"）
  // - 带光标 > 的选项行（如 "> 1. Dark mode"）
  text = text.replace(/^[>\s]*[\d]+\s*[✓√✔].*$/gm, "");
  // 主题选项关键词匹配：只移除明确包含主题相关词汇的行，且必须有编号前缀
  text = text.replace(/^[>\s]*\d+[\.\s]+.*(Dark mode|Light mode|Colorblind|match terminal|text style|syntax theme).*$/gim, "");
  // 空编号列表残留（如单独一行的 "  2.  3.  4. ..."）
  text = text.replace(/^(?:\s*\d+\s*\.?\s*)+(?:\d+\s*\.?\s*)$/gm, "");

  // ── 5. 项目符号（先移除含项目符号的整行，再移除残留字符）──
  // 重要：必须先做行级清理（此时项目符号还在），再做字符级清理
  // eslint-disable-next-line no-control-regex
  text = text.replace(/^\s*[•◦▪▸▹◾▫◽⬤⚬⚫●]\s*$/gm, "");
  // 行首带项目符号的前导空白行
  // eslint-disable-next-line no-control-regex
  text = text.replace(/^[•◦▪▸▹●]\s*/gm, "");
  // 残留的项目符号字符
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[•◦▪▸▹◾▫◽⬤⚬⚫●]/g, "");

  // ── 6. TUI 间距填充 ──
  // 连续点号（TUI 菜单间距填充，如 "......."）
  text = text.replace(/\.{10,}/g, "");

  // ── 7. 最终清理 ──
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.trim();

  // 诊断：清理后为空时记录（包括 raw 全空白的情况）
  if (!text) {
    console.log(
      `[extractResponse] ⚠️ 清理后为空！原始长度=${raw.length}, rawIsEmpty=${!raw.trim()}, ` +
      `原始前200字符=${JSON.stringify(raw.slice(0, 200))}`,
    );
  }

  return text;
}
