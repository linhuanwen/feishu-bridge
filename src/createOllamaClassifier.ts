export type OllamaClassifierOptions = {
  baseUrl: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type OllamaGenerateResponse = {
  response: string;
};

export function createOllamaClassifier(opts: OllamaClassifierOptions) {
  const fetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return async function callOllama(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const url = `${opts.baseUrl.replace(/\/$/, "")}/api/generate`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          prompt,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Ollama request failed: ${response.status} ${response.statusText} - ${body}`);
      }

      const data = (await response.json()) as OllamaGenerateResponse;
      return data.response;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}
