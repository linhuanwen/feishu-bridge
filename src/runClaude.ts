import { spawn as spawnPty } from "node-pty";
import { execFile } from "child_process";

/** claude 子进程执行选项 */
export type ClaudeRunOptions = {
  /** 项目工作目录 */
  projectDir: string;
  /** Claude Code 会话 UUID（用于 --resume） */
  sessionId?: string;
  /** 超时时间（毫秒），默认 300_000（5 分钟） */
  timeoutMs?: number;
  /** Claude CLI 路径 */
  claudePath: string;
};

/**
 * 使用 -p 模式运行 Claude Code（不支持 / 命令，但速度快、输出干净）。
 * 适用于普通任务消息。
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

    execFile(
      opts.claudePath,
      args,
      {
        cwd: opts.projectDir,
        timeout: opts.timeoutMs ?? 300_000,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message;
          reject(new Error(detail));
          return;
        }
        const output = stdout.trim() || stderr?.trim() || "";
        resolve(output);
      },
    );
  });
}

/**
 * 使用伪终端（node-pty）运行 Claude Code 交互模式。
 * 支持 / 命令（/compact、/clear 等）。
 *
 * 为什么用 node-pty：
 * Claude Code 的斜杠命令（/compact、/clear 等）只在交互式 TTY 中生效。
 * 普通 pipe stdin 不被识别为交互终端，命令会被忽略。
 * node-pty 创建伪终端，Claude Code 认为自己在真实终端中运行，正确处理 / 命令。
 *
 * 关键时序：
 * 1. pty.spawn claude --resume <uuid>
 * 2. 立即写入命令（伪终端缓冲，初始化完成后处理）
 * 3. 等待响应完成（输出停止 20 秒）
 * 4. kill PTY 进程，提取响应
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
        useConpty: true, // Windows 10+ ConPTY
        env: { ...process.env } as Record<string, string>,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const outputChunks: string[] = [];
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const IDLE_TIMEOUT_MS = 20_000; // 20 秒无输出 = 响应完成
    let killedByUs = false;

    // 立即写入命令 — PTY 会缓冲并在 Claude Code 初始化完成后处理
    ptyProc.write(input + "\n");
    resetIdleTimer();

    // PTY 合并了 stdout/stderr，统一通过 onData 回调
    ptyProc.onData((data: string) => {
      outputChunks.push(data);
      resetIdleTimer();
    });

    // 总超时处理
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Claude Code 交互模式超时"));
    }, opts.timeoutMs ?? 300_000);

    ptyProc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);

      const output = outputChunks.join("").trim();

      // 检测 session 恢复失败：Claude Code 启动了全新实例
      // （显示 Welcome / 主题选择界面 = --resume 没找到或无法访问会话文件）
      if (opts.sessionId && isFreshStart(output)) {
        reject(
          new Error(
            `无法恢复会话 ${opts.sessionId.slice(0, 8)}...。` +
              "可能原因：\n" +
              "1. 该会话正在被另一个 Claude Code 进程使用（如 VSCode）\n" +
              "2. 会话文件已被删除或损坏\n" +
              "3. 会话不属于当前项目\n\n" +
              "💡 可以尝试「新对话」创建新会话，或用「列出对话」查看可用会话。",
          ),
        );
        return;
      }

      // killedByUs: 空闲超时后主动 kill，属于正常结束
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
        // 输出停止 → 认为命令已执行完毕，主动结束进程
        killedByUs = true;
        try {
          ptyProc.kill();
        } catch {
          /* 忽略 */
        }
      }, IDLE_TIMEOUT_MS);
    }

    function cleanup(): void {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      try {
        ptyProc.kill();
      } catch {
        /* 忽略 */
      }
    }
  });
}

/**
 * 检测 Claude Code 输出是否显示「首次启动」界面。
 *
 * 触发条件：
 * - --resume 指定的会话文件不存在 / 被锁定 / 无法访问
 * - Claude Code 回退到创建全新会话，显示欢迎界面和主题选择
 *
 * 检测特征：
 * - "Welcome to Claude Code" 文本
 * - 主题选择菜单（"Auto (match terminal)"、"Dark mode"等）
 * - 版本号横幅
 */
function isFreshStart(raw: string): boolean {
  // 去除 ANSI 序列后检测
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/\x1b\[[?>!$"'()*+ ]?[0-9;]*[a-zA-Z]/g, "");
  // eslint-disable-next-line no-control-regex
  const clean = stripped.replace(/\x1b\].*?(\x07|\x1b\\)/g, "");

  // Welcome 界面关键词
  const freshPatterns = [
    /Welcome\s*(to\s*)?Claude\s*Code\s*v/i,
    /Let['']s\s*get\s*started/i,
    /Choose\s*the\s*text\s*style/i,
    /Auto\s*\(\s*match\s*terminal\s*\)/i,
    /Dark\s*mode\s*\(/i,
    /Light\s*mode\s*\(/i,
  ];

  const matchCount = freshPatterns.filter((p) => p.test(clean)).length;
  // 至少命中 2 个特征才判定为 fresh start（减少误判）
  return matchCount >= 2;
}

/**
 * 从 Claude Code 交互输出中提取实际响应内容。
 * 过滤掉 TUI 框架、提示符、思考指示器等。
 *
 * 处理顺序很关键：
 * 1. 先匹配完整的 ANSI 序列（ESC + 参数 + 终结符）
 * 2. 再去除孤儿 CSI 片段（ESC 已被上一步部分消费或跨 chunk 丢失的残留）
 * 3. 最后清理 TUI 字符和提示符
 */
function extractResponse(raw: string): string {
  let text = raw;

  // ── 第一轮：完整的 ANSI 转义序列 ──

  // CSI 序列：ESC [ ... 终结符
  // 支持：
  //   - 标准 CSI：ESC [ 数字;数字 m/h/l
  //   - DEC 私有模式：ESC [ ? 数字;数字 h/l/r/s
  //   - 其他前缀：> ! $ " ' ( ) * +
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b\[[?>!$"'()*+ ]?[0-9;]*[a-zA-Z]/g, "");

  // 其他 ESC 序列（非 CSI 的 Fe 序列、Fs 序列等）
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b[NOPQRSWXYZ=>[\]^_\\`bcdhikmnpqrstuvwxyz{|}~]/g, "");

  // OSC 序列：ESC ] ... BEL 或 ESC ] ... ESC \
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b\].*?(\x07|\x1b\\)/g, "");

  // DCS、SOS、PM、APC 等
  // eslint-disable-next-line no-control-regex
  text = text.replace(/\x1b[PX^_].*?(\x1b\\|\x07)/g, "");

  // ── 第二轮：孤儿 CSI 片段（ESC 已丢失，残留的 [? / [> 等参数部分）──
  // 这些是跨 chunk 传输或 ConPTY 转换时 ESC 被分离后剩下的
  // 匹配行首或字间隙处的 [ ?/> 开头 + 数字分号 + 终结字母
  // eslint-disable-next-line no-control-regex
  text = text.replace(/(?:^|\s|(?<!\w))\[[?>][0-9;]*[a-zA-Z]/gm, "");

  // 孤儿 SGR 片段：孤立的 [...m 模式
  // eslint-disable-next-line no-control-regex
  text = text.replace(/(?:^|\s|(?<!\w))\[[0-9;]*m/gm, "");

  // ── 第三轮：剩余控制字符（保留 \t \n \r）──
  // 注意：ESC 本身是 \x1b，在第一轮没匹配到的就属于孤儿，此处清除
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");

  // ── 第四轮：TUI 装饰字符 ──

  // 框线字符（U+2500–U+257F）
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[─━│┃┄┅┆┇┈┉┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋╌╍╎╏═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿]/g, "");

  // 块元素和着色字符（U+2580–U+259F：▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟）
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕▖▗▘▙▚▛▜▝▞▟]/g, "");

  // ── 第五轮：提示符行和 TUI 状态指示 ──

  // 去除只有提示符的行
  text = text.replace(/^[>⏺●]\s*$/gm, "");
  text = text.replace(/\n[>⏺●]\s*$/gm, "");

  // 去除 TUI 标签和状态指示
  text = text.replace(/⏺\s*思考中[.\s]*/g, "");
  text = text.replace(/⏺\s*处理中[.\s]*/g, "");
  text = text.replace(/⏺\s*正在[^\n]*/g, "");

  // ── 第六轮：Claude Code TUI 框架文本 ──

  // Welcome / 主题选择界面残留文本
  text = text.replace(/Welcome\s*to\s*Claude\s*Code\s*v[\d.]+\s*/gi, "");
  text = text.replace(/Let['']s\s*get\s*started[.\s]*/gi, "");
  text = text.replace(/Choose\s*the\s*text\s*style[^\n]*/gi, "");
  text = text.replace(/Auto\s*\(\s*match\s*terminal\s*\)/gi, "");
  text = text.replace(/Dark\s*mode\s*(?:\([^)]*\))?\s*/gi, "");
  text = text.replace(/Light\s*mode\s*(?:\([^)]*\))?\s*/gi, "");
  text = text.replace(/Syntax\s*theme:\s*[^\n]*/gi, "");

  // 过多的连续点号（ASCII art 残留）
  text = text.replace(/\.{10,}/g, "");

  // 去除可能残留的编号选项（1. 2. 3. ... 7. 后跟选项文本的）
  text = text.replace(/[1-7]\.[A-Z][a-z]+(?:\([^)]*\))?\s*/g, "");

  // 去除末尾命令行提示和空白
  text = text.replace(/\n\s*[>⏺●]\s*$/, "");

  // ── 最终清理 ──

  // 去除多余空白行（3 个以上连续换行 → 2 个）
  text = text.replace(/\n{3,}/g, "\n\n");

  // 去除行首行尾空白
  text = text.trim();

  return text;
}
