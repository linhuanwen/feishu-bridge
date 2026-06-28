export type InquireDeps = {
  /** 调用 Claude Code CLI，传入 prompt 和超时毫秒数 */
  callClaude: (prompt: string, timeoutMs: number) => Promise<string>;
};

export type InquireResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

function buildInquirePrompt(userMessage: string): string {
  return `用户请求读取文件内容。请读取并总结以下用户消息中指定的文件。如果文件不存在或无法读取，请明确说明。如果文件格式不支持，也请说明。

用户消息：
\`\`\`
${userMessage}
\`\`\``;
}

function isTimeoutError(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("killed")
  );
}

export async function executeInquire(
  userMessage: string,
  deps: InquireDeps,
): Promise<InquireResult> {
  const prompt = buildInquirePrompt(userMessage);

  try {
    const summary = await deps.callClaude(prompt, 60_000);
    return { ok: true, summary };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof Error && isTimeoutError(err)) {
      return {
        ok: false,
        error: "查询超时（60 秒），请简化请求或检查文件大小。",
      };
    }
    return { ok: false, error: `查询失败：${message}` };
  }
}
