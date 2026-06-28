import { describe, it, expect } from "vitest";
import { listDirectory } from "./listDirectory.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("listDirectory", () => {
  // 在临时目录下创建测试用的文件和文件夹
  const base = join(tmpdir(), `feishu-bridge-test-${Date.now()}`);
  const dirA = join(base, "subdir");
  const file1 = join(base, "readme.txt");
  const file2 = join(base, "data.csv");

  // 在所有测试前创建
  beforeAll(() => {
    mkdirSync(base, { recursive: true });
    mkdirSync(dirA);
    writeFileSync(file1, "hello world");
    writeFileSync(file2, "a,b,c\n1,2,3");
  });

  // 在所有测试后清理
  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("有效路径返回文件条目，包含名称、人类可读大小和修改时间", async () => {
    const result = await listDirectory(base);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    const names = result.entries.map((e) => e.name).sort();
    expect(names).toEqual(["data.csv", "readme.txt", "subdir"]);

    // 验证每个条目的形状
    for (const entry of result.entries) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.size).toBe("string");
      expect(typeof entry.modifiedAt).toBe("string");
    }

    // readme.txt 的 size 应为人类可读格式（如 "11 B"）
    const readme = result.entries.find((e) => e.name === "readme.txt")!;
    expect(readme.size).toMatch(/^\d+/); // 以数字开头
  });

  it("路径不存在时返回友好错误提示", async () => {
    const result = await listDirectory("X:\\不存在的路径\\foobar");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toContain("找不到");
    expect(result.error).toContain("X:\\不存在的路径\\foobar");
  });
});
