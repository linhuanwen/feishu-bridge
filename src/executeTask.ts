import type { SessionRegistry } from "./sessionRegistry.js";
import {
  discoverClaudeSessions,
  findLatestSessionInProject,
  type DiscoveredSession,
} from "./discoverClaudeSessions.js";

export type ExecuteTaskDeps = {
  /** 调用 Claude Code CLI（PTY 交互模式，支持 forcePrint 回退到 -p） */
  callClaude: (
    prompt: string,
    opts: {
      projectDir: string;
      sessionId?: string;
      timeoutMs: number;
      forcePrint?: boolean;
      /** 进度心跳回调（子进程存活时每 30s 触发一次） */
      onProgress?: (elapsedMs: number, pid: number) => void;
    },
  ) => Promise<string>;
  /** 调用 Claude Code CLI（PTY 交互模式，支持 PermissionRequest hook） */
  callClaudeInteractive?: (
    input: string,
    opts: { projectDir: string; sessionId?: string; timeoutMs: number },
  ) => Promise<string>;
  /** 生成新的 session ID */
  generateSessionId: () => string;
  /** 当前时间 */
  now: () => Date;
  /** 任务执行超时（毫秒），默认 300_000（5 分钟） */
  taskTimeoutMs?: number;
  /**
   * 可选：任务进度回调。子进程存活期间每 30s 触发一次，
   * 用于向飞书发送「任务仍在进行中」的进度提醒。
   * 进程退出（正常/异常/超时）后不再触发。
   */
  onTaskProgress?: (elapsedMs: number, pid: number) => void;
  /**
   * 可选：向飞书 chat 发送进度消息。
   * 在子进程存活期间每隔 30s 调用一次；进程退出后不再调用。
   */
  sendProgress?: (chatId: string, message: string) => Promise<void>;
  /** 默认项目目录（当消息中无法提取路径且无活跃会话时使用） */
  defaultProjectDir?: string;
  /**
   * 可选：确保目标项目的 .claude/settings.json 包含权限桥 hook 配置。
   */
  ensureClaudeSettings?: (projectDir: string) => Promise<void>;
  /**
   * 可选：扫描磁盘获取所有已知会话（用于「列出对话」）。
   * 不传时使用默认实现。
   */
  discoverSessions?: () => DiscoveredSession[];
};

export type TaskResult =
  | { ok: true; summary: string; sessionId: string }
  | { ok: false; error: string };

// ── 元命令检测 ──

/** 去除飞书消息中的 @mention 标记 */
function stripFeishuMentions(text: string): string {
  let cleaned = text.replace(/<at\b[^>]*>.*?<\/at>/gi, "");
  cleaned = cleaned.replace(/@_user_\w+/g, "");
  return cleaned.trim();
}

const SWITCH_PROJECT_RE = /^切换(?:项目|目录|到)\s+(.+)/i;

const CURRENT_PROJECT_RE =
  /^当前在(?:哪个|什么)项目|^当前(?:项目|目录)/i;

/** 「列出对话」/「对话列表」（可选项目筛选） */
const LIST_SESSIONS_RE =
  /^(?:(?:列出)?对话(?:列表|列别)?|有哪些对话)$/i;

/** 「列出对话 <项目关键词或路径>」 */
const LIST_SESSIONS_FILTER_RE =
  /^(?:列出|查看)?(.+?)(?:的|项目)?对话(?:列表|列别)?$/i;

/** 「进入对话 <id 或序号或关键词>」（空格可选） */
const ENTER_SESSION_RE = /^进入对话\s*(.+)/i;

/** 「新对话」/「新会话」 */
const NEW_SESSION_RE = /^新(对话|会话)/i;

/** 「当前对话」 — 查看当前活跃会话信息 */
const CURRENT_SESSION_RE = /^当前对话/i;

/** 「退出」/「退出会话」/「退出对话」 — 退出当前对话，回到无会话状态 */
const EXIT_SESSION_RE = /^退出(会话|对话)?$/i;

/** 以 / 开头的 Claude Code 内置命令 */
const SLASH_COMMAND_RE = /^\/(\w+)/;

// ── 项目目录提取 ──

/** Windows 绝对路径模式：盘符 + 冒号 + 反斜杠 + 路径 */
const WIN_PATH_RE = /([a-zA-Z]:\\[^\s]*)/g;

// ── 主入口 ──

/**
 * 执行 task 类型消息（含会话管理）。
 *
 * 处理以下情况：
 * 1. 元命令：「切换项目 <路径>」
 * 2. 元命令：「当前在哪个项目」
 * 3. 元命令：「列出对话」— 显示所有活跃会话
 * 4. 元命令：「进入对话 <id>」— 切换到指定会话
 * 5. 元命令：「新对话」— 在当前项目创建新会话
 * 6. 元命令：「当前对话」— 查看当前会话信息
 * 7. 元命令：「退出会话」— 退出当前对话，回到无会话状态
 * 8. / 命令 — 通过交互模式转发到 Claude Code
 * 9. 普通任务消息 — 创建/续接 Claude Code 会话
 */
export async function executeTask(
  userMessage: string,
  chatId: string,
  registry: SessionRegistry,
  deps: ExecuteTaskDeps,
): Promise<TaskResult> {
  // 预处理：去除 @mention 标记，避免 @_user_1 等干扰元命令匹配
  const cleaned = stripFeishuMentions(userMessage);

  // —— 元命令：切换项目 ——
  const switchMatch = cleaned.match(SWITCH_PROJECT_RE);
  if (switchMatch) {
    return handleSwitchProject(switchMatch[1].trim(), chatId, registry, deps);
  }

  // —— 元命令：当前项目 ——
  if (CURRENT_PROJECT_RE.test(cleaned.trim())) {
    return handleCurrentProject(chatId, registry);
  }

  // —— 元命令：列出对话（精确）——
  if (LIST_SESSIONS_RE.test(cleaned.trim())) {
    return handleListSessions(chatId, registry, deps);
  }

  // —— 元命令：列出对话（带项目筛选）——
  const listFilterMatch = cleaned.match(LIST_SESSIONS_FILTER_RE);
  if (listFilterMatch) {
    const filter = listFilterMatch[1].trim();
    // 排除被误识别为筛选词的命令关键词
    if (!["列出", "查看", "进入", "新", "当前"].includes(filter)) {
      return handleListSessions(chatId, registry, deps, filter);
    }
  }

  // —— 元命令：进入对话 ——
  const enterMatch = cleaned.match(ENTER_SESSION_RE);
  if (enterMatch) {
    return handleEnterSession(enterMatch[1].trim(), chatId, registry, deps);
  }

  // —— 元命令：新对话 ——
  if (NEW_SESSION_RE.test(cleaned.trim())) {
    return handleNewSession(chatId, registry, deps);
  }

  // —— 元命令：当前对话 ——
  if (CURRENT_SESSION_RE.test(cleaned.trim())) {
    return handleCurrentSession(chatId, registry, deps);
  }

  // —— 元命令：退出会话 ——
  if (EXIT_SESSION_RE.test(cleaned.trim())) {
    return handleExitSession(chatId, registry);
  }

  // —— / 命令检测 ——
  if (SLASH_COMMAND_RE.test(cleaned.trim())) {
    return handleSlashCommand(cleaned.trim(), chatId, registry, deps);
  }

  // —— 普通任务：创建或续接 session ——
  return handleTaskMessage(cleaned, chatId, registry, deps);
}

// ── 内部处理函数 ──

async function handleSwitchProject(
  targetPath: string,
  chatId: string,
  registry: SessionRegistry,
  deps: ExecuteTaskDeps,
): Promise<TaskResult> {
  const newSessionId = deps.generateSessionId();
  const now = deps.now();

  registry.register({
    sessionId: newSessionId,
    projectDir: targetPath,
    feishuChatId: chatId,
    createdAt: now,
    lastActive: now,
  });

  if (deps.ensureClaudeSettings) {
    deps.ensureClaudeSettings(targetPath).catch(() => {});
  }

  return {
    ok: true,
    summary: `✅ 已切换到项目：${targetPath}（新会话 ID：${newSessionId}）`,
    sessionId: newSessionId,
  };
}

function handleCurrentProject(
  chatId: string,
  registry: SessionRegistry,
): TaskResult {
  const existing = registry.findByChatId(chatId);

  if (!existing) {
    return {
      ok: true,
      summary:
        "📂 当前没有活跃的项目会话。请先发送任务消息指定项目目录，例如：\n「在 d:\\tool\\yuancheng 审查代码」",
      sessionId: "",
    };
  }

  return {
    ok: true,
    summary: `📂 当前项目：${existing.projectDir}\n会话 ID：${existing.sessionId}\n最近活动：${existing.lastActive.toISOString()}`,
    sessionId: existing.sessionId,
  };
}

/**
 * 「列出对话」— 展示已知会话，可按项目关键词或路径筛选。
 *
 * @param filter 可选：项目关键词（如 "yuancheng"）或路径（如 "d:\tool\yuancheng"）
 */
function handleListSessions(
  chatId: string,
  registry: SessionRegistry,
  deps: ExecuteTaskDeps,
  filter?: string,
): TaskResult {
  const discover = deps.discoverSessions ?? discoverClaudeSessions;
  let sessions = discover();

  // 项目筛选
  if (filter) {
    const kw = filter.toLowerCase().replace(/\\/g, "").replace(/:/g, "");
    sessions = sessions.filter((s) => {
      const dir = s.projectDir.toLowerCase().replace(/\\/g, "").replace(/:/g, "");
      return dir.includes(kw) || s.projectDirName.toLowerCase().includes(kw);
    });

    // 记住本次筛选，后续「进入对话 <序号>」在此范围内查找
    const existing = registry.findByChatId(chatId);
    if (existing) {
      registry.register({ ...existing, lastFilter: kw, lastActive: deps.now() });
    }

    if (sessions.length === 0) {
      return {
        ok: true,
        summary: `🔍 没有找到匹配「${filter}」的对话。\n\n💡 输入「列出对话」查看全部 ${discover().length} 个对话。`,
        sessionId: existing?.sessionId ?? "",
      };
    }
  }

  // 标记当前活跃会话（无筛选时清除 lastFilter）
  const active = registry.findByChatId(chatId);
  if (active && !filter) {
    registry.register({ ...active, lastFilter: undefined, lastActive: deps.now() });
  }
  const activeSessionId = active?.sessionId ?? "";

  // 构建会话列表（最多显示 20 条）
  const maxShow = 20;
  const header = filter
    ? `📋 **「${filter}」的对话**（${sessions.length} 个）：`
    : `📋 **对话列表**（共 ${sessions.length} 个，显示最近 ${Math.min(sessions.length, maxShow)} 个）：`;
  const lines: string[] = [header, ""];

  for (let i = 0; i < Math.min(sessions.length, maxShow); i++) {
    const s = sessions[i];
    const index = i + 1;
    const isActive = s.sessionId === activeSessionId;
    const marker = isActive ? " 🟢" : "";
    const sourceIcon = s.source === "bridge" ? "📱" : "💻";
    const timeStr = formatRelativeTime(s.lastActivity);

    // 截断过长的标题
    const title = s.title.length > 50
      ? s.title.slice(0, 47) + "..."
      : s.title;

    lines.push(
      `${index}.${marker} ${sourceIcon} **${title}**`,
    );
    lines.push(
      `   📂 \`${s.projectDir}\` · ${timeStr} · ${s.messageCount} 轮`,
    );
    lines.push(
      `   🆔 \`${s.sessionId.slice(0, 8)}...\``,
    );
    lines.push("");
  }

  if (sessions.length > maxShow) {
    lines.push(`... 还有 ${sessions.length - maxShow} 个对话未显示`);
  }

  lines.push("---");
  if (filter) {
    lines.push("💡 输入 **「进入对话 <序号>」** 或 UUID 前缀来选择对话（如 `进入对话 19172c93`）");
    lines.push("💡 注意：序号基于全局排序，建议用 UUID 前缀精确进入");
  } else {
    lines.push("💡 输入 **「进入对话 <序号>」** 或 **「进入对话 <UUID前8位>」** 来选择对话");
  }
  lines.push("💡 输入 **「新对话」** 在当前项目创建新对话");

  return {
    ok: true,
    summary: lines.join("\n"),
    sessionId: activeSessionId,
  };
}

/**
 * 「进入对话 <id/序号/关键词>」— 切换到指定会话。
 */
function handleEnterSession(
  target: string,
  chatId: string,
  registry: SessionRegistry,
  deps: ExecuteTaskDeps,
): TaskResult {
  const discover = deps.discoverSessions ?? discoverClaudeSessions;
  const allSessions = discover();

  if (allSessions.length === 0) {
    return {
      ok: false,
      error: "没有找到任何对话。",
    };
  }

  // 如果有上次筛选，按序号时在该范围内查找
  const existing = registry.findByChatId(chatId);
  const lastFilter = existing?.lastFilter;

  let found: DiscoveredSession | null = null;

  // 1. 按序号匹配（优先在筛选范围内）
  const index = parseInt(target, 10);
  if (!isNaN(index) && index >= 1) {
    const scope = lastFilter
      ? allSessions.filter((s) => {
          const dir = s.projectDir.toLowerCase().replace(/\\/g, "").replace(/:/g, "");
          return dir.includes(lastFilter) || s.projectDirName.toLowerCase().includes(lastFilter);
        })
      : allSessions;

    if (index <= scope.length) {
      found = scope[index - 1];
    }
  }

  // 2. 按 UUID 前缀匹配（至少 4 个字符）
  if (!found && target.length >= 4) {
    found = allSessions.find((s) => s.sessionId.startsWith(target)) ?? null;
  }

  // 3. 按项目名或标题关键词匹配
  if (!found) {
    const keyword = target.toLowerCase();
    const matches = allSessions.filter(
      (s) =>
        s.projectDir.toLowerCase().includes(keyword) ||
        s.title.toLowerCase().includes(keyword),
    );
    if (matches.length === 1) {
      found = matches[0];
    } else if (matches.length > 1) {
      // 多个匹配，列出让用户选择
      const lines = [`🔍 「${target}」匹配到 ${matches.length} 个对话：`, ""];
      for (let i = 0; i < Math.min(matches.length, 10); i++) {
        const m = matches[i];
        lines.push(
          `${i + 1}. **${m.title.slice(0, 50)}** · \`${m.projectDir}\``,
        );
        lines.push(`   🆔 \`${m.sessionId.slice(0, 8)}...\``);
      }
      lines.push("");
      lines.push("💡 请用序号或 UUID 前缀精确选择：**「进入对话 <序号>」**");
      return {
        ok: true,
        summary: lines.join("\n"),
        sessionId: registry.findByChatId(chatId)?.sessionId ?? "",
      };
    }
  }

  if (!found) {
    return {
      ok: false,
      error:
        `❌ 未找到匹配的对话：「${target}」\n\n` +
        `请使用「列出对话」查看所有对话，或用序号/UUID 前缀指定。`,
    };
  }

  // 注册到当前 chat
  const now = deps.now();
  registry.register({
    sessionId: found.sessionId,
    projectDir: found.projectDir,
    feishuChatId: chatId,
    createdAt: found.lastActivity,
    lastActive: now,
  });

  // 确保项目有权限桥配置
  if (deps.ensureClaudeSettings) {
    deps.ensureClaudeSettings(found.projectDir).catch(() => {});
  }

  return {
    ok: true,
    summary:
      `✅ 已进入对话：**${found.title}**\n` +
      `📂 项目：\`${found.projectDir}\`\n` +
      `🆔 \`${found.sessionId}\`\n` +
      `🕐 最后活动：${formatRelativeTime(found.lastActivity)}\n` +
      `📊 消息数：${found.messageCount} 轮\n` +
      `📡 来源：${found.source === "bridge" ? "飞书" : "VSCode"}\n\n` +
      `现在可以直接发送消息继续此对话，或使用 / 命令。`,
    sessionId: found.sessionId,
  };
}

/**
 * 「新对话」— 清除当前 chat 的会话绑定，下次任务消息会创建新会话。
 */
function handleNewSession(
  chatId: string,
  registry: SessionRegistry,
  deps: ExecuteTaskDeps,
): TaskResult {
  const existing = registry.findByChatId(chatId);

  if (existing) {
    registry.remove(existing.sessionId);
    return {
      ok: true,
      summary:
        `✅ 已离开对话，下次任务消息将创建新对话。\n` +
        `之前的对话仍保留在磁盘上，可通过「列出对话」找回。`,
      sessionId: "",
    };
  }

  return {
    ok: true,
    summary: "当前没有活跃对话，发送任务消息即可创建新对话。",
    sessionId: "",
  };
}

/**
 * 「当前对话」— 显示当前活跃会话的详细信息。
 */
function handleCurrentSession(
  chatId: string,
  registry: SessionRegistry,
  deps: ExecuteTaskDeps,
): TaskResult {
  const existing = registry.findByChatId(chatId);

  if (!existing) {
    return {
      ok: true,
      summary:
        "📭 当前没有活跃对话。\n\n" +
        "💡 输入「列出对话」查看所有可用对话\n" +
        "💡 输入「进入对话 <序号>」选择一个对话",
      sessionId: "",
    };
  }

  // 尝试从磁盘获取更多信息
  const discover = deps.discoverSessions ?? discoverClaudeSessions;
  const allSessions = discover();
  const diskSession = allSessions.find((s) => s.sessionId === existing.sessionId);

  const title = diskSession?.title ?? "（未知标题）";
  const messageCount = diskSession?.messageCount ?? 0;
  const source = diskSession?.source ?? "bridge";

  return {
    ok: true,
    summary:
      `📌 **当前对话**\n\n` +
      `📂 项目：\`${existing.projectDir}\`\n` +
      `🏷️ 标题：${title}\n` +
      `🆔 \`${existing.sessionId}\`\n` +
      `📊 消息数：${messageCount} 轮\n` +
      `📡 来源：${source === "bridge" ? "飞书" : "VSCode"}\n` +
      `🕐 最近活动：${formatRelativeTime(existing.lastActive)}\n\n` +
      `💡 直接发送消息即可继续此对话，发送 / 命令可执行 Claude Code 内置指令。`,
    sessionId: existing.sessionId,
  };
}

/**
 * 「退出会话」— 退出当前对话，回到无会话状态。
 * 之后的消息不再自动 --resume，除非用户再次「进入对话」或「新对话」。
 */
function handleExitSession(
  chatId: string,
  registry: SessionRegistry,
): TaskResult {
  const existing = registry.findByChatId(chatId);

  if (!existing) {
    return {
      ok: true,
      summary:
        "📭 当前没有活跃对话，无需退出。\n\n" +
        "💡 输入「列出对话」查看所有可用对话\n" +
        "💡 输入「进入对话 <序号>」选择一个对话",
      sessionId: "",
    };
  }

  registry.remove(existing.sessionId);

  return {
    ok: true,
    summary:
      `✅ 已退出对话：\`${existing.sessionId.slice(0, 8)}...\`\n` +
      `📂 项目：\`${existing.projectDir}\`\n\n` +
      `之前的对话仍保留在磁盘上，可通过「列出对话」找回。\n` +
      `💡 输入「**新对话**」开始新对话，或直接发送任务消息自动创建。`,
    sessionId: "",
  };
}

/**
 * 执行 / 命令（/compact、/clear 等）。
 * 优先使用 PTY 交互模式（支持 / 命令 + PermissionRequest hook），回退到 -p 模式。
 */
async function handleSlashCommand(
  command: string,
  chatId: string,
  registry: SessionRegistry,
  deps: ExecuteTaskDeps,
): Promise<TaskResult> {
  const existing = registry.findByChatId(chatId);

  if (!existing) {
    return {
      ok: false,
      error:
        "❌ 没有活跃对话来执行 / 命令。\n\n" +
        "请先发送任务消息创建对话，或使用「进入对话 <id>」选择一个已有对话。",
    };
  }

  // 优先用 PTY 交互模式（支持 / 命令 + PermissionRequest hook → 飞书卡片）
  if (deps.callClaudeInteractive) {
    try {
      const output = await deps.callClaudeInteractive(command, {
        projectDir: existing.projectDir,
        sessionId: existing.sessionId,
        timeoutMs: deps.taskTimeoutMs ?? 300_000,
      });

      registry.touch(existing.sessionId, deps.now());

      return {
        ok: true,
        summary: output || "命令已执行。",
        sessionId: existing.sessionId,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: `命令执行失败：${message}`,
      };
    }
  }

  // 回退到 -p 模式（可能不支持某些 / 命令）
  return callClaudeWithSession(
    command,
    existing.projectDir,
    existing.sessionId,
    chatId,
    registry,
    deps,
    false,
  );
}

async function handleTaskMessage(
  userMessage: string,
  chatId: string,
  registry: SessionRegistry,
  deps: ExecuteTaskDeps,
): Promise<TaskResult> {
  const existing = registry.findByChatId(chatId);

  // 尝试从消息中提取项目目录
  const extractedDir = extractProjectDir(userMessage);

  if (existing) {
    // 已有会话 —— 续接
    const projectDir = extractedDir ?? existing.projectDir;

    // 如果用户指定了新目录，更新注册表
    if (extractedDir && extractedDir !== existing.projectDir) {
      registry.register({
        sessionId: existing.sessionId,
        projectDir: extractedDir,
        feishuChatId: chatId,
        createdAt: existing.createdAt,
        lastActive: deps.now(),
      });
    } else {
      registry.touch(existing.sessionId, deps.now());
    }

    // 确保项目 settings 包含最新的预授权规则
    if (deps.ensureClaudeSettings) {
      deps.ensureClaudeSettings(projectDir).catch(() => {});
    }

    // 已有会话：使用 --resume 续接（如果是真实 UUID）
    return callClaudeWithSession(
      userMessage,
      projectDir,
      existing.sessionId,
      chatId,
      registry,
      deps,
      false, // 使用 --resume
    );
  }

  // —— 没有现有会话 ——
  const projectDir = extractedDir ?? deps.defaultProjectDir;
  if (!projectDir) {
    return {
      ok: false,
      error:
        "无法确定项目目录。请在消息中指定目录路径，例如：\n" +
        "「在 d:\\tool\\yuancheng 审查代码」\n" +
        "「审查 d:\\myproject」\n\n" +
        "💡 也可以输入「列出对话」查看已有对话。",
    };
  }

  const sessionId = deps.generateSessionId();
  const now = deps.now();

  registry.register({
    sessionId,
    projectDir,
    feishuChatId: chatId,
    createdAt: now,
    lastActive: now,
  });

  // 自动为此项目生成 .claude/settings.json（含权限桥 hook）
  if (deps.ensureClaudeSettings) {
    deps.ensureClaudeSettings(projectDir).catch(() => {});
  }

  // 首次调用不传 sessionId —— 后续再发现真实 UUID
  return callClaudeWithSession(userMessage, projectDir, sessionId, chatId, registry, deps, true);
}

/**
 * 调用 Claude Code 并返回结果。
 *
 * @param prompt 用户消息
 * @param projectDir 项目目录
 * @param ourSessionId 注册表 session ID
 * @param deps 依赖
 * @param isNew 是否为新会话（true = 不传 sessionId 给 Claude）
 */
async function callClaudeWithSession(
  prompt: string,
  projectDir: string,
  ourSessionId: string,
  chatId: string,
  registry: SessionRegistry,
  deps: ExecuteTaskDeps,
  isNew: boolean = false,
): Promise<TaskResult> {
  try {
    // 构建进度回调：子进程存活时每 30s 向飞书发送进度提醒
    const onProgress = deps.sendProgress
      ? (elapsedMs: number, pid: number) => {
          const minutes = Math.floor(elapsedMs / 60_000);
          const seconds = Math.floor((elapsedMs % 60_000) / 1000);
          const elapsed = minutes > 0
            ? `${minutes} 分 ${seconds} 秒`
            : `${seconds} 秒`;
          void deps.sendProgress!(chatId,
            `⏳ 任务仍在处理中…（已运行 ${elapsed}，PID ${pid}）`,
          );
        }
      : deps.onTaskProgress;

    const output = await deps.callClaude(prompt, {
      projectDir,
      sessionId: isNew ? undefined : ourSessionId,
      timeoutMs: deps.taskTimeoutMs ?? 900_000,
      onProgress,
    });

    // 首次调用后，发现 Claude Code 的真实 UUID 并更新注册表。
    // 只在新建会话时执行；续接成功时 UUID 未变，无需扫描磁盘。
    if (isNew) {
      updateSessionWithRealUuid(projectDir, ourSessionId, chatId, registry);
    }

    return {
      ok: true,
      summary: output,
      sessionId: ourSessionId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // 如果 --resume 失败（session ID 无效），告知用户上下文丢失
    if (!isNew && message.includes("resume")) {
      return {
        ok: false,
        error:
          `⚠️ 会话 \`${ourSessionId.slice(0, 8)}...\` 已过期，无法恢复对话上下文。\n\n` +
          `💡 请输入「**新对话**」开始一个新会话，或「**列出对话**」选择其他对话。`,
      };
    }

    return {
      ok: false,
      error: `任务执行失败：${message}`,
    };
  }
}

/**
 * 首次任务完成后，从磁盘发现 Claude Code 真实 UUID 并更新注册表。
 *
 * Claude Code 创建会话时会生成真实 UUID（如 1845fff9-...），
 * 而 Bridge 初始注册的是自生成 ID（如 session_1719...）。
 * 不更新的话，后续 --resume 会因为 ID 不匹配而失败，
 * PTY 模式下更是会触发 Welcome 界面导致 fresh-start 检测拒绝。
 */
function updateSessionWithRealUuid(
  projectDir: string,
  ourSessionId: string,
  chatId: string,
  registry: SessionRegistry,
): void {
  try {
    const realUuid = findLatestSessionInProject(projectDir);
    if (realUuid && realUuid !== ourSessionId) {
      // 找到了真实的 Claude Code UUID → 更新注册表
      const existing = registry.findByChatId(chatId);
      if (existing) {
        registry.register({
          ...existing,
          sessionId: realUuid,
          lastActive: new Date(),
        });
      }
    }
  } catch {
    // 静默失败（不影响任务结果）
  }
}

// ── 工具函数 ──

/**
 * 从用户消息中提取 Windows 绝对路径。
 */
function extractProjectDir(message: string): string | null {
  const matches = message.match(WIN_PATH_RE);
  if (!matches || matches.length === 0) return null;

  const sorted = [...matches].sort((a, b) => b.length - a.length);
  return sorted[0];
}

/** 将时间格式化为相对时间字符串 */
function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return "刚刚";
  if (diffMin < 60) return `${diffMin} 分钟前`;

  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour} 小时前`;

  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay} 天前`;

  return date.toLocaleDateString("zh-CN");
}
