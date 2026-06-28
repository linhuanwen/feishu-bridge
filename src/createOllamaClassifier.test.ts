import { describe, it, expect, vi } from "vitest";
import { createOllamaClassifier } from "./createOllamaClassifier.js";

describe("createOllamaClassifier", () => {
  it("向 Ollama /api/generate 发送请求并返回 response 字段", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ response: "simple" }),
    });

    const classifier = createOllamaClassifier({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5:7b",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const result = await classifier("hello");

    expect(result).toBe("simple");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "qwen2.5:7b",
        prompt: "hello",
        stream: false,
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it("超时后应中止请求并抛出错误", async () => {
    // 模拟一个永不 resolve 的 fetch，验证超时机制
    const fetch = vi.fn().mockImplementation(
      (_url: string, opts?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted", "AbortError"));
          });
        }),
    );

    const classifier = createOllamaClassifier({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5:7b",
      fetch: fetch as unknown as typeof globalThis.fetch,
      timeoutMs: 100,
    });

    await expect(classifier("hello")).rejects.toThrow("Ollama request timed out after 100ms");
  });

  it("当 HTTP 状态非 200 时抛出错误", async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      text: vi.fn().mockResolvedValue("model not found"),
    });

    const classifier = createOllamaClassifier({
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5:7b",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(classifier("hello")).rejects.toThrow("Ollama request failed: 500 Internal Server Error");
  });
});
