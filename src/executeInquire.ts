export type InquireDeps = {
  /** 调用 Claude Code CLI，传入 prompt 和超时毫秒数 */
  callClaude: (prompt: string, timeoutMs: number) => Promise<string>;
};

export type InquireResult =
  | { ok: true; summary: string }
  | { ok: false; error: string };

function buildInquirePrompt(userMessage: string): string {
  return `用户向你发送了以下消息，请直接回答或处理：

用户消息：
\`\`\`
${userMessage}
\`\`\`

请根据消息内容执行相应的操作或回答。如果涉及文件操作，请先读取相关文件。如果文件不存在或无法操作，请明确说明原因。`;
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
