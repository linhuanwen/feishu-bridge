import { describe, it, expect } from "vitest";
import { formatErrorMessage, classifyError } from "./formatErrorMessage.js";

describe("classifyError", () => {
  it("识别文件不存在错误", () => {
    expect(classifyError("ENOENT: no such file or directory")).toBe("file_not_found");
    expect(classifyError("cannot find the file")).toBe("file_not_found");
    expect(classifyError("找不到文件")).toBe("file_not_found");
  });

  it("识别权限不足错误", () => {
    expect(classifyError("EACCES: permission denied")).toBe("permission_denied");
    expect(classifyError("Access is denied")).toBe("permission_denied");
    expect(classifyError("权限不足")).toBe("permission_denied");
  });

  it("识别超时错误", () => {
    expect(classifyError("ETIMEDOUT")).toBe("timeout");
    expect(classifyError("timed out")).toBe("timeout");
    expect(classifyError("超时")).toBe("timeout");
  });

  it("未识别的错误返回 unknown", () => {
    expect(classifyError("something unexpected happened")).toBe("unknown");
  });
});

describe("formatErrorMessage", () => {
  it("文件不存在时给出路径修正建议", () => {
    const msg = formatErrorMessage({ type: "file_not_found", detail: "d:\\data\\report.pdf" });
    expect(msg).toContain("文件不存在");
    expect(msg).toContain("d:\\data\\report.pdf");
    expect(msg).toContain("路径"); // 建议确认路径
  });

  it("权限不足时给出管理员建议", () => {
    const msg = formatErrorMessage({ type: "permission_denied", detail: "C:\\Windows\\System32\\config" });
    expect(msg).toContain("权限不足");
    expect(msg).toContain("C:\\Windows\\System32\\config");
    expect(msg).toContain("管理员"); // 建议管理员身份
  });

  it("超时时给出重试建议", () => {
    const msg = formatErrorMessage({ type: "timeout", detail: "Claude Code 调用 120 秒超时" });
    expect(msg).toContain("超时");
    expect(msg).toContain("重试"); // 建议重试
  });

  it("未知错误给出通用消息", () => {
    const msg = formatErrorMessage({ type: "unknown", detail: "不明原因的崩溃" });
    expect(msg).toContain("❌");
    expect(msg).toContain("不明原因的崩溃");
  });

  it("可以直接从 Error 对象构造格式化消息", () => {
    const error = new Error("ENOENT: no such file or directory, open 'd:\\test.txt'");
    const type = classifyError(error.message);
    const msg = formatErrorMessage({ type, detail: error.message });
    expect(msg).toContain("文件不存在");
    expect(msg).toContain("d:\\test.txt");
  });

  it("所有消息以统一的前缀格式开头", () => {
    const fileMsg = formatErrorMessage({ type: "file_not_found", detail: "x" });
    const permMsg = formatErrorMessage({ type: "permission_denied", detail: "x" });
    const timeoutMsg = formatErrorMessage({ type: "timeout", detail: "x" });
    const unknownMsg = formatErrorMessage({ type: "unknown", detail: "x" });

    // 都应以 ❌ 开头
    expect(fileMsg.startsWith("❌")).toBe(true);
    expect(permMsg.startsWith("❌")).toBe(true);
    expect(timeoutMsg.startsWith("❌")).toBe(true);
    expect(unknownMsg.startsWith("❌")).toBe(true);
  });
});
