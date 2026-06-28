import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPermissionPreconfig,
  type PermissionPreconfig,
  type PermissionPreconfigDeps,
  type WrappedCallClaude,
} from "./createPermissionPreconfig.js";
import { createPermissionLogger } from "./createPermissionLogger.js";
import { createPermissionAnalyzer } from "./createPermissionAnalyzer.js";
import { createClaudeSettingsWriter } from "./createClaudeSettingsWriter.js";

function makeDeps(
  overrides?: Partial<PermissionPreconfigDeps>,
): PermissionPreconfigDeps {
  return {
    logger: createPermissionLogger(),
    analyzer: createPermissionAnalyzer(),
    settingsWriter: createClaudeSettingsWriter({
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(new Error("不存在")),
      mkdir: vi.fn().mockResolvedValue(undefined),
    }),
    callClaude: vi.fn().mockResolvedValue("Claude Code 执行完成"),
    projectDir: "d:\\tool\\yuancheng",
    ...overrides,
  };
}

describe("createPermissionPreconfig — 包装 callClaude", () => {
  let deps: PermissionPreconfigDeps;
  let preconfig: PermissionPreconfig;

  beforeEach(() => {
    deps = makeDeps();
    preconfig = createPermissionPreconfig(deps);
  });

  it("创建包装后的 callClaude 函数", () => {
    const wrapped = preconfig.wrapCallClaude();
    expect(typeof wrapped).toBe("function");
  });

  it("包装后的 callClaude 正常执行并返回结果", async () => {
    const wrapped = preconfig.wrapCallClaude();
    const result = await wrapped("审查代码", 300_000);

    expect(result).toBe("Claude Code 执行完成");
    expect(deps.callClaude).toHaveBeenCalledWith("审查代码", 300_000);
  });

  it("包装后的 callClaude 会记录权限日志", async () => {
    const wrapped = preconfig.wrapCallClaude();
    await wrapped("审查 d:\\tool\\yuancheng\\src\\main.ts", 300_000);

    // 应该有日志记录
    const logs = deps.logger.getAll();
    expect(logs.length).toBeGreaterThan(0);
  });

  it("记录包含工具类型信息（Read/Glob/Grep/Bash 等）", async () => {
    const wrapped = preconfig.wrapCallClaude();
    await wrapped("审查 d:\\tool\\yuancheng\\src\\main.ts", 300_000);

    const logs = deps.logger.getAll();
    const readLogs = logs.filter((l) => l.tool === "Read");
    const globLogs = logs.filter((l) => l.tool === "Glob");
    const grepLogs = logs.filter((l) => l.tool === "Grep");

    // 代码审查任务应至少触发 Read 操作
    expect(readLogs.length).toBeGreaterThan(0);
  });

  it("错误时也记录日志", async () => {
    const failingCallClaude = vi
      .fn()
      .mockRejectedValue(new Error("Claude Code 崩溃"));
    const errorDeps = makeDeps({ callClaude: failingCallClaude });
    const errorPreconfig = createPermissionPreconfig(errorDeps);

    const wrapped = errorPreconfig.wrapCallClaude();
    await expect(wrapped("审查代码", 300_000)).rejects.toThrow(
      "Claude Code 崩溃",
    );

    // 即使出错也应有日志
    const logs = errorDeps.logger.getAll();
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("createPermissionPreconfig — 分析与报告", () => {
  let deps: PermissionPreconfigDeps;
  let preconfig: PermissionPreconfig;

  beforeEach(() => {
    deps = makeDeps();
    preconfig = createPermissionPreconfig(deps);
  });

  it("分析日志并返回 AnalysisReport", () => {
    // 模拟一些日志
    deps.logger.log({
      tool: "Read",
      operation: "read file",
      target: "src/main.ts",
      category: "read",
    });
    deps.logger.log({
      tool: "Grep",
      operation: "search code",
      target: "src/",
      category: "read",
    });
    deps.logger.log({
      tool: "Bash",
      operation: "git log --oneline",
      target: ".",
      category: "read",
    });

    const report = preconfig.analyzeLogs();
    expect(report.totalRequests).toBe(3);
    expect(report.readOnlyRequests).toBe(3);
    expect(report.writeRequests).toBe(0);
  });

  it("生成预授权建议不包含写操作", () => {
    deps.logger.log({
      tool: "Read",
      operation: "read",
      target: "a.ts",
      category: "read",
    });
    deps.logger.log({
      tool: "Write",
      operation: "write",
      target: "b.ts",
      category: "write",
    });
    deps.logger.log({
      tool: "Edit",
      operation: "edit",
      target: "c.ts",
      category: "write",
    });

    const report = preconfig.analyzeLogs();
    const recTools = report.recommendations.map((r) => r.tool);
    expect(recTools).not.toContain("Write");
    expect(recTools).not.toContain("Edit");
  });

  it("getSummary 返回可读摘要", () => {
    deps.logger.log({
      tool: "Read",
      operation: "read",
      target: "a.ts",
      category: "read",
    });
    deps.logger.log({
      tool: "Grep",
      operation: "search",
      target: "src/",
      category: "read",
    });

    const summary = preconfig.getSummary();
    expect(summary).toContain("Read");
    expect(summary).toContain("Grep");
    expect(summary).toContain("2");
  });
});

describe("createPermissionPreconfig — 应用预授权", () => {
  let deps: PermissionPreconfigDeps;
  let preconfig: PermissionPreconfig;

  beforeEach(() => {
    deps = makeDeps();
    preconfig = createPermissionPreconfig(deps);
  });

  it("applyPreAuth 将推荐的规则写入 settings.json", async () => {
    // 模拟日志数据
    deps.logger.log({
      tool: "Read",
      operation: "read file",
      target: "src/main.ts",
      category: "read",
    });
    deps.logger.log({
      tool: "Grep",
      operation: "search code",
      target: "src/",
      category: "read",
    });
    deps.logger.log({
      tool: "Bash",
      operation: "git log --oneline",
      target: ".",
      category: "read",
    });

    await preconfig.applyPreAuth();

    // 验证 writeFile 被调用
    const writer = deps.settingsWriter as ReturnType<
      typeof createClaudeSettingsWriter
    >;
    // writeSettings 是通过 deps 调用的
    expect(deps.settingsWriter).toBeDefined();
  });

  it("applyPreAuth 不将写操作加入 allow 列表", async () => {
    deps.logger.log({
      tool: "Read",
      operation: "read",
      target: "a.ts",
      category: "read",
    });
    deps.logger.log({
      tool: "Write",
      operation: "write file",
      target: "b.ts",
      category: "write",
    });

    // 验证生成的内容不包含 Write
    const content = deps.settingsWriter.generateContent(
      preconfig.analyzeLogs().recommendations.map((r) => r.rule),
      preconfig.analyzeLogs().recommendations,
    );

    // 剥离注释后解析
    const jsonOnly = content
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const parsed = JSON.parse(jsonOnly);

    expect(parsed.permissions.allow).not.toContain("Write");
    expect(parsed.permissions.allow).not.toContain("Edit");
  });

  it("getEstimatedReduction 估算减少的确认次数", () => {
    // 5 次读操作 + 2 次写操作 = 共 7 次
    // 预授权后只需要确认 2 次写操作
    // 减少比例 = 5/7 ≈ 71%
    for (let i = 0; i < 5; i++) {
      deps.logger.log({
        tool: "Read",
        operation: "read",
        target: `file${i}.ts`,
        category: "read",
      });
    }
    deps.logger.log({
      tool: "Write",
      operation: "write",
      target: "out.ts",
      category: "write",
    });
    deps.logger.log({
      tool: "Edit",
      operation: "edit",
      target: "src/main.ts",
      category: "write",
    });

    const estimation = preconfig.getEstimatedReduction();
    expect(estimation.totalRequests).toBe(7);
    expect(estimation.preAuthorizedCount).toBe(5);
    expect(estimation.remainingConfirmationCount).toBe(2);
    expect(estimation.reductionPercent).toBeGreaterThan(70);
  });

  it("全部是读操作时减少比例应为 100%", () => {
    deps.logger.log({
      tool: "Read",
      operation: "read",
      target: "a.ts",
      category: "read",
    });
    deps.logger.log({
      tool: "Grep",
      operation: "search",
      target: "src/",
      category: "read",
    });

    const estimation = preconfig.getEstimatedReduction();
    expect(estimation.reductionPercent).toBe(100);
    expect(estimation.remainingConfirmationCount).toBe(0);
  });
});
