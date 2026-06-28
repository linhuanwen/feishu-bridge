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
  /** JSONL 行数（反映对话长度） */
  messageCount: number;
  /** 来源：bridge 或 vscode */
  source: "bridge" | "vscode";
};

/**
 * 扫描 ~/.claude/projects/ 下所有会话。
 * 返回按 lastActivity 降序排列的会话列表。
 */
export function discoverClaudeSessions(): DiscoveredSession[] {
  const home = process.env.USERPROFILE ?? ".";
  const projectsDir = path.join(home, ".claude", "projects");

  if (!fs.existsSync(projectsDir)) return [];

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

    // 遍历目录中的 JSONL 会话文件
    for (const fileName of fs.readdirSync(fullDir)) {
      if (!fileName.endsWith(".jsonl")) continue;
      const sessionId = fileName.replace(/\.jsonl$/, "");
      const filePath = path.join(fullDir, fileName);

      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim());

        let firstMessage = "";
        let title = "";
        let lastActivity = stat.mtime;

        // 解析首行获取初始消息
        if (lines.length > 0) {
          try {
            const first = JSON.parse(lines[0]);
            if (typeof first.content === "string") firstMessage = first.content;
            if (first.timestamp) lastActivity = new Date(first.timestamp);
          } catch {
            /* 行解析失败，忽略 */
          }
        }

        // 扫描 AI 标题
        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "ai-title" && typeof parsed.aiTitle === "string") {
              title = parsed.aiTitle;
              break;
            }
          } catch {
            /* 跳过 */
          }
        }

        // 末行时间戳
        if (lines.length > 0) {
          try {
            const last = JSON.parse(lines[lines.length - 1]);
            if (last.timestamp) {
              const t = new Date(last.timestamp);
              if (!isNaN(t.getTime())) lastActivity = t;
            }
          } catch {
            /* 跳过 */
          }
        }

        // 判断来源：检查首条消息是否来自 Feishu Bridge
        const source: "bridge" | "vscode" =
          firstMessage.includes("（来自飞书）") ? "bridge" : "vscode";

        sessions.push({
          sessionId,
          projectDir: projectDir ?? dirName,
          projectDirName: dirName,
          title: title || firstMessage || "(无标题)",
          firstMessage,
          lastActivity,
          messageCount: lines.length,
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
 * 尝试将 .claude/projects/ 目录名解码为 Windows 路径。
 *
 * 编码规则（Claude Code 内部约定）：
 * - 盘符后的 `:` → `-`
 * - 路径分隔符 `\` → `-`
 * - 即 `D:\tool\yuancheng` → `d--tool-yuancheng`
 *
 * 解码时从第 4 个字符开始将 `-` 还原为 `\`（前两个 `-` 是 `:\`）。
 * 返回解码后的路径，或 null（无法解码时）。
 */
function tryDecodeProjectDir(dirName: string): string | null {
  // 格式：<drive>--<rest>
  const match = dirName.match(/^([a-zA-Z])--(.+)$/);
  if (!match) return null;

  const drive = match[1];
  const rest = match[2];

  // 简单策略：所有 `-` → `\`
  const candidate = `${drive}:\\${rest.replace(/-/g, "\\")}`;

  // 验证路径存在
  if (fs.existsSync(candidate)) return candidate;

  // 路径不存在时，尝试逐段匹配（处理文件夹名含 `-` 的情况）
  // 这比较难完美还原，返回候选路径让调用方自行判断
  return candidate;
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

/** 编码项目路径为 .claude/projects/ 目录名 */
function encodeProjectDir(projectDir: string): string | null {
  // D:\tool\yuancheng → d--tool-yuancheng
  const normalized = projectDir.replace(/:/g, "-").replace(/\\/g, "-");
  // 确保以盘符开头
  if (!/^[a-zA-Z]--/.test(normalized)) return null;
  return normalized;
}
