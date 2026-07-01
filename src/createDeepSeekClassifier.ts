export type DeepSeekClassifierOptions = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

type DeepSeekChatResponse = {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
};

/**
 * 创建 DeepSeek API 意图分类器。
 * 使用 OpenAI 兼容的 Chat Completions API。
 */
export function createDeepSeekClassifier(opts: DeepSeekClassifierOptions) {
  const fetch = opts.fetch ?? globalThis.fetch;
  const baseUrl = (opts.baseUrl ?? "https://api.deepseek.com").replace(/\/$/, "");
  const model = opts.model ?? "deepseek-chat";
  const timeoutMs = opts.timeoutMs ?? 15_000;

  return async function callAI(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${baseUrl}/v1/chat/completions`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "user", content: prompt },
          ],
          max_tokens: 10,
          temperature: 0,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `DeepSeek API 请求失败: ${response.status} ${response.statusText} - ${body}`,
        );
      }

      const data = (await response.json()) as DeepSeekChatResponse;
      const content = data.choices?.[0]?.message?.content ?? "";
      return content;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`DeepSeek API 请求超时 (${timeoutMs}ms)`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}
