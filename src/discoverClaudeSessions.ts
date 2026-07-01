import * as fs from "fs";
import * as path from "path";

/** 从磁盘发现的 Claude Code 会话信息 */
export type DiscoveredSession = {
  /** Claude Code 原生 UUID */
  sessionId: string;
  /** 项目目录（解码后的绝对路径，可能不存在） */
  projectDir: string;
  /** .claude/projects/ 下的原始目录名 */
  projectDirName: string;
  /** AI 生成的标题或首条消息摘要 */
  title: string;
  /** 首条用户消息 */
  firstMessage: string;
  /** 最后活动时间 */
  lastActivity: Date;
  /** JSONL 行数（估算值，大文件用文件大小推算） */
  messageCount: number;
  /** 来源：bridge 或 vscode */
  source: "bridge" | "vscode";
};

// ── 低层文件读取工具（同步，仅读取必要字节） ──

/** 读取文件的前 maxBytes 个字节并以 UTF-8 返回 */
function readHeadSync(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(maxBytes, fileSize));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

/** 读取文件的末尾 maxBytes 个字节并以 UTF-8 返回 */
function readTailSync(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize === 0) return "";
    const readSize = Math.min(maxBytes, fileSize);
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, fileSize - readSize);
    return buf.toString("utf-8");
  } finally {
    fs.closeSync(fd);
  }
}

/** 从 JSONL 行中提取用户消息文本（兼容新旧 Claude Code 格式） */
function extractMessageText(parsed: Record<string, unknown>): string | null {
  // 旧格式：{ content: "text" }
  if (typeof parsed.content === "string" && parsed.content.trim()) {
    return parsed.content.trim();
  }
  // 新格式：{ message: { content: [{ type: "text", text: "..." }] } }
  if (parsed.message && typeof parsed.message === "object") {
    const msg = parsed.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part && typeof part === "object" && (part as any).type === "text") {
          const text = (part as any).text;
          if (typeof text === "string" && text.trim()) return text.trim();
        }
      }
    }
  }
  return null;
}

/** 提取文本中最后一行非空内容 */
function extractLastLine(text: string): string {
  const trimmed = text.replace(/\n+$/, "");
  const idx = trimmed.lastIndexOf("\n");
  return idx >= 0 ? trimmed.slice(idx + 1).trim() : trimmed.trim();
}

/**
 * 在文件中扫描 "ai-title" 条目，找到后立即停止。
 * 仅对 ≤ maxScanBytes 的文件执行全量扫描；超过则跳过。
 */
function findAiTitleSync(filePath: string, fileSize: number, maxScanBytes: number): string | null {
  if (fileSize === 0 || fileSize > maxScanBytes) return null;

  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(fileSize);
    fs.readSync(fd, buf, 0, fileSize, 0);
    const text = buf.toString("utf-8");

    // 快速扫描：只检查包含 "ai-title" 或 "aiTitle" 的行
    let pos = 0;
    while (pos < text.length) {
      const newlineIdx = text.indexOf("\n", pos);
      const line = newlineIdx >= 0 ? text.slice(pos, newlineIdx) : text.slice(pos);

      if (line.includes('"ai-title"') || line.includes('"aiTitle"')) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string") {
            return parsed.aiTitle;
          }
        } catch {
          /* 行解析失败，继续 */
        }
      }

      if (newlineIdx < 0) break;
      pos = newlineIdx + 1;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// ── 路径编解码 ──

/**
 * 尝试将 .claude/projects/ 目录名解码为 Windows 路径。
 *
 * 编码规则（Claude Code 内部约定）：
 * - 盘符后的 `:` → `-`
 * - 路径分隔符 `\` → `-`
 * - 即 `D:\tool\yuancheng` → `d--tool-yuancheng`
 */
function tryDecodeProjectDir(dirName: string): string | null {
  const match = dirName.match(/^([a-zA-Z])--(.+)$/);
  if (!match) return null;

  const drive = match[1];
  const rest = match[2];

  // 简单策略：所有 `-` → `\`
  const candidate = `${drive}:\\${rest.replace(/-/g, "\\")}`;

  if (fs.existsSync(candidate)) return candidate;
  return candidate;
}

/** 编码项目路径为 .claude/projects/ 目录名 */
function encodeProjectDir(projectDir: string): string | null {
  const normalized = projectDir.replace(/:/g, "-").replace(/\\/g, "-");
  if (!/^[a-zA-Z]--/.test(normalized)) return null;
  return normalized;
}

// ── 公开 API ──

/**
 * 扫描 ~/.claude/projects/ 下所有会话。
 * 返回按 lastActivity 降序排列的会话列表。
 *
 * ⚡ 性能优化：只读取每个 JSONL 文件的首尾片段，不再加载完整文件。
 * 对于 200+ 会话、数百 MB 的 JSONL 数据，扫描时间从数十秒降至 < 1 秒。
 */
export function discoverClaudeSessions(): DiscoveredSession[] {
  const home = process.env.USERPROFILE ?? ".";
  const projectsDir = path.join(home, ".claude", "projects");

  if (!fs.existsSync(projectsDir)) return [];

  const HEAD_READ_BYTES = 32768;       // 读取文件头 32KB，扫描第一条用户消息
  const TAIL_READ_BYTES = 4096;       // 读取文件尾 4KB 获取末行
  const MAX_AI_TITLE_SCAN = 2 * 1024 * 1024; // 超过 2MB 的文件跳过 ai-title 扫描
  const AVG_LINE_BYTES = 2000;        // 估算每行 JSONL 平均字节数（含完整消息内容）

  const sessions: DiscoveredSession[] = [];

  for (const dirName of fs.readdirSync(projectsDir)) {
    const fullDir = path.join(projectsDir, dirName);
    let dirStat: fs.Stats;
    try {
      dirStat = fs.statSync(fullDir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;

    const projectDir = tryDecodeProjectDir(dirName);

    for (const fileName of fs.readdirSync(fullDir)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const sessionId = fileName.replace(/\.jsonl$/, "");
      const filePath = path.join(fullDir, fileName);

      try {
        const stat = fs.statSync(filePath);
        if (stat.size === 0) continue;

        // ── 读取文件头，扫描第一条用户消息（而非首行）──
        // 新格式 Claude Code 以 queue-operation / attachment 等开头，
        // 真正的用户消息在 type: "user" 行中，嵌套在 message.content[0].text
        const headText = readHeadSync(filePath, HEAD_READ_BYTES);
        let firstMessage = "";
        let firstTimestamp: Date | null = null;
        let headAiTitle: string | null = null;

        // 逐行扫描文件头，提取首条用户消息、时间戳和可能的 AI 标题
        let lineStart = 0;
        while (lineStart < headText.length) {
          const newlineIdx = headText.indexOf("\n", lineStart);
          const line = newlineIdx >= 0
            ? headText.slice(lineStart, newlineIdx)
            : headText.slice(lineStart);

          try {
            const parsed = JSON.parse(line);
            const msgText = extractMessageText(parsed);

            // 记录首条有实际内容的行的时间戳
            if (!firstTimestamp && parsed.timestamp) {
              const t = new Date(parsed.timestamp as string);
              if (!isNaN(t.getTime())) firstTimestamp = t;
            }

            // 提取首条用户消息（type: "user" 且有 message 文本）
            if (!firstMessage && parsed.type === "user" && msgText) {
              firstMessage = msgText;
            }

            // 同时检查 ai-title（可能出现在文件头）
            if (!headAiTitle && parsed.type === "ai-title" && typeof parsed.aiTitle === "string") {
              headAiTitle = parsed.aiTitle;
            }
          } catch {
            /* 行解析失败，跳过 */
          }

          if (newlineIdx < 0) break;
          lineStart = newlineIdx + 1;
        }

        let lastActivity: Date = firstTimestamp ?? stat.mtime;

        // ── 读取文件尾（末行时间戳，覆盖文件头时间） ──
        if (stat.size > HEAD_READ_BYTES) {
          const tailText = readTailSync(filePath, TAIL_READ_BYTES);
          const lastLine = extractLastLine(tailText);
          if (lastLine) {
            try {
              const last = JSON.parse(lastLine);
              if (last.timestamp) {
                const t = new Date(last.timestamp);
                if (!isNaN(t.getTime())) {
                  lastActivity = t;
                }
              }
            } catch {
              /* 末行解析失败，使用已有值 */
            }
          }
        }

        // ── AI 标题 ──
        // 优先用文件头扫描到的；若未找到且文件 ≤ 2MB，则全文件扫描
        const aiTitle = headAiTitle
          ?? findAiTitleSync(filePath, stat.size, MAX_AI_TITLE_SCAN);
        const title = aiTitle || firstMessage || "(无标题)";

        // ── 消息数估算 ──
        const messageCount = Math.max(1, Math.round(stat.size / AVG_LINE_BYTES));

        // ── 来源判断 ──
        const source: "bridge" | "vscode" =
          firstMessage.includes("（来自飞书）") ? "bridge" : "vscode";

        sessions.push({
          sessionId,
          projectDir: projectDir ?? dirName,
          projectDirName: dirName,
          title,
          firstMessage,
          lastActivity,
          messageCount,
          source,
        });
      } catch {
        // 文件不可读，跳过
      }
    }
  }

  // 按最后活动时间降序
  sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  return sessions;
}

/**
 * 在指定项目目录中查找最新创建的会话 UUID。
 * 用于首次调用 Claude Code 后获取真实 UUID。
 */
export function findLatestSessionInProject(projectDir: string): string | null {
  const dirName = encodeProjectDir(projectDir);
  if (!dirName) return null;

  const home = process.env.USERPROFILE ?? ".";
  const projectsDir = path.join(home, ".claude", "projects", dirName);

  if (!fs.existsSync(projectsDir)) return null;

  let latest: { id: string; mtime: number } | null = null;

  for (const fileName of fs.readdirSync(projectsDir)) {
    if (!fileName.endsWith(".jsonl")) continue;
    const filePath = path.join(projectsDir, fileName);
    try {
      const stat = fs.statSync(filePath);
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { id: fileName.replace(/\.jsonl$/, ""), mtime: stat.mtimeMs };
      }
    } catch {
      /* skip */
    }
  }

  return latest?.id ?? null;
}

/**
 * 获取指定 session UUID 的会话摘要信息。
 */
export function getSessionInfo(
  sessionId: string,
): Omit<DiscoveredSession, "source"> | null {
  const sessions = discoverClaudeSessions();
  const found = sessions.find((s) => s.sessionId === sessionId);
  if (!found) return null;
  const { source, ...info } = found;
  return info;
}
