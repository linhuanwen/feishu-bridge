/**
 * Claude Code Permission Hook Bridge
 *
 * 支持 PreToolUse 和 PermissionRequest 两种 hook 事件：
 * - PreToolUse: 在 VSCode 扩展和 CLI 中都能触发（推荐）
 * - PermissionRequest: 仅在 CLI 中触发（保留兼容）
 *
 * 流程：
 * 1. 从 stdin 读取 JSON（包含 hook_event_name, tool_name, tool_input）
 * 2. 安全工具（Read/Glob/Grep）→ 直接放行
 * 3. 危险工具（Bash/Write/Edit 等）→ POST 到 Bridge HTTP 服务器
 * 4. Bridge 通过飞书卡片发送到手机确认
 * 5. 将决策写回 stdout → Claude Code 继续/拒绝
 *
 * 用法（在 .claude/settings.json 中配置）：
 *   "hooks": {
 *     "PreToolUse": [{
 *       "matcher": "*",
 *       "hooks": [{ "type": "command", "command": "node d:/tool/yuancheng/dist/permissionBridge.js" }]
 *     }]
 *   }
 */

import * as http from "http";

const BRIDGE_PORT = parseInt(process.env.FEISHU_PERMISSION_PORT ?? "19384", 10);
const BRIDGE_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 120_000; // 2 分钟等待用户确认

// ── 安全工具列表（直接放行，不经过 bridge）──

const SAFE_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "List",
  "Task",       // sub-agent 自身会有权限检查
  "Question",
  "TodoWrite",
  "TaskOutput",
  "EnterPlanMode",
  "ExitPlanMode",
]);

/** 不需要用户确认的工具直接放行 */
function isSafeTool(toolName: string): boolean {
  return SAFE_TOOLS.has(toolName);
}

// ── stdin 读取 ──

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk: string) => {
      chunks.push(Buffer.from(chunk, "utf-8"));
    });
    process.stdin.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    process.stdin.on("error", reject);
    // 如果 stdin 没有数据（可能通过 /dev/null），超时后回退
    setTimeout(() => {
      if (chunks.length === 0) resolve("{}");
    }, 1000);
  });
}

// ── HTTP 请求 ──

function postPermissionRequest(payload: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);

    const req = http.request(
      {
        hostname: BRIDGE_HOST,
        port: BRIDGE_PORT,
        path: "/permission",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve(Buffer.concat(chunks).toString("utf-8"));
        });
      },
    );

    req.on("error", (err) => {
      // Bridge 未运行 → 回退到 deny（安全优先）
      console.error(`[PermissionBridge] Bridge 连接失败: ${err.message}`);
      resolve(JSON.stringify({ decision: "deny", reason: "bridge_unavailable" }));
    });

    req.on("timeout", () => {
      req.destroy();
      console.error("[PermissionBridge] 请求超时");
      resolve(JSON.stringify({ decision: "deny", reason: "timeout" }));
    });

    req.write(body);
    req.end();
  });
}

// ── 输出格式 ──

interface HookRequest {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  cwd?: string;
}

/** 构建 PreToolUse 响应 */
function buildPreToolUseOutput(decision: "allow" | "deny", reason: string): object {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
}

/** 构建 PermissionRequest 响应（兼容旧版 CLI） */
function buildPermissionRequestOutput(behavior: "allow" | "deny"): object {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior },
    },
  };
}

// ── 主逻辑 ──

async function main(): Promise<void> {
  try {
    // 调试：记录每次调用
    try {
      const fs = await import("fs");
      fs.appendFileSync(
        "C:/Users/林焕文/feishu-bridge-logs/permission-bridge-calls.log",
        `${new Date().toISOString()} [CALLED] argv: ${process.argv.join(" ")}\n`,
      );
    } catch { /* 静默 */ }

    // 1. 读取 Claude Code 发来的请求
    const raw = await readStdin();
    let request: HookRequest = {};
    try {
      request = JSON.parse(raw.trim() || "{}");
    } catch {
      // stdin 为空或无效 JSON → 可能是预检调用，直接放行
      process.stdout.write(JSON.stringify(buildPermissionRequestOutput("allow")));
      return;
    }

    const hookEvent = request.hook_event_name ?? "PermissionRequest";
    const toolName = request.tool_name ?? "unknown";

    // 2. 安全工具直接放行（不经过 bridge，零延迟）
    if (hookEvent === "PreToolUse" && isSafeTool(toolName)) {
      process.stdout.write(JSON.stringify(
        buildPreToolUseOutput("allow", `安全工具 ${toolName} 直接放行`),
      ));
      return;
    }

    // 3. 危险工具 → 发给 Bridge HTTP 服务器（→ 飞书卡片 → 等待用户点击）
    const responseRaw = await postPermissionRequest(request);

    // 4. 解析 Bridge 返回的决策
    let response: { decision?: string } = {};
    try {
      response = JSON.parse(responseRaw);
    } catch {
      // 解析失败，默认拒绝
    }

    const allowed = response.decision === "allowed";

    // 5. 根据 hook 类型写回 stdout
    if (hookEvent === "PreToolUse") {
      process.stdout.write(JSON.stringify(
        buildPreToolUseOutput(
          allowed ? "allow" : "deny",
          allowed ? "用户已在飞书确认" : "用户拒绝或超时",
        ),
      ));
    } else {
      process.stdout.write(JSON.stringify(
        buildPermissionRequestOutput(allowed ? "allow" : "deny"),
      ));
    }
  } catch (err) {
    // 任何异常 → 安全回退到 deny
    console.error(
      `[PermissionBridge] 异常: ${err instanceof Error ? err.message : String(err)}`,
    );
    // 尝试根据 hook 类型回退（不知道类型则用 PermissionRequest 格式）
    process.stdout.write(JSON.stringify(buildPermissionRequestOutput("deny")));
  }
}

void main();
