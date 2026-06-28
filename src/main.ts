import * as fs from "fs";
import * as lark from "@larksuiteoapi/node-sdk";
import { execFile } from "child_process";
import * as http from "http";
import * as path from "path";
import { createFeishuBridge } from "./createFeishuBridge.js";
import { createOllamaClassifier } from "./createOllamaClassifier.js";
import { classifyIntent } from "./classifyIntent.js";
import { listDirectory } from "./listDirectory.js";
import { isSenderAllowed } from "./isSenderAllowed.js";
import { createMessagePipeline } from "./createMessagePipeline.js";
import { executeInquire } from "./executeInquire.js";
import { executeTask } from "./executeTask.js";
import { createSessionRegistry } from "./sessionRegistry.js";
import { discoverClaudeSessions } from "./discoverClaudeSessions.js";
import { runClaudeInteractive } from "./runClaude.js";
import { captureScreenshot } from "./captureScreenshot.js";
import { getSystemStatus, formatSystemStatus } from "./getSystemStatus.js";
import { openProgram, closeProgram } from "./programManager.js";
import { runScript } from "./runScript.js";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import type { CommandConfig } from "./commandConfig.js";

const require = createRequire(import.meta.url);
const commandConfig = require("./commands.config.json") as CommandConfig;
import {
  createPermissionGate,
  DEFAULT_HIGH_RISK_ACTIONS,
  DEFAULT_LOW_RISK_ACTIONS,
} from "./createPermissionGate.js";
import { createRotatingLogger } from "./createRotatingLogger.js";
import { createHealthChecker, type HealthCheck } from "./createHealthChecker.js";
import { classifyError, formatErrorMessage } from "./formatErrorMessage.js";
import { withAutoRestart } from "./withAutoRestart.js";
import { createStartupManager } from "./createStartupManager.js";
import type { RiskRuleConfig, ConfirmationSender } from "./types.js";
import { createPermissionLogger } from "./createPermissionLogger.js";
import { createClaudeSettingsWriter } from "./createClaudeSettingsWriter.js";

function getEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`环境变量 ${name} 未设置`);
  }
  return value;
}

// ── 日志 ──

const logDir = process.env.FEISHU_LOG_DIR ?? path.join(process.cwd(), "logs");
const fileLogger = createRotatingLogger({ logDir, retentionDays: 7 });

/** 同时写入文件和控制台 */
function log(msg: string): void {
  console.log(msg);
  fileLogger(msg);
}

// ── 配置 ──

const appId = getEnv("FEISHU_APP_ID");
const appSecret = getEnv("FEISHU_APP_SECRET");

// 白名单：逗号分隔的 open_id 列表
const allowedIds = (process.env.FEISHU_ALLOWED_OPEN_IDS ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

if (allowedIds.length === 0) {
  log("⚠️ 警告：白名单为空（FEISHU_ALLOWED_OPEN_IDS 未设置），任何用户的消息都将被静默忽略。");
}

// 通知目标 chat_id（用于健康检查等系统通知）
const notifyChatId = process.env.FEISHU_NOTIFY_CHAT_ID ?? "";

const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
const ollamaModel = process.env.OLLAMA_MODEL ?? "qwen2.5:7b";
const taskTimeoutMs = parseInt(
  process.env.FEISHU_TASK_TIMEOUT_MS ?? "300000",
  10,
);

const callOllama = createOllamaClassifier({
  baseUrl: ollamaBaseUrl,
  model: ollamaModel,
});

/** Claude Code CLI 路径：优先使用环境变量，然后自动发现 VSCode 扩展中的最新版本，最后回退到 PATH */
function resolveClaudePath(): string {
  // 1. 环境变量指定
  const envPath = process.env.CLAUDE_CLI_PATH;
  if (envPath) {
    try {
      const stat = fs.statSync(envPath);
      if (stat.isFile()) return envPath;
    } catch { /* 文件不存在，继续尝试 */ }
    log(`[Startup] CLAUDE_CLI_PATH 指定的路径不存在: ${envPath}，尝试自动发现…`);
  }

  // 2. 自动发现 VSCode 扩展中的最新 Claude Code
  try {
    // Windows: USERPROFILE 格式是 C:\Users\xxx，path.join 能正确处理
    // HOME 在 Git Bash 里是 /c/Users/xxx，path.join 会拼成无效路径
    const homeDir = process.env.USERPROFILE ?? process.env.HOME ?? ".";
    const extDir = path.join(homeDir, ".vscode", "extensions");
    if (fs.existsSync(extDir)) {
      const entries = fs.readdirSync(extDir).filter(
        (f) => f.startsWith("anthropic.claude-code-"),
      );
      if (entries.length > 0) {
        entries.sort(); // 字母序排列，最新版本在最后
        const latest = entries[entries.length - 1];
        const cliPath = path.join(extDir, latest, "resources", "native-binary", "claude.exe");
        if (fs.existsSync(cliPath)) {
          log(`[Startup] 自动发现 Claude Code CLI: ${cliPath}`);
          return cliPath;
        }
      }
    }
  } catch { /* 静默失败 */ }

  // 3. 回退到 PATH 中的 "claude"
  return "claude";
}
const CLAUDE_CLI_PATH = resolveClaudePath();

/** 调用 Claude Code CLI 单次查询，超时自动终止。使用 execFile 避免 shell 注入。 */
function callClaude(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(CLAUDE_CLI_PATH, ["-p", prompt], { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      const output = stdout.trim() || stderr.trim();
      resolve(output);
    });
  });
}

// ── 会话注册表 ──

const sessionRegistry = createSessionRegistry({
  now: () => new Date(),
  persistPath: path.join(logDir, "sessions.json"),
});

/** 定期清理 30 分钟无活动的会话 */
const SESSION_CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟
const SESSION_MAX_INACTIVE_MS = 30 * 60 * 1000; // 30 分钟

setInterval(() => {
  const cleaned = sessionRegistry.cleanup(SESSION_MAX_INACTIVE_MS);
  if (cleaned > 0) {
    log(`[SessionRegistry] 已清理 ${cleaned} 个过期会话`);
  }
}, SESSION_CLEANUP_INTERVAL_MS);

/** 调用 Claude Code CLI（支持 session）。首调用 -p 模式创建会话，后续用 PTY 交互模式触发权限 hook。 */
function callClaudeForTask(
  prompt: string,
  opts: { projectDir: string; sessionId?: string; timeoutMs: number },
): Promise<string> {
  // 有 sessionId = 续接已有会话 → 用 PTY 交互模式（支持 PermissionRequest hook → 飞书卡片）
  if (opts.sessionId) {
    return runClaudeInteractive(prompt, {
      projectDir: opts.projectDir,
      sessionId: opts.sessionId,
      timeoutMs: opts.timeoutMs,
      claudePath: CLAUDE_CLI_PATH,
    });
  }

  // 无 sessionId = 首次调用创建新会话 → 用 -p 模式（快速、无交互）
  return new Promise((resolve, reject) => {
    const args = ["-p", prompt];
    execFile(
      CLAUDE_CLI_PATH,
      args,
      { cwd: opts.projectDir, timeout: opts.timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        const output = stdout.trim() || stderr.trim() || "";
        resolve(output);
      },
    );
  });
}

/** 调用 Claude Code CLI 交互模式（无 -p，支持 / 命令） */
function callClaudeInteractive(
  input: string,
  opts: { projectDir: string; sessionId?: string; timeoutMs: number },
): Promise<string> {
  return runClaudeInteractive(input, {
    projectDir: opts.projectDir,
    sessionId: opts.sessionId,
    timeoutMs: opts.timeoutMs,
    claudePath: CLAUDE_CLI_PATH,
  });
}

// ── 错误格式化 ──

/** 将原始错误格式化为用户可读的建议消息 */
function formatError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const type = classifyError(message);
  return formatErrorMessage({ type, detail: message });
}

// ── 高危操作确认门配置 ──

const riskRuleConfig: RiskRuleConfig = {
  highRiskActions: parseEnvList("FEISHU_HIGH_RISK_ACTIONS", DEFAULT_HIGH_RISK_ACTIONS),
  lowRiskActions: parseEnvList("FEISHU_LOW_RISK_ACTIONS", DEFAULT_LOW_RISK_ACTIONS),
};

function parseEnvList(envName: string, defaults: string[]): string[] {
  const raw = process.env[envName];
  if (!raw) return defaults;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── 权限日志与预配置 ──

const permissionLogger = createPermissionLogger();

const claudeSettingsWriter = createClaudeSettingsWriter({
  writeFile: async (filePath: string, content: string) => {
    const { writeFile } = await import("fs/promises");
    await writeFile(filePath, content, "utf-8");
  },
  readFile: async (filePath: string) => {
    const { readFile } = await import("fs/promises");
    return readFile(filePath, "utf-8");
  },
  mkdir: async (dirPath: string) => {
    const { mkdir } = await import("fs/promises");
    await mkdir(dirPath, { recursive: true });
  },
});

/**
 * 为目标项目自动生成 .claude/settings.json。
 * 包含：
 * 1. 权限桥 hook（Claude Code → permissionBridge.js → HTTP → 飞书卡片）
 * 2. 安全的只读预授权规则（Read/Glob/Grep 等无需飞书确认）
 */
/** Feishu Bridge 安装目录（用于推导 permissionBridge.js 路径） */
const bridgeRootDir = path.dirname(fileURLToPath(import.meta.url));

async function ensureClaudeSettings(projectDir: string): Promise<void> {
  // permissionBridge.js 在 bridge 安装目录的 dist/ 子目录下
  const bridgeScriptPath = path.join(bridgeRootDir, "..", "dist", "permissionBridge.js");
  const nodePath = process.execPath; // Node.js 可执行文件路径

  // 构建 Claude Code settings（PermissionRequest hook 格式）
  const hooksConfig = {
    hooks: {
      PermissionRequest: [
        {
          matcher: "*",
          hooks: [
            { type: "command", command: `${nodePath} ${bridgeScriptPath}` },
          ],
        },
      ],
    },
  };

  const settingsPath = path.join(projectDir, ".claude", "settings.json");
  const claudeDir = path.dirname(settingsPath);

  try {
    // 确保 .claude 目录存在
    const { mkdir } = await import("fs/promises");
    await mkdir(claudeDir, { recursive: true });

    // 尝试合并已有配置
    let existing: Record<string, unknown> = {};
    try {
      const { readFile } = await import("fs/promises");
      const raw = await readFile(settingsPath, "utf-8");
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 文件不存在，使用空配置
    }

    // 合并 hooks（保留已有的其他 hooks）
    const merged = { ...existing, ...hooksConfig };

    const { writeFile } = await import("fs/promises");
    await writeFile(
      settingsPath,
      JSON.stringify(merged, null, 2) + "\n",
      "utf-8",
    );

    log(`[ClaudeSettings] 已为 ${projectDir} 生成 .claude/settings.json（含权限桥 hook）`);
  } catch (err) {
    log(
      `[ClaudeSettings] 写入失败 ${projectDir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 卡片确认管理器 — 真正的飞书交互卡片确认。
 *
 * 流程：
 * 1. sendCard：构建 confirm/deny 双按钮卡片，发送到飞书
 * 2. card.action.trigger 事件到达时，解析用户选择
 * 3. waitForButtonClick 返回的 Promise 被 resolve/reject
 */
const pendingConfirmations = new Map<
  string,
  {
    resolve: (result: "allowed" | "denied" | "allowed_always") => void;
    timer: ReturnType<typeof setTimeout>;
    /** 用于更新卡片和发送确认消息 */
    chatId: string;
    title: string;
    description: string;
    projectDir?: string;
  }
>();

/** 卡片上下文暂存：sendCard 时写入，waitForButtonClick / handleCardAction 时读取 */
const cardContexts = new Map<
  string,
  { chatId: string; title: string; description: string; projectDir?: string }
>();

/** 构建飞书确认卡片 JSON */
function buildConfirmationCard(title: string, description: string, projectDir?: string): string {
  const elements: any[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content: description },
    },
  ];

  // 多窗口场景：显示来源项目路径，让用户知道是哪个窗口在请求
  if (projectDir) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `📂 **项目：**\n\`${projectDir}\`` },
    });
  }

  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "✅ 允许一次" },
        type: "primary",
        value: { confirmId: "confirm" },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "📌 始终允许" },
        type: "default",
        value: { confirmId: "always" },
      },
      {
        tag: "button",
        text: { tag: "plain_text", content: "❌ 拒绝" },
        type: "danger",
        value: { confirmId: "deny" },
      },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: "red",
    },
    elements,
  });
}

/** 构建确认后的卡片（替换按钮为结果标记） */
function buildConfirmedCard(
  title: string,
  description: string,
  decision: "allowed" | "denied" | "allowed_always",
  projectDir?: string,
): string {
  const decisionLabel =
    decision === "allowed_always"
      ? "✅ 已设为始终允许"
      : decision === "allowed"
        ? "✅ 已确认执行"
        : "❌ 已拒绝";

  const decisionColor =
    decision === "denied" ? "red" : "green";

  const elements: any[] = [
    {
      tag: "div",
      text: { tag: "lark_md", content: description },
    },
  ];

  if (projectDir) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `📂 **项目：**\n\`${projectDir}\`` },
    });
  }

  elements.push({
    tag: "div",
    text: {
      tag: "lark_md",
      content: `**${decisionLabel}**`,
    },
  });

  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
      },
    ],
  });

  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: title },
      template: decisionColor,
    },
    elements,
  });
}

const safeConfirmationSender: ConfirmationSender = {
  sendCard: async (chatId: string, title: string, description: string) => {
    const card = buildConfirmationCard(title, description);
    const { message_id } = await bridge.sendCard(chatId, card);

    if (!message_id) {
      // 卡片发送失败 → 发文本消息兜底
      log(`[PermissionGate] ⚠️ 卡片发送失败，回退到文本消息: ${title}`);
      await bridge.sendTextMessage(
        chatId,
        `⚠️ **${title}**\n\n${description}\n\n⚠️ 卡片发送失败，请直接回复「允许」或「拒绝」来确认此操作。`,
      ).catch(() => {});
    } else {
      // 卡片发送成功 → 同时发一条文本消息提醒用户查看卡片
      await bridge.sendTextMessage(
        chatId,
        `📋 已发送确认卡片，请在飞书中点击按钮确认操作。`,
      ).catch(() => {});
    }

    // 暂存上下文，供 waitForButtonClick 和 handleCardAction 使用
    cardContexts.set(message_id, { chatId, title, description });
    log(`[PermissionGate] 已发送确认卡片: ${title} (message_id=${message_id || "FAILED"})`);
    return message_id;
  },
  waitForButtonClick: async (messageId: string, timeoutMs: number) => {
    const ctx = cardContexts.get(messageId) ?? { chatId: "", title: "", description: "" };
    return new Promise<"allowed" | "denied" | "allowed_always">((resolve) => {
      const timer = setTimeout(() => {
        // 超时也更新卡片，让用户知道已超时
        void bridge.patchCard(
          messageId,
          buildConfirmedCard(ctx.title, ctx.description, "denied", ctx.projectDir),
        ).catch(() => {});
        pendingConfirmations.delete(messageId);
        cardContexts.delete(messageId);
        log(`[PermissionGate] 确认超时: message_id=${messageId}`);
        resolve("denied");
      }, timeoutMs);

      pendingConfirmations.set(messageId, {
        resolve,
        timer,
        chatId: ctx.chatId,
        title: ctx.title,
        description: ctx.description,
        projectDir: ctx.projectDir,
      });
    });
  },
};

/** 处理飞书卡片按钮点击回调 */
async function handleCardAction(event: { action: { value: unknown }; context: { open_message_id: string } }): Promise<void> {
  const messageId = event.context?.open_message_id;
  if (!messageId) return;

  const pending = pendingConfirmations.get(messageId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingConfirmations.delete(messageId);

  const value = event.action?.value as { confirmId?: string } | undefined;
  let result: "allowed" | "denied" | "allowed_always";
  let resultLabel: string;
  if (value?.confirmId === "always") {
    result = "allowed_always";
    resultLabel = "✅ 已设为始终允许";
  } else if (value?.confirmId === "confirm") {
    result = "allowed";
    resultLabel = "✅ 已确认，正在执行…";
  } else {
    result = "denied";
    resultLabel = "❌ 操作已拒绝";
  }
  log(`[PermissionGate] 用户选择: ${result} (message_id=${messageId})`);

  // 1) 更新卡片为确认结果（替换按钮为状态标记）
  void bridge.patchCard(
    messageId,
    buildConfirmedCard(pending.title, pending.description, result, pending.projectDir),
  ).catch((err) => {
    log(`[PermissionGate] 卡片更新失败: ${err instanceof Error ? err.message : String(err)}`);
  });

  // 2) 发送确认结果文本消息，让用户在手机上也能看到反馈
  if (pending.chatId) {
    void bridge.sendTextMessage(
      pending.chatId,
      `${resultLabel}\n\n${pending.description}`,
    ).catch((err) => {
      log(`[PermissionGate] 确认消息发送失败: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // 3) 清理上下文缓存
  cardContexts.delete(messageId);

  // 4) 恢复执行流程
  pending.resolve(result);
}

const permissionGate = createPermissionGate({
  ruleConfig: riskRuleConfig,
  confirmationSender: safeConfirmationSender,
  logger: (msg) => log(`[PermissionGate] ${msg}`),
});

// ── 消息管道 ──

const pipeline = createMessagePipeline({
  classifyIntent: (message) => classifyIntent(message, { callOllama }),
  isSenderAllowed: (openId) => isSenderAllowed(openId, allowedIds),
  listDirectory,
  executeInquire: (message) => executeInquire(message, { callClaude }),
  executeTask: (message, chatId) =>
    executeTask(message, chatId, sessionRegistry, {
      callClaude: callClaudeForTask,
      callClaudeInteractive,
      generateSessionId: () =>
        `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      now: () => new Date(),
      taskTimeoutMs,
      ensureClaudeSettings,
      discoverSessions: discoverClaudeSessions,
    }),
  permissionGate,
  commandConfig,
  captureScreenshot: () => captureScreenshot(),
  getSystemStatus,
  formatSystemStatus,
  openProgram: (name: string) =>
    openProgram(name, { programMap: commandConfig.programMap }),
  closeProgram: (name: string) =>
    closeProgram(name, { programMap: commandConfig.programMap }),
  runScript: (scriptPath: string) =>
    runScript(scriptPath, { whitelist: commandConfig.scriptWhitelist }),
});

// ── Feishu Bridge ──

// 创建飞书客户端（用于系统通知如健康检查和上线通知）
const feishuClient = new lark.Client({
  appId,
  appSecret,
  appType: lark.AppType.SelfBuild,
  domain: lark.Domain.Feishu,
}) as any;

/** 向指定 chat_id 发送飞书消息 */
async function sendFeishuNotification(chatId: string, text: string): Promise<void> {
  if (!chatId) return; // 未配置通知目标则跳过
  try {
    await feishuClient.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
  } catch (err) {
    log(`[Notification] 发送飞书通知失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const bridge = createFeishuBridge({
  appId,
  appSecret,
  createClient: () => feishuClient,
  createWSClient: (cfg) =>
    new lark.WSClient({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      loggerLevel: lark.LoggerLevel.info,
    }) as any,
  createEventDispatcher: () => new lark.EventDispatcher({}) as any,
  logger: (msg) => log(`[FeishuBridge] ${msg}`),
  onMessage: pipeline.onMessage,
  onCardAction: handleCardAction,
});

// ── 权限桥 HTTP Server ──
// 接收来自 permissionBridge.ts（Claude Code hook）的权限请求，
// 通过飞书卡片让用户确认，返回决策给 Claude Code。

const PERMISSION_PORT = parseInt(
  process.env.FEISHU_PERMISSION_PORT ?? "19384",
  10,
);

/** 向特定 chat_id 发送权限确认卡片并等待用户点击 */
async function requestPermissionViaCard(
  toolName: string,
  operation: string,
  target: string,
  projectDir?: string,
): Promise<"allowed" | "denied" | "allowed_always"> {
  const chatId = notifyChatId;
  if (!chatId) {
    log("[PermissionHTTP] ⚠️ 未配置 FEISHU_NOTIFY_CHAT_ID，无法发送权限确认");
    return "denied";
  }

  const title = `Claude Code 权限确认`;
  let description = `🔧 **${toolName}**\n${operation}`;
  // target 如果没有项目目录信息则显示，避免与 projectDir 重复
  if (target && target !== projectDir) {
    description += `\n\n📁 ${target}`;
  }

  const card = buildConfirmationCard(title, description, projectDir);
  const { message_id } = await bridge.sendCard(chatId, card);

  if (!message_id) {
    // 卡片发送失败 → 发文本消息兜底，直接拒绝
    log(`[PermissionHTTP] ⚠️ 卡片发送失败，回退拒绝: ${toolName} ${operation}`);
    await bridge.sendTextMessage(
      chatId,
      `⚠️ **${title}**\n\n${description}\n\n📂 \`${projectDir ?? ""}\`\n\n❌ 卡片发送失败，操作已被自动拒绝。`,
    ).catch(() => {});
    return "denied";
  }

  // 同时发文本消息提醒用户查看卡片
  await bridge.sendTextMessage(
    chatId,
    `📋 已发送权限确认卡片，请点击按钮确认。`,
  ).catch(() => {});

  // 暂存上下文，供 handleCardAction 使用
  cardContexts.set(message_id, { chatId, title, description, projectDir });
  log(`[PermissionHTTP] 已发送权限卡片: ${toolName} ${operation} (message_id=${message_id})`);

  const result = await new Promise<"allowed" | "denied" | "allowed_always">((resolve) => {
    const timer = setTimeout(() => {
      // 超时也更新卡片
      void bridge.patchCard(
        message_id,
        buildConfirmedCard(title, description, "denied", projectDir),
      ).catch(() => {});
      pendingConfirmations.delete(message_id);
      cardContexts.delete(message_id);
      log(`[PermissionHTTP] 权限确认超时: message_id=${message_id}`);
      resolve("denied");
    }, 120_000); // 2 分钟超时

    pendingConfirmations.set(message_id, {
      resolve,
      timer,
      chatId,
      title,
      description,
      projectDir,
    });
  });

  // 「始终允许」：将操作写入项目的 permissions.allow 白名单
  if (result === "allowed_always" && projectDir) {
    await addToProjectAllowlist(projectDir, toolName, operation);
  }

  return result;
}

/** 将允许的操作写入项目 .claude/settings.json 的 permissions.allow 列表 */
async function addToProjectAllowlist(
  projectDir: string,
  toolName: string,
  operation: string,
): Promise<void> {
  try {
    const settingsPath = path.join(projectDir, ".claude", "settings.json");
    const { readFile, writeFile, mkdir } = await import("fs/promises");

    await mkdir(path.dirname(settingsPath), { recursive: true });

    let settings: Record<string, any> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    } catch { /* 不存在则新建 */ }

    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];

    // 构建白名单规则：Bash(npm run build) 或 Write(d:/path)
    let rule: string;
    if (toolName === "Bash") {
      rule = `Bash(${operation})`;
    } else if (operation) {
      rule = `${toolName}(${operation})`;
    } else {
      rule = toolName;
    }

    // 避免重复
    if (!settings.permissions.allow.includes(rule)) {
      settings.permissions.allow.push(rule);
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
      log(`[PermissionHTTP] 已添加白名单规则: ${rule} → ${settingsPath}`);
    }
  } catch (err) {
    log(`[PermissionHTTP] 白名单写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const permissionServer = http.createServer(
  async (req, res) => {
    // CORS（允许本地 CLI 脚本跨域）
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // 健康检查
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // 权限确认
    if (req.method === "POST" && req.url === "/permission") {
      try {
        const body = await readRequestBody(req);
        const request = JSON.parse(body) as {
          tool_name?: string;
          tool_input?: Record<string, unknown>;
          cwd?: string;
        };

        const toolName = request.tool_name ?? "unknown";
        const toolInput = request.tool_input ?? {};
        const projectDir = request.cwd ?? "";

        // 提取操作描述
        let operation = toolName;
        let target = "";
        if (toolName === "Bash" && typeof toolInput.command === "string") {
          operation = toolInput.command;
          target = projectDir || "";
        } else if (
          typeof toolInput.file_path === "string"
        ) {
          target = toolInput.file_path;
        } else if (
          typeof toolInput.path === "string"
        ) {
          target = toolInput.path;
        }

        log(
          `[PermissionHTTP] 收到权限请求: ${toolName} ${operation} ${target}`,
        );

        const decision = await requestPermissionViaCard(
          toolName,
          operation,
          target,
          projectDir,
        );

        log(`[PermissionHTTP] 决策: ${decision}`);

        // allowed_always 对当前请求也等同 allowed，同时已写入白名单
        const httpDecision = decision === "denied" ? "denied" : "allowed";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ decision: httpDecision }));
      } catch (err) {
        log(
          `[PermissionHTTP] 处理失败: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ decision: "denied", reason: "error" }));
      }
      return;
    }

    // 404
    res.writeHead(404);
    res.end("Not Found");
  },
);

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── 健康检查 ──

const healthChecks: HealthCheck[] = [
  {
    name: "Ollama",
    check: async () => {
      try {
        const res = await fetch(`${ollamaBaseUrl}/api/tags`);
        return { healthy: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
      } catch (err) {
        return { healthy: false, detail: err instanceof Error ? err.message : "连接失败" };
      }
    },
  },
  {
    name: "Claude Code CLI",
    check: async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          execFile(CLAUDE_CLI_PATH, ["--version"], { timeout: 10_000 }, (error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        return { healthy: true };
      } catch (err) {
        return { healthy: false, detail: err instanceof Error ? err.message : "CLI 不可用" };
      }
    },
  },
];

const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟

const healthChecker = createHealthChecker({
  checks: healthChecks,
  intervalMs: HEALTH_CHECK_INTERVAL_MS,
  onUnhealthy: (service, detail) => {
    log(`[HealthCheck] ⚠️ ${service} 异常: ${detail}`);
    void sendFeishuNotification(notifyChatId, `⚠️ Feishu Bridge 健康检查异常\n${service}：${detail}`);
  },
  onRecovered: (service) => {
    log(`[HealthCheck] ✅ ${service} 已恢复`);
    void sendFeishuNotification(notifyChatId, `✅ Feishu Bridge 健康检查恢复\n${service} 已恢复正常。`);
  },
});

// ── 崩溃重启 ──

const restartable = withAutoRestart({
  fn: async () => {
    await bridge.start();
    // bridge.start() 是一个长期运行的服务，正常情况下不返回
  },
  maxRetries: 3,
  retryDelayMs: 2000,
  resetAfterMs: 60_000,
  onCrash: (attempt, errorMessage) => {
    log(`[AutoRestart] 网关崩溃（第 ${attempt} 次重试）: ${errorMessage}`);
    void sendFeishuNotification(
      notifyChatId,
      `⚠️ Feishu Bridge 崩溃，正在自动重启（第 ${attempt} 次）…`,
    );
  },
  onExhausted: (totalRetries, lastErrorMessage) => {
    log(`[AutoRestart] ❌ 已崩溃 ${totalRetries} 次，放弃重启。最后错误: ${lastErrorMessage}`);
    void sendFeishuNotification(
      notifyChatId,
      `❌ Feishu Bridge 已崩溃 ${totalRetries} 次，自动重启已停止。请手动检查。`,
    );
  },
});

// ── 开机自启管理 ──

const startupManager = createStartupManager({
  appName: "Feishu Bridge",
  command: `cd /d "${process.cwd()}" && npm start`,
});

// 如果设置了 FEISHU_AUTO_STARTUP=true，则自动启用开机自启
if (process.env.FEISHU_AUTO_STARTUP === "true") {
  startupManager.enable();
  log("[Startup] 已启用开机自启");
}

// ── 优雅关闭 ──

let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`[Shutdown] 收到 ${signal} 信号，正在优雅关闭…`);

  permissionServer.close();
  log("[Shutdown] 权限 HTTP 服务器已停止");

  healthChecker.stop();
  log("[Shutdown] 健康检查已停止");

  bridge.stop();
  log("[Shutdown] Bridge 已停止");

  if (notifyChatId) {
    try {
      await sendFeishuNotification(notifyChatId, "🔴 Feishu Bridge 已离线");
    } catch {
      // 忽略通知失败
    }
  }

  log("[Shutdown] 进程退出");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// ── 启动 ──

log("Feishu Bridge 正在启动…");
log("[Permission] 权限日志与 settings writer 已初始化");

try {
  // 启动权限桥 HTTP 服务器
  permissionServer.listen(PERMISSION_PORT, "127.0.0.1", () => {
    log(`[PermissionHTTP] 权限桥 HTTP 服务器已启动: http://127.0.0.1:${PERMISSION_PORT}`);
  });

  // 启动健康检查
  healthChecker.start();
  log("[HealthCheck] 健康检查已启动");

  // 发送上线通知
  if (notifyChatId) {
    await sendFeishuNotification(notifyChatId, "✅ Feishu Bridge 已在线");
    log("[Notification] 已发送上线通知");
  }

  // 启动网关（带崩溃自动重启）
  await restartable.start();
} catch (err) {
  log(`[Fatal] 启动失败: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
