import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createClaudeSettingsWriter,
  DEFAULT_CLAUDE_SETTINGS_PATH,
  generateSettingsContent,
  mergeAllowRules,
  type ClaudeSettingsWriter,
  type ClaudeSettings,
} from "./createClaudeSettingsWriter.js";

describe("generateSettingsContent — 生成 settings.json 内容", () => {
  it("空规则列表生成空 allow 数组", () => {
    const content = generateSettingsContent([]);
    // 应该能解析为有效 JSON
    const parsed = JSON.parse(content);
    expect(parsed.permissions).toBeDefined();
    expect(parsed.permissions.allow).toEqual([]);
  });

  it("单条 Read 规则生成正确的 settings", () => {
    const content = generateSettingsContent(["Read"]);
    const parsed = JSON.parse(content);
    expect(parsed.permissions.allow).toContain("Read");
  });

  it("多条规则全部进入 allow 数组", () => {
    const rules = [
      "Read",
      "Glob",
      "Grep",
      "Bash(git log:*)",
      "Bash(git diff:*)",
      "Bash(git status:*)",
    ];
    const content = generateSettingsContent(rules);
    const parsed = JSON.parse(content);

    for (const rule of rules) {
      expect(parsed.permissions.allow).toContain(rule);
    }
    expect(parsed.permissions.allow).toHaveLength(rules.length);
  });

  it("生成的 JSON 包含注释说明每条规则的理由（通过 writer.generateContent）", () => {
    const writer = createClaudeSettingsWriter({
      writeFile: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockRejectedValue(new Error("不存在")),
      mkdir: vi.fn().mockResolvedValue(undefined),
    });

    const rules = [
      { rule: "Read", reason: "纯读操作，不修改文件系统" },
      { rule: "Grep", reason: "纯读操作，不修改文件系统" },
      { rule: "Bash(git log:*)", reason: "Git 只读查询，安全无害" },
    ];

    const content = writer.generateContent(
      rules.map((r) => r.rule),
      rules,
    );

    // 注释应出现在内容中（作为 // 注释行）
    for (const { reason } of rules) {
      expect(content).toContain(reason);
    }
  });

  it("deny 和 ask 数组默认初始化为空", () => {
    const content = generateSettingsContent(["Read"]);
    const parsed = JSON.parse(content);

    expect(parsed.permissions.deny).toEqual([]);
    expect(parsed.permissions.ask).toEqual([]);
  });

  it("生成的 JSON 格式良好（缩进 2 空格）", () => {
    const content = generateSettingsContent(["Read", "Glob"]);
    // 验证是有效的 JSON 且有缩进
    const parsed = JSON.parse(content);
    expect(parsed.permissions.allow).toHaveLength(2);

    // 应该有换行和缩进
    expect(content).toContain('\n  "permissions"');
    expect(content).toContain('\n    "allow"');
  });
});

describe("mergeAllowRules — 合并规则", () => {
  it("合并到空 settings 时直接设置 allow", () => {
    const existing: ClaudeSettings = {};
    const merged = mergeAllowRules(existing, ["Read", "Glob"]);

    expect(merged.permissions?.allow).toContain("Read");
    expect(merged.permissions?.allow).toContain("Glob");
    expect(merged.permissions?.allow).toHaveLength(2);
  });

  it("保留已有的 allow 规则并去重", () => {
    const existing: ClaudeSettings = {
      permissions: {
        allow: ["Read", "WebFetch"],
        deny: [],
        ask: [],
      },
    };
    const merged = mergeAllowRules(existing, ["Read", "Glob", "Grep"]);

    // 去重后：Read(skip), WebFetch(keep), Glob(new), Grep(new)
    expect(merged.permissions?.allow).toContain("Read");
    expect(merged.permissions?.allow).toContain("WebFetch");
    expect(merged.permissions?.allow).toContain("Glob");
    expect(merged.permissions?.allow).toContain("Grep");
    expect(merged.permissions?.allow).toHaveLength(4);
  });

  it("保留已有的 deny 和 ask 规则不变", () => {
    const existing: ClaudeSettings = {
      permissions: {
        allow: ["Read"],
        deny: ["Bash(rm:*)", "Bash(shutdown:*)", "Write"],
        ask: ["Bash(npm:*)"],
      },
    };
    const merged = mergeAllowRules(existing, ["Glob", "Grep"]);

    expect(merged.permissions?.deny).toEqual([
      "Bash(rm:*)",
      "Bash(shutdown:*)",
      "Write",
    ]);
    expect(merged.permissions?.ask).toEqual(["Bash(npm:*)"]);
    expect(merged.permissions?.allow).toContain("Read");
    expect(merged.permissions?.allow).toContain("Glob");
    expect(merged.permissions?.allow).toContain("Grep");
  });

  it("完整保留 permissions 之外的设置项", () => {
    const existing: ClaudeSettings = {
      theme: "dark",
      model: "claude-sonnet-4-6",
      permissions: {
        allow: [],
        deny: [],
        ask: [],
      },
    };
    const merged = mergeAllowRules(existing, ["Read"]);

    expect(merged.theme).toBe("dark");
    expect(merged.model).toBe("claude-sonnet-4-6");
    expect(merged.permissions?.allow).toContain("Read");
  });
});

describe("createClaudeSettingsWriter", () => {
  let writer: ClaudeSettingsWriter;
  let mockWriteFile: ReturnType<typeof vi.fn>;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockMkdir: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWriteFile = vi.fn().mockResolvedValue(undefined);
    mockReadFile = vi.fn().mockRejectedValue(new Error("文件不存在"));
    mockMkdir = vi.fn().mockResolvedValue(undefined);
    writer = createClaudeSettingsWriter({
      writeFile: mockWriteFile,
      readFile: mockReadFile,
      mkdir: mockMkdir,
    });
  });

  it("settings 文件不存在时创建新文件", async () => {
    await writer.writeSettings("d:\\tool\\yuancheng", ["Read", "Glob", "Grep"]);

    expect(mockReadFile).toHaveBeenCalled();
    expect(mockWriteFile).toHaveBeenCalledTimes(1);

    const [filePath, content] = mockWriteFile.mock.calls[0];
    expect(filePath).toContain(".claude");
    expect(filePath).toContain("settings.json");

    // 写入的内容包含注释（JSONC），需剥离注释后解析
    const jsonOnly = (content as string)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const parsed = JSON.parse(jsonOnly);
    expect(parsed.permissions.allow).toContain("Read");
    expect(parsed.permissions.allow).toContain("Glob");
    expect(parsed.permissions.allow).toContain("Grep");
  });

  it("合并已有的 settings 文件内容", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        theme: "dark",
        permissions: {
          allow: ["WebFetch"],
          deny: [],
          ask: [],
        },
      }),
    );

    await writer.writeSettings("d:\\tool\\yuancheng", ["Read", "Glob"]);

    const [, content] = mockWriteFile.mock.calls[0];
    // 剥离注释后解析
    const jsonOnly = (content as string)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const parsed = JSON.parse(jsonOnly);

    // 保留已有设置
    expect(parsed.theme).toBe("dark");
    // 保留已有权限
    expect(parsed.permissions.allow).toContain("WebFetch");
    // 添加新规则
    expect(parsed.permissions.allow).toContain("Read");
    expect(parsed.permissions.allow).toContain("Glob");
  });

  it("写入包含注释行说明每条规则", async () => {
    const rulesWithReasons = [
      { rule: "Read", reason: "纯读操作，不修改文件系统" },
      { rule: "Grep", reason: "纯读操作，不修改文件系统" },
    ];

    await writer.writeSettings(
      "d:\\tool\\yuancheng",
      rulesWithReasons.map((r) => r.rule),
      rulesWithReasons,
    );

    const [, content] = mockWriteFile.mock.calls[0];
    // 注释行以 // 开头
    expect(content as string).toContain("纯读操作，不修改文件系统");
  });

  it("自动创建 .claude 目录（如果不存在）", async () => {
    await writer.writeSettings("d:\\tool\\yuancheng", ["Read"]);

    expect(mockMkdir).toHaveBeenCalledTimes(1);
    const dirPath = mockMkdir.mock.calls[0][0];
    expect(dirPath).toContain(".claude");
  });

  it("生成带完整注释的配置内容", () => {
    const content = writer.generateContent(
      ["Read", "Glob", "Grep", "Bash(git log:*)", "Bash(git diff:*)"],
      [
        { rule: "Read", reason: "纯读操作" },
        { rule: "Glob", reason: "纯读操作" },
        { rule: "Grep", reason: "纯读操作" },
        { rule: "Bash(git log:*)", reason: "Git 只读查询" },
        { rule: "Bash(git diff:*)", reason: "Git 只读查询" },
      ],
    );

    // 应该有顶部说明注释
    expect(content).toContain("Feishu Bridge");
    expect(content).toContain("预授权");
    // 应该包含写入警告
    expect(content).toContain("写操作");
    expect(content).toContain("飞书确认");

    // 仍能解析为有效 JSON
    // 去掉注释行后解析
    const jsonOnly = content
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const parsed = JSON.parse(jsonOnly);
    expect(parsed.permissions.allow).toHaveLength(5);
  });

  it("确保写操作规则不会意外写入 settings", () => {
    // 即使传入包含 Write/Edit 的规则，writer 也应拒绝写入
    const content = writer.generateContent(["Read", "Write", "Edit", "Glob"]);

    // 去掉注释后解析
    const jsonOnly = content
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const parsed = JSON.parse(jsonOnly);

    // Write 和 Edit 不应该在 allow 中
    expect(parsed.permissions.allow).not.toContain("Write");
    expect(parsed.permissions.allow).not.toContain("Edit");
  });
});
