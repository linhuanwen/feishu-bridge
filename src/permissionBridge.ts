/**
 * Claude Code Permission Hook Bridge
 *
 * Claude Code 在需要权限确认时调用此脚本：
 * 1. 从 stdin 读取 JSON（包含 tool_name, tool_input）
 * 2. POST 到 Feishu Bridge 的 HTTP 服务器
 * 3. HTTP 服务器通过飞书卡片让你在手机上确认
 * 4. 将决策写回 stdout → Claude Code 继续/拒绝
 *
 * 用法（在 .claude/settings.json 中配置）：
 *   "hooks": {
 *     "Permission": [{
 *       "matcher": "*",
 *       "command": "node d:/tool/yuancheng/dist/permissionBridge.js"
 *     }]
 *   }
 */

import * as http from "http";

const BRIDGE_PORT = parseInt(process.env.FEISHU_PERMISSION_PORT ?? "19384", 10);
const BRIDGE_HOST = "127.0.0.1";
const DEFAULT_TIMEOUT_MS = 120_000; // 2 分钟等待用户确认

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

// ── 主逻辑 ──

async function main(): Promise<void> {
  try {
    // 调试：记录每次调用，确认 Claude Code 是否真的调起了这个脚本
    try {
      const fs = await import("fs");
      fs.appendFileSync(
        "C:/Users/林焕文/feishu-bridge-logs/permission-bridge-calls.log",
        `${new Date().toISOString()} [CALLED] argv: ${process.argv.join(" ")}\n`,
      );
    } catch { /* 静默 */ }

    // 1. 读取 Claude Code 发来的权限请求
    const raw = await readStdin();
    let request: Record<string, unknown> = {};
    try {
      request = JSON.parse(raw.trim() || "{}");
    } catch {
      // stdin 为空或无效 JSON → 可能是预检调用，直接放行
      process.stdout.write(JSON.stringify({ decision: "allow" }));
      return;
    }

    // 2. 发给 Bridge HTTP 服务器（→ 飞书卡片 → 等待用户点击）
    const responseRaw = await postPermissionRequest(request);

    // 3. 解析 Bridge 返回的决策
    let response: { decision?: string } = {};
    try {
      response = JSON.parse(responseRaw);
    } catch {
      // 解析失败
    }

    // 4. 写回 stdout（Claude Code PermissionRequest hook 格式）
    const allowed = response.decision === "allowed";
    const hookOutput = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: allowed ? "allow" as const : "deny" as const,
        },
      },
    };
    process.stdout.write(JSON.stringify(hookOutput));
  } catch (err) {
    // 任何异常 → 安全回退到 deny
    console.error(
      `[PermissionBridge] 异常: ${err instanceof Error ? err.message : String(err)}`,
    );
    const hookOutput = {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "deny" as const,
        },
      },
    };
    process.stdout.write(JSON.stringify(hookOutput));
  }
}

void main();
