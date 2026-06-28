import { describe, it, expect } from "vitest";
import {
  createPermissionAnalyzer,
  classifyToolOperation,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  SAFE_BASH_PATTERNS,
  DANGEROUS_BASH_PATTERNS,
  type PreAuthRecommendation,
} from "./createPermissionAnalyzer.js";
import {
  createPermissionLogger,
  type PermissionLogEntry,
} from "./createPermissionLogger.js";

describe("classifyToolOperation — 工具操作分类", () => {
  it("Read 工具始终归类为 read", () => {
    expect(classifyToolOperation("Read", "read file")).toBe("read");
  });

  it("Glob 工具始终归类为 read", () => {
    expect(classifyToolOperation("Glob", "find files")).toBe("read");
  });

  it("Grep 工具始终归类为 read", () => {
    expect(classifyToolOperation("Grep", "search code")).toBe("read");
  });

  it("WebFetch 工具归类为 read", () => {
    expect(classifyToolOperation("WebFetch", "fetch docs")).toBe("read");
  });

  it("WebSearch 工具归类为 read", () => {
    expect(classifyToolOperation("WebSearch", "search web")).toBe("read");
  });

  it("Write 工具始终归类为 write", () => {
    expect(classifyToolOperation("Write", "create file")).toBe("write");
  });

  it("Edit 工具始终归类为 write", () => {
    expect(classifyToolOperation("Edit", "modify file")).toBe("write");
  });

  // Bash 子命令分类
  it("Bash(git log) 归类为 read", () => {
    expect(classifyToolOperation("Bash", "git log --oneline")).toBe("read");
  });

  it("Bash(git diff) 归类为 read", () => {
    expect(classifyToolOperation("Bash", "git diff HEAD~1")).toBe("read");
  });

  it("Bash(git status) 归类为 read", () => {
    expect(classifyToolOperation("Bash", "git status")).toBe("read");
  });

  it("Bash(git show) 归类为 read", () => {
    expect(classifyToolOperation("Bash", "git show abc123")).toBe("read");
  });

  it("Bash(dir/ls) 归类为 read", () => {
    expect(classifyToolOperation("Bash", "dir d:\\")).toBe("read");
    expect(classifyToolOperation("Bash", "ls /home")).toBe("read");
  });

  it("Bash(type/cat/echo) 归类为 read", () => {
    expect(classifyToolOperation("Bash", "type config.json")).toBe("read");
    expect(classifyToolOperation("Bash", "cat /etc/hosts")).toBe("read");
    expect(classifyToolOperation("Bash", 'echo "hello"')).toBe("read");
  });

  it("Bash(tree) 归类为 read", () => {
    expect(classifyToolOperation("Bash", "tree src/")).toBe("read");
  });

  it("Bash(rm/del) 归类为 write", () => {
    expect(classifyToolOperation("Bash", "rm -rf temp/")).toBe("write");
    expect(classifyToolOperation("Bash", "del /f temp.txt")).toBe("write");
  });

  it("Bash(npm install) 归类为 write", () => {
    expect(classifyToolOperation("Bash", "npm install express")).toBe("write");
  });

  it("Bash(pip install) 归类为 write", () => {
    expect(classifyToolOperation("Bash", "pip install requests")).toBe("write");
  });

  it("Bash(reg) 归类为 write（注册表操作）", () => {
    expect(classifyToolOperation("Bash", "reg add HKCU\\...")).toBe("write");
  });

  it("Bash(shutdown/format) 归类为 write", () => {
    expect(classifyToolOperation("Bash", "shutdown /s")).toBe("write");
    expect(classifyToolOperation("Bash", "format C:")).toBe("write");
  });

  it("未知 Bash 命令默认归类为 write（安全优先）", () => {
    expect(classifyToolOperation("Bash", "some-unknown-tool --flag")).toBe(
      "write",
    );
  });

  it("未知工具默认归类为 unknown", () => {
    expect(classifyToolOperation("UnknownTool", "do something")).toBe(
      "unknown",
    );
  });
});

describe("createPermissionAnalyzer", () => {
  function makeEntry(
    tool: string,
    operation: string,
    target: string,
  ): Omit<PermissionLogEntry, "timestamp"> {
    return {
      tool,
      operation,
      target,
      category: classifyToolOperation(tool, operation),
    };
  }

  it("分析空日志返回零计数", () => {
    const logger = createPermissionLogger();
    const analyzer = createPermissionAnalyzer();

    const report = analyzer.analyze(logger.getAll());

    expect(report.totalRequests).toBe(0);
    expect(report.readOnlyRequests).toBe(0);
    expect(report.writeRequests).toBe(0);
    expect(report.recommendations).toHaveLength(0);
  });

  it("分析纯读日志并生成预授权建议", () => {
    const logger = createPermissionLogger();
    logger.log(makeEntry("Read", "read file", "src/main.ts"));
    logger.log(makeEntry("Read", "read file", "src/types.ts"));
    logger.log(makeEntry("Glob", "find files", "src/**/*.ts"));
    logger.log(makeEntry("Grep", "search pattern", "src/"));
    logger.log(makeEntry("Bash", "git log --oneline", "."));

    const analyzer = createPermissionAnalyzer();
    const report = analyzer.analyze(logger.getAll());

    expect(report.totalRequests).toBe(5);
    expect(report.readOnlyRequests).toBe(5);
    expect(report.writeRequests).toBe(0);

    // 所有 read 操作都应被推荐预授权
    const toolNames = report.recommendations.map((r) => r.tool);
    expect(toolNames).toContain("Read");
    expect(toolNames).toContain("Glob");
    expect(toolNames).toContain("Grep");
    expect(toolNames).toContain("Bash");
  });

  it("写操作永远不会出现在预授权建议中", () => {
    const logger = createPermissionLogger();
    logger.log(makeEntry("Read", "read file", "src/main.ts"));
    logger.log(makeEntry("Write", "create file", "output.txt"));
    logger.log(makeEntry("Edit", "modify file", "src/main.ts"));
    logger.log(makeEntry("Bash", "rm -rf temp/", "temp/"));

    const analyzer = createPermissionAnalyzer();
    const report = analyzer.analyze(logger.getAll());

    // 写操作的规则不应该被推荐
    const recommendedTools = report.recommendations.map((r) => r.tool);
    expect(recommendedTools).not.toContain("Write");
    expect(recommendedTools).not.toContain("Edit");

    // Bash 的推荐应该是针对 git 安全命令的，不应该包含 rm
    const bashRecommendations = report.recommendations.filter(
      (r) => r.tool === "Bash",
    );
    // 可能有针对 git 命令的 Bash 推荐，但不应该是针对 rm 的
    const anyRmRecommendation = report.recommendations.some(
      (r) => r.tool === "Bash" && r.rule.includes("rm"),
    );
    expect(anyRmRecommendation).toBe(false);
  });

  it("Bash 推荐按子命令细分", () => {
    const logger = createPermissionLogger();
    logger.log(makeEntry("Bash", "git log --oneline", "."));
    logger.log(makeEntry("Bash", "git log -5", "."));
    logger.log(makeEntry("Bash", "git log --graph", "."));
    logger.log(makeEntry("Bash", "git diff HEAD~1", "."));
    logger.log(makeEntry("Bash", "git status", "."));

    const analyzer = createPermissionAnalyzer();
    const report = analyzer.analyze(logger.getAll());

    // 应该有为 git 命令生成 Bash 推荐
    const bashRecs = report.recommendations.filter((r) => r.tool === "Bash");
    expect(bashRecs.length).toBeGreaterThan(0);

    // 每条推荐都应该包含 reason 和 frequency
    for (const rec of bashRecs) {
      expect(rec.reason).toBeTruthy();
      expect(rec.frequency).toBeGreaterThan(0);
    }
  });

  it("每条预授权建议都包含 rule、reason、frequency", () => {
    const logger = createPermissionLogger();
    logger.log(makeEntry("Read", "read file", "a.ts"));
    logger.log(makeEntry("Grep", "search", "src/"));

    const analyzer = createPermissionAnalyzer();
    const report = analyzer.analyze(logger.getAll());

    for (const rec of report.recommendations) {
      expect(rec.rule).toBeTruthy();
      expect(rec.reason).toBeTruthy();
      expect(typeof rec.frequency).toBe("number");
      expect(rec.frequency).toBeGreaterThan(0);
    }
  });

  it("生成摘要文本包含可读的统计信息", () => {
    const logger = createPermissionLogger();
    logger.log(makeEntry("Read", "read file", "a.ts"));
    logger.log(makeEntry("Grep", "search", "src/"));
    logger.log(makeEntry("Write", "write file", "b.ts"));

    const analyzer = createPermissionAnalyzer();
    const report = analyzer.analyze(logger.getAll());

    const summary = analyzer.formatSummary(report);
    expect(summary).toContain("3");
    expect(summary).toContain("Read");
    expect(summary).toContain("Grep");
    // 统计部分会列出所有工具使用频率（包括 Write），
    // 但「建议预授权」部分不应包含 Write
    const recSection = summary.split("建议预授权")[1] ?? "";
    expect(recSection).not.toContain("Write");
  });
});

describe("预配置常量完整性", () => {
  it("READ_ONLY_TOOLS 包含核心读工具", () => {
    expect(READ_ONLY_TOOLS).toContain("Read");
    expect(READ_ONLY_TOOLS).toContain("Glob");
    expect(READ_ONLY_TOOLS).toContain("Grep");
    expect(READ_ONLY_TOOLS).toContain("WebFetch");
    expect(READ_ONLY_TOOLS).toContain("WebSearch");
  });

  it("WRITE_TOOLS 包含核心写工具", () => {
    expect(WRITE_TOOLS).toContain("Write");
    expect(WRITE_TOOLS).toContain("Edit");
  });

  it("READ_ONLY_TOOLS 和 WRITE_TOOLS 无重叠", () => {
    const overlap = (READ_ONLY_TOOLS as readonly string[]).filter((t) =>
      (WRITE_TOOLS as readonly string[]).includes(t),
    );
    expect(overlap).toHaveLength(0);
  });

  it("SAFE_BASH_PATTERNS 包含 git 读操作", () => {
    const safePatterns = SAFE_BASH_PATTERNS.join(" ");
    expect(safePatterns).toContain("git log");
    expect(safePatterns).toContain("git diff");
    expect(safePatterns).toContain("git status");
    expect(safePatterns).toContain("git show");
  });

  it("SAFE_BASH_PATTERNS 包含文件浏览命令", () => {
    const safePatterns = SAFE_BASH_PATTERNS.join(" ");
    expect(safePatterns).toContain("dir");
    expect(safePatterns).toContain("ls");
    expect(safePatterns).toContain("type");
    expect(safePatterns).toContain("cat");
  });

  it("DANGEROUS_BASH_PATTERNS 包含破坏性命令", () => {
    const dangerousPatterns = DANGEROUS_BASH_PATTERNS.join(" ");
    expect(dangerousPatterns).toContain("rm ");
    expect(dangerousPatterns).toContain("del ");
    expect(dangerousPatterns).toContain("format ");
    expect(dangerousPatterns).toContain("shutdown");
  });
});
